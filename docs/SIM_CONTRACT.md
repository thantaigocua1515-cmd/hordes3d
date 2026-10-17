# SIM contract — `shared/sim.js`

Single source of truth for ALL game rules. Must run in Node.js, Cloudflare
Workers / Durable Objects, and (in principle) any JS runtime.

## Hard constraints

- Pure ES module. **Zero Node.js dependencies**: no `require`, no `import`
  of `fs`/`ws`/`http`/`path`/`process`, no `setInterval`/`setTimeout` inside
  the sim (the host drives the tick), no `Date.now()` / `Math.random()` —
  use the injected `now()` and `rng()` only.
- May import only from `./protocol.js` and `./world.js` (relative paths).
- All game balance numbers live in `world.js`, not here.
- Deterministic given the same `(now, rng)` sequence.

## Factory

```js
import { createSim } from './shared/sim.js';
const sim = createSim({ now: () => Date.now(), rng: Math.random });
```

`now()` returns ms. `rng()` returns float in `[0, 1)`.

## Public API

| Method | Signature | Notes |
|---|---|---|
| `tick` | `(nowMs:number) => Ev[]` | Advance simulation. `dt` = clamped `(nowMs-last)/1000` to `[0, 0.25]`. Returns events drained this tick. |
| `addPlayer` | `({name, classId, faction}) => { id } \| { error }` | Validate name (1..16 chars, unique among online), classId/faction exist. Spawn at faction spawn. |
| `removePlayer` | `(id) => void` | Also cleans party membership / pending invites. |
| `setInput` | `(id, {mx, mz}) => void` | Movement vector; sim clamps length to 1. Dead players don't move. |
| `castSkill` | `(id, skillIdx, tx, tz) => { ok:true } \| { ok:false, err }` | Validate: alive, 0<=idx<4, cooldown ready, mana enough, target point within skill range (for point/melee kinds range is checked vs nearest valid target or point). Deduct mana, set cooldown, apply effect, emit `cast` event. |
| `sendChat` | `(id, channel, text) => { ok } \| { error }` | channel `'global'`/`'party'`. Trim to 140 chars. Emits chat event with routing scope. Party chat requires membership. |
| `inviteParty` | `(fromId, name) => { ok, pid } \| { error }` | Creates/updates invite `{pid, fromId, toId, partyId|null, until}` (60s expiry). If inviter has no party yet, party is created on accept. Target must be online, not in a party (or same party -> error). Emits `pinv` event scoped to invitee. |
| `acceptParty` | `(id, pid) => { ok } \| { error }` | Join inviter's party or form a new 2-person party. Party cap `WORLD.partyMax`. Emits `pjoin`. |
| `leaveParty` | `(id) => void` | Emits `pleave`; disband (emit `pdisband`) when empty or leader leaves and 1 remains? Rule: leader leaving passes leadership to oldest member; disband when 0 remain. |
| `equipItem` | `(id, uid) => { ok } \| { error }` | Item must be in player's inventory. Swaps with currently equipped item of same slot. |
| `respawn` | `(id) => { ok } \| { error }` | Only when dead. Respawn at faction spawn, full hp/mana. |
| `snapshot` | `(playerId) => { tick, you, ents, teles }` | Shapes per protocol.js. `ents` = entities within `REPLICATE_RADIUS` of the player (plus the player themself). `teles` = active telegraphs within radius. |
| `getPlayer` | `(id) => playerEnt \| null` | For host/tests. |
| `playerCount` | `() => number` | For host/tests. |

## Simulation rules

- **Entities**: `players: Map<id, P>`, `monsters: Map<id, M>`, `projectiles: []`, `telegraphs: []`, `parties: Map<pid, {id, leader, members:Set}>`, `invites: Map<pid, invite>`.
  - Player: `{ id, k:'p', name, cls, fac, x,y,z, face, hp,mhp, mana,mmana, lvl, xp, gold, fame, speed, cds:[4], buffs:[], debuffs:[], inv:[], equip:{weapon,armor,trinket}, partyId, dead, deadAt, input:{mx,mz}, targetId, lastDmgAt }`.
  - Monster: `{ id, k:'m', type, name, x,y,z, face, hp,mhp, atk,def, lvl, xp, elite, boss, spawnX,spawnZ, state:'idle'|'chase'|'return', targetId, attackAt, wanderAt, wx,wz }`.
- **Derived stats**: `mhp = base.hp*(1+LEVEL.hpMul*(lvl-1)) + equipHp`, same pattern for mana/atk/def; `speed = base.speed * buffMul`.
- **Movement**: pos += input*speed*dt; clamp to `[-size/2+2, size/2-2]`; `y = heightAt(x,z)`; face = movement dir (or toward last cast point).
- **Regen**: hp/mana regen per class; hp regen halved for 5s after taking damage.
- **Combat**: `rawDmg = atk * skillMult`; `dmg = max(1, round(rawDmg * 100/(100 + def*4)))`; crit 10% chance x1.6 (use rng). Emit `dmg` events. Death -> `die` event, XP/gold/loot distribution, respawn timer (players: manual `respawn()` or auto after `WORLD.respawnMs`).
- **Targeting / friendly fire**: damage allowed vs monsters always; vs players only if factions differ AND neither is inside their own faction safe zone (dist to own spawn < `WORLD.safeRadius`). Heals only same-faction players (or self).
- **Skill kinds** (implement each): `melee` (nearest valid enemy within range of caster, toward point), `proj` (spawn projectile toward point), `aoe_self`, `aoe_point` (telegraph with `delay`, then damage), `line` (rect), `cone`, `dash` (move caster, damage enemies along path), `blink` (teleport, clamp in-bounds), `chain` (nearest enemy in range of point, jump to nearest within 8, falloff), `heal` (nearest hurt ally in range of point incl. self), `hot` (zone healing ticks), `debuff` (damage + slow), `buff` (apply buffs `{atkMul, defAdd, speedMul, noAggro, until}`).
- **Projectiles**: `{x,z,vx,vz,life,dmg,from,kind,cls}`; move; hit first valid enemy within radius 1.2; expire on life<=0 or out of bounds.
- **Monster AI** (tick): idle -> wander near spawn; if player of any faction within `aggro` and player alive and not `noAggro` -> chase; if dist > `leashDist` from spawn -> return (heal to full on arrive); attack when within `attackRange` and `attackAt` elapsed (melee: instant dmg; ranged: spawn monster projectile). Drop target if dead/far (`aggroDropMs`).
- **Spawners**: fixed points derived from `SPAWNERS` rings (place `count` points evenly on circle radius r with slight jitter from rng at init). Each holds up to N alive; respawn one after `MONSTER.respawnMs`. Monster level scales with ring depth (1..5). `ELITE.chance` roll -> elite.
- **Boss**: spawns at `BOSS.spawn` at init; on death respawn after `BOSS.respawnMs`. Every `patternEveryMs` pick random pattern: `slam` (telegraph circle at random engaged player, damage on resolve), `ring` (telegraph ring, damage), `summon` (spawn `count` brutes). Engaged = players within aggro.
- **XP**: on monster death, `xp` split equally among killer + killer's party members within `xpShareRadius` (killer counts even if solo). `xpNext = LEVEL.xpNext(lvl)`; level-ups emit `lvl`, recalc stats, full heal on level-up.
- **Loot**: roll per `LOOT.dropChance` (elite: `eliteDropChance`; boss: `bossDropCount` items guaranteed). Quality: weighted roll over `QUALITIES`, shift +`lootBonus` index for elites, boss min `epic`. Item: `{ uid:'i'+seq, slot: random of 3, name: prefix+' '+slotName, q, atk/def/hp/mana: round(budget * base by slot * (1+lvl*0.15)) }` — weapon favors atk, armor favors def/hp, trinket favors mana/hp. Auto-loot to killer's `inv` (cap 24; if full, item is lost — note in code). Gold auto-added. Emit `loot` event scoped to killer.
- **PvP**: on player-vs-player kill: killer `fame += PVP.fameBase + victim.lvl*PVP.famePerLevel`; steal `round(victim.gold * PVP.goldSteal)` (victim keeps rest). Emit `die` with `fame` field. Killer also gets small XP (victim.lvl * 5).
- **Safe zone**: enforced in damage application (see targeting rule).
- **Telegraphs**: `{ id, x, z, r, until, dmg, from }`; rendered by client from snapshot `teles` and `tele` events; on `until <= now` apply damage to valid enemies in radius, remove.

## Events & routing

Every event object includes `scope`: `'all'`, `{ party: pid }`, or `{ player: id }`.
The host strips `scope` before sending. Chat text events: global -> `'all'`,
party -> `{party: pid}`, system (join/leave notices) -> `'all'`.

## Snapshot

Per protocol.js. `you.cds` = seconds remaining per skill. Dead players get
`you.dead=true` and `ents` still works (corpse at death spot). Cooldowns tick
in sim time.
