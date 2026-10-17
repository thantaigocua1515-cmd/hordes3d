// hordes3d — authoritative game simulation core.
// Pure ES module: ZERO Node.js dependencies. No timers, no Date.now(),
// no Math.random — the host drives tick() and injects now()/rng().
// Deterministic given the same (now, rng) sequence.
// All balance numbers come from world.js; this file only implements rules.

import { REPLICATE_RADIUS, E } from './protocol.js';
import {
  WORLD, FACTIONS, CLASSES, LEVEL, SKILLS,
  MONSTERS, ELITE, BOSS, SPAWNERS, MONSTER,
  QUALITIES, LOOT, PVP, heightAt,
} from './world.js';

// ---------------------------------------------------------------- helpers
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const d2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const angDiff = (a, b) => {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};
const BOUND = WORLD.size / 2 - 2;   // playable clamp (not a balance number)
const INV_CAP = 24;                 // inventory cap; overflow loot is lost
const MONSTER_CAP = 150;            // safety cap so boss summons can't grow unbounded
const INVITE_MS = 60 * 1000;
const CHAIN_JUMP_RANGE = 8;         // per SIM_CONTRACT.md
const CRIT_CHANCE = 0.10, CRIT_MUL = 1.6;

// damage formula per contract
const calcDmg = (raw, def) => Math.max(1, Math.round((raw * 100) / (100 + def * 4)));

export function createSim({ now, rng }) {
  if (typeof now !== 'function' || typeof rng !== 'function') {
    throw new Error('createSim requires {now, rng}');
  }

  const S = {
    players: new Map(), monsters: new Map(),
    projectiles: [], telegraphs: [], zones: [],
    parties: new Map(), invites: new Map(), spawners: [],
    bossId: null, bossDeadAt: 0,
    events: [], tickN: 0, lastTick: -1, nowMs: 0,
    seq: { p: 0, m: 0, t: 0, i: 0, pt: 0, inv: 0 },
  };

  const emit = (ev) => { S.events.push(ev); };
  const tnow = () => S.nowMs || now();

  // ------------------------------------------------------------ derived stats
  function buffSums(p, nowMs) {
    let atkMul = 1, defAdd = 0, speedMul = 1, noAggro = false, slow = 1;
    for (const b of p.buffs) {
      if (b.until <= nowMs) continue;
      if (b.atkMul) atkMul *= b.atkMul;
      if (b.defAdd) defAdd += b.defAdd;
      if (b.speedMul) speedMul *= b.speedMul;
      if (b.noAggro) noAggro = true;
    }
    for (const d of p.debuffs) {
      if (d.until <= nowMs) continue;
      if (d.slow && d.slow < slow) slow = d.slow;
    }
    return { atkMul, defAdd, speedMul: speedMul * slow, noAggro };
  }
  function equipBonus(p) {
    const b = { atk: 0, def: 0, hp: 0, mana: 0 };
    for (const s of ['weapon', 'armor', 'trinket']) {
      const it = p.equip[s];
      if (it) { b.atk += it.atk; b.def += it.def; b.hp += it.hp; b.mana += it.mana; }
    }
    return b;
  }
  // mhp = base.hp*(1+hpMul*(lvl-1)) + equipHp, same pattern for mana/atk/def
  function statsOf(p, nowMs) {
    const base = CLASSES[p.cls];
    const g = p.lvl - 1;
    const eq = equipBonus(p);
    const bf = buffSums(p, nowMs);
    return {
      mhp: Math.round(base.hp * (1 + LEVEL.hpMul * g) + eq.hp),
      mmana: Math.round(base.mana * (1 + LEVEL.manaMul * g) + eq.mana),
      atk: (base.atk * (1 + LEVEL.atkMul * g) + eq.atk) * bf.atkMul,
      def: base.def * (1 + LEVEL.defMul * g) + eq.def + bf.defAdd,
      speed: base.speed * bf.speedMul,
      noAggro: bf.noAggro,
    };
  }

  // ------------------------------------------------------------ targeting
  const inSafe = (p) => {
    const s = FACTIONS[p.fac].spawn;
    return d2(p.x, p.z, s.x, s.z) < WORLD.safeRadius;
  };
  // Damageable enemies of a player: monsters always; players only if factions
  // differ AND neither stands inside their own faction safe zone.
  function enemiesOfPlayer(p) {
    const out = [];
    for (const m of S.monsters.values()) out.push(m);
    for (const q of S.players.values()) {
      if (q.id === p.id || q.dead || q.fac === p.fac) continue;
      if (inSafe(p) || inSafe(q)) continue;
      out.push(q);
    }
    return out;
  }
  function enemiesOfPlayerId(pid) {
    const p = S.players.get(pid);
    return p ? enemiesOfPlayer(p) : [];
  }
  const hasNoAggro = (p, nowMs) => statsOf(p, nowMs).noAggro;

  // ------------------------------------------------------------ combat core
  function damageEntity(t, raw, src, nowMs) {
    if (!t || t.hp <= 0) return;
    if (t.k === 'p' && t.dead) return;
    // PvP gate (also enforced at targeting time; double-checked here)
    if (t.k === 'p' && src.kind === 'p') {
      const a = S.players.get(src.id);
      if (!a || a.fac === t.fac) return;
      if (inSafe(a) || inSafe(t)) return;
    }
    const def = t.k === 'p' ? statsOf(t, nowMs).def : t.def;
    let amt = calcDmg(raw, def);
    const crit = rng() < CRIT_CHANCE;
    if (crit) amt = Math.round(amt * CRIT_MUL);
    t.hp -= amt;
    if (t.k === 'p') t.lastDmgAt = nowMs;
    emit({ e: E.DMG, to: t.id, amt, crit, src: src.id, scope: 'all' });
    if (t.hp <= 0) { t.hp = 0; killEntity(t, src, nowMs); }
  }
  function healEntity(t, amt, srcId, nowMs) {
    if (!t || t.dead || t.hp <= 0) return;
    const st = statsOf(t, nowMs);
    t.hp = Math.min(st.mhp, t.hp + amt);
    emit({ e: E.HEAL, to: t.id, amt, src: srcId, scope: 'all' });
  }

  function killEntity(t, src, nowMs) {
    if (t.k === 'm') {
      S.monsters.delete(t.id);
      if (t.spawner) { t.spawner.monsterId = null; t.spawner.deadAt = nowMs; }
      if (t.boss) { S.bossId = null; S.bossDeadAt = nowMs; }
      const killer = src.kind === 'p' ? S.players.get(src.id) : null;
      emit({ e: E.DIE, id: t.id, by: src.id, pname: src.name, fame: 0, scope: 'all' });
      if (killer && !killer.dead) awardMonsterKill(killer, t);
    } else {
      t.dead = true; t.deadAt = nowMs;
      t.input.mx = 0; t.input.mz = 0;
      t.buffs = []; t.debuffs = []; t.castFx = null;
      for (const m of S.monsters.values()) {
        if (m.targetId === t.id) { m.targetId = null; m.state = 'idle'; }
      }
      let fame = 0;
      if (src.kind === 'p' && src.id !== t.id) {
        const killer = S.players.get(src.id);
        if (killer && !killer.dead) {
          fame = PVP.fameBase + t.lvl * PVP.famePerLevel;
          killer.fame += fame;
          const steal = Math.round(t.gold * PVP.goldSteal);
          t.gold -= steal; killer.gold += steal;
          gainXp(killer, t.lvl * 5, nowMs); // small XP for PvP kill
        }
      }
      emit({ e: E.DIE, id: t.id, by: src.id, pname: src.name, fame, scope: 'all' });
    }
  }

  function gainXp(p, amt, nowMs) {
    if (amt <= 0) return;
    p.xp += amt;
    let leveled = false;
    while (p.lvl < LEVEL.max && p.xp >= LEVEL.xpNext(p.lvl)) {
      p.xp -= LEVEL.xpNext(p.lvl);
      p.lvl++;
      leveled = true;
    }
    if (leveled) {
      const st = statsOf(p, nowMs);
      p.hp = st.mhp; p.mana = st.mmana; // full heal on level-up
      emit({ e: E.LVL, id: p.id, lvl: p.lvl, pname: p.name, scope: 'all' });
    }
  }

  // ------------------------------------------------------------ loot
  function rollQualityIdx(shift) {
    let total = 0;
    for (const q of QUALITIES) total += q.weight;
    let r = rng() * total, idx = 0;
    for (let i = 0; i < QUALITIES.length; i++) {
      r -= QUALITIES[i].weight;
      if (r < 0) { idx = i; break; }
    }
    return Math.min(QUALITIES.length - 1, idx + shift);
  }
  const SLOT_BASE = {
    weapon: { atk: 6, def: 1, hp: 6, mana: 3 },    // favors atk
    armor: { atk: 1, def: 5, hp: 16, mana: 4 },    // favors def/hp
    trinket: { atk: 2, def: 2, hp: 10, mana: 12 }, // favors mana/hp
  };
  function makeItem(q, lvl) {
    const slots = ['weapon', 'armor', 'trinket'];
    const slot = slots[(rng() * 3) | 0];
    const prefix = LOOT.prefixes[(rng() * LOOT.prefixes.length) | 0];
    const budget = QUALITIES[q].budget;
    const mult = budget * (1 + lvl * 0.15);
    const base = SLOT_BASE[slot];
    return {
      uid: 'i' + (++S.seq.i), slot,
      name: prefix + ' ' + LOOT.slotNames[slot], q,
      atk: Math.round(base.atk * mult), def: Math.round(base.def * mult),
      hp: Math.round(base.hp * mult), mana: Math.round(base.mana * mult),
    };
  }
  function giveItem(p, it) {
    if (p.inv.length >= INV_CAP) return false; // full: item is lost
    p.inv.push(it);
    return true;
  }
  function awardMonsterKill(killer, m) {
    const nowMs = tnow();
    // XP: split equally among killer + killer's party members in xpShareRadius
    const xp = Math.round(m.xp * (m.elite ? ELITE.xpMul : 1));
    const party = killer.partyId ? S.parties.get(killer.partyId) : null;
    const eligible = [killer];
    if (party) {
      for (const mid of party.members) {
        if (mid === killer.id) continue;
        const mem = S.players.get(mid);
        if (mem && !mem.dead && d2(mem.x, mem.z, m.x, m.z) <= WORLD.xpShareRadius) {
          eligible.push(mem);
        }
      }
    }
    const share = Math.floor(xp / eligible.length);
    for (const mem of eligible) gainXp(mem, share, nowMs);
    const rest = xp - share * eligible.length;
    if (rest > 0) gainXp(killer, rest, nowMs);
    // gold (auto-added)
    let gold = Math.round(m.gold[0] + rng() * (m.gold[1] - m.gold[0]));
    if (m.elite) gold = Math.round(gold * ELITE.goldMul);
    killer.gold += gold;
    // item rolls: normal chance, elite high chance, boss guaranteed count
    const items = [];
    if (m.boss) {
      for (let i = 0; i < LOOT.bossDropCount; i++) {
        items.push(makeItem(Math.max(3, rollQualityIdx(0)), m.lvl)); // boss min epic
      }
    } else {
      const chance = m.elite ? LOOT.eliteDropChance : LOOT.dropChance;
      if (rng() < chance) {
        items.push(makeItem(rollQualityIdx(m.elite ? ELITE.lootBonus : 0), m.lvl));
      }
    }
    if (items.length === 0) {
      emit({ e: E.LOOT, item: null, gold, scope: { player: killer.id } });
    } else {
      items.forEach((it, i) => {
        if (giveItem(killer, it)) {
          emit({ e: E.LOOT, item: it, gold: i === 0 ? gold : 0, scope: { player: killer.id } });
        }
      });
    }
  }

  // ------------------------------------------------------------ spawning
  function spawnMonster(typeKey, x, z, lvl, elite, spawner) {
    const base = MONSTERS[typeKey];
    const id = 'm' + (++S.seq.m);
    const m = {
      id, k: 'm', type: typeKey, name: base.name,
      x, z, y: heightAt(x, z), face: 0,
      hp: 0, mhp: 0, atk: base.atk, def: base.def, lvl,
      xp: base.xp, gold: base.gold, elite, boss: false,
      speed: base.speed, aggro: base.aggro, attackRange: base.attackRange,
      attackCd: base.attackCd, ranged: base.ranged,
      spawnX: x, spawnZ: z, spawner,
      state: 'idle', targetId: null, attackAt: 0, lastSeen: 0,
      wanderAt: 0, wx: x, wz: z,
    };
    if (elite) {
      m.mhp = Math.round(base.hp * ELITE.hpMul);
      m.atk = Math.round(base.atk * ELITE.atkMul);
      m.name = 'Elite ' + base.name;
    } else {
      m.mhp = base.hp;
    }
    m.hp = m.mhp;
    S.monsters.set(id, m);
    if (spawner) spawner.monsterId = id;
    return m;
  }
  function spawnBoss(nowMs) {
    const id = 'm' + (++S.seq.m);
    const m = {
      id, k: 'm', type: 'boss', name: BOSS.name,
      x: BOSS.spawn.x, z: BOSS.spawn.z, y: heightAt(BOSS.spawn.x, BOSS.spawn.z), face: 0,
      hp: BOSS.hp, mhp: BOSS.hp, atk: BOSS.atk, def: BOSS.def, lvl: 10,
      xp: BOSS.xp, gold: BOSS.gold, elite: false, boss: true,
      speed: BOSS.speed, aggro: BOSS.aggro, attackRange: BOSS.attackRange,
      attackCd: BOSS.attackCd, ranged: false,
      spawnX: BOSS.spawn.x, spawnZ: BOSS.spawn.z, spawner: null,
      state: 'idle', targetId: null, attackAt: 0, lastSeen: 0,
      wanderAt: 0, wx: BOSS.spawn.x, wz: BOSS.spawn.z,
      patternAt: nowMs + BOSS.patternEveryMs,
    };
    S.monsters.set(id, m);
    S.bossId = id;
    return m;
  }
  function initSpawners() {
    SPAWNERS.forEach((sp, ri) => {
      for (let j = 0; j < sp.count; j++) {
        const a = (j / sp.count) * Math.PI * 2 + rng() * 0.3;
        const rr = sp.r + (rng() * 6 - 3);
        const x = clamp(Math.cos(a) * rr, -BOUND, BOUND);
        const z = clamp(Math.sin(a) * rr, -BOUND, BOUND);
        const s = { x, z, types: sp.types, ring: ri + 1, monsterId: null, deadAt: 0 };
        S.spawners.push(s);
        const type = sp.types[(rng() * sp.types.length) | 0];
        spawnMonster(type, x, z, ri + 1, rng() < ELITE.chance, s); // lvl = ring depth 1..5
      }
    });
  }

  // ------------------------------------------------------------ skills
  function applySkill(p, sk, skillIdx, tx, tz, st, nowMs) {
    const src = { id: p.id, name: p.name, kind: 'p' };
    switch (sk.kind) {
      case 'melee': { // nearest valid enemy within range of caster, toward point
        const cands = enemiesOfPlayer(p)
          .filter((e) => d2(p.x, p.z, e.x, e.z) <= sk.range)
          .sort((a, b) => d2(a.x, a.z, tx, tz) - d2(b.x, b.z, tx, tz));
        if (cands.length) damageEntity(cands[0], st.atk * sk.dmg, src, nowMs);
        break;
      }
      case 'proj': { // projectile toward point
        const d = Math.max(0.001, d2(p.x, p.z, tx, tz));
        S.projectiles.push({
          x: p.x, z: p.z,
          vx: ((tx - p.x) / d) * sk.projSpeed, vz: ((tz - p.z) / d) * sk.projSpeed,
          life: sk.range / sk.projSpeed + 0.1,
          atk: st.atk, mult: sk.dmg, from: p.id, fromName: p.name, kind: 'p',
        });
        break;
      }
      case 'aoe_self': { // damage all enemies around caster
        for (const e of enemiesOfPlayer(p)) {
          if (d2(p.x, p.z, e.x, e.z) <= sk.radius) {
            damageEntity(e, st.atk * sk.dmg, src, nowMs);
            if (sk.slow && e.k === 'p' && e.hp > 0) {
              e.debuffs.push({ slow: sk.slow, until: nowMs + sk.slowDur * 1000 });
            }
          }
        }
        break;
      }
      case 'aoe_point': { // telegraph at point, damage on resolve
        const id = 't' + (++S.seq.t);
        S.telegraphs.push({
          id, x: tx, z: tz, r: sk.radius, until: nowMs + sk.delay * 1000,
          atk: st.atk, mult: sk.dmg, from: p.id, fromName: p.name, kind: 'p',
        });
        emit({ e: E.TELE, id, x: tx, z: tz, r: sk.radius, durMs: sk.delay * 1000, kind: 'aoe', scope: 'all' });
        break;
      }
      case 'line': { // rectangle from caster toward point
        const dx = tx - p.x, dz = tz - p.z;
        const len = Math.max(0.001, Math.hypot(dx, dz));
        const ux = dx / len, uz = dz / len, L = Math.min(len, sk.range), hw = sk.width / 2;
        for (const e of enemiesOfPlayer(p)) {
          const rx = e.x - p.x, rz = e.z - p.z;
          const t = clamp(rx * ux + rz * uz, 0, L);
          const perp = Math.hypot(rx - ux * t, rz - uz * t);
          if (perp <= hw + 0.6) damageEntity(e, st.atk * sk.dmg, src, nowMs);
        }
        break;
      }
      case 'cone': { // cone from caster toward point
        const aim = Math.atan2(tx - p.x, tz - p.z);
        for (const e of enemiesOfPlayer(p)) {
          if (d2(p.x, p.z, e.x, e.z) > sk.range) continue;
          const da = Math.abs(angDiff(Math.atan2(e.x - p.x, e.z - p.z), aim));
          if (da <= sk.angle / 2 + 0.1) damageEntity(e, st.atk * sk.dmg, src, nowMs);
        }
        break;
      }
      case 'dash': { // move caster, damage enemies along path
        const x0 = p.x, z0 = p.z;
        const d = Math.max(0.001, d2(x0, z0, tx, tz));
        const dd = Math.min(sk.dashDist, d);
        p.x = clamp(x0 + ((tx - x0) / d) * dd, -BOUND, BOUND);
        p.z = clamp(z0 + ((tz - z0) / d) * dd, -BOUND, BOUND);
        p.y = heightAt(p.x, p.z);
        const sx = p.x - x0, sz = p.z - z0;
        const segLen2 = sx * sx + sz * sz;
        for (const e of enemiesOfPlayer(p)) {
          let pd;
          if (segLen2 < 1e-6) pd = d2(e.x, e.z, x0, z0);
          else {
            const t = clamp(((e.x - x0) * sx + (e.z - z0) * sz) / segLen2, 0, 1);
            pd = d2(e.x, e.z, x0 + sx * t, z0 + sz * t);
          }
          if (pd <= sk.radius) damageEntity(e, st.atk * sk.dmg, src, nowMs);
        }
        break;
      }
      case 'blink': { // teleport, clamped in-bounds
        p.x = clamp(tx, -BOUND, BOUND);
        p.z = clamp(tz, -BOUND, BOUND);
        p.y = heightAt(p.x, p.z);
        break;
      }
      case 'chain': { // nearest enemy in range, jumps with falloff
        const hit = new Set();
        let cands = enemiesOfPlayer(p)
          .filter((e) => d2(p.x, p.z, e.x, e.z) <= sk.range)
          .sort((a, b) => d2(a.x, a.z, tx, tz) - d2(b.x, b.z, tx, tz));
        if (!cands.length) break;
        let cur = cands[0], mult = sk.dmg;
        for (let j = 0; j <= sk.jumps; j++) {
          damageEntity(cur, st.atk * mult, src, nowMs);
          hit.add(cur.id);
          mult *= sk.jumpFalloff;
          let best = null, bd = CHAIN_JUMP_RANGE;
          for (const e of enemiesOfPlayer(p)) {
            if (hit.has(e.id)) continue;
            const dd = d2(cur.x, cur.z, e.x, e.z);
            if (dd < bd) { bd = dd; best = e; }
          }
          if (!best) break;
          cur = best;
        }
        break;
      }
      case 'heal': { // nearest hurt ally in range of caster (incl. self)
        const allies = [];
        for (const q of S.players.values()) {
          if (q.dead || q.fac !== p.fac) continue;
          if (d2(p.x, p.z, q.x, q.z) > sk.range) continue;
          if (q.hp < statsOf(q, nowMs).mhp) allies.push(q);
        }
        allies.sort((a, b) => d2(a.x, a.z, tx, tz) - d2(b.x, b.z, tx, tz));
        if (allies.length) healEntity(allies[0], Math.round(st.atk * sk.heal), p.id, nowMs);
        break;
      }
      case 'hot': { // zone that heals allies on ticks
        const id = 't' + (++S.seq.t);
        S.zones.push({
          id, x: tx, z: tz, r: sk.radius, until: nowMs + sk.dur * 1000,
          nextTick: nowMs + sk.tickEvery * 1000, tickEveryMs: sk.tickEvery * 1000,
          healMult: sk.tickHeal, atk: st.atk, from: p.id, fac: p.fac,
        });
        emit({ e: E.TELE, id, x: tx, z: tz, r: sk.radius, durMs: sk.dur * 1000, kind: 'hot', scope: 'all' });
        break;
      }
      case 'debuff': { // damage + slow, single target near point
        const cands = enemiesOfPlayer(p)
          .filter((e) => d2(e.x, e.z, tx, tz) <= 4 && d2(p.x, p.z, e.x, e.z) <= sk.range)
          .sort((a, b) => d2(a.x, a.z, tx, tz) - d2(b.x, b.z, tx, tz));
        if (cands.length) {
          damageEntity(cands[0], st.atk * sk.dmg, src, nowMs);
          if (cands[0].k === 'p' && cands[0].hp > 0) {
            cands[0].debuffs.push({ slow: sk.slow, until: nowMs + sk.dur * 1000 });
          }
        }
        break;
      }
      case 'buff': { // self buff
        p.buffs.push({
          atkMul: sk.atkMul, defAdd: sk.defAdd, speedMul: sk.speedMul,
          noAggro: sk.noAggro, until: nowMs + sk.dur * 1000,
        });
        break;
      }
      default:
        break; // unknown kind: ignore (never throw on data)
    }
  }

  // ------------------------------------------------------------ monster AI
  function moveToward(m, x, z, step) {
    const d = d2(m.x, m.z, x, z);
    if (d <= Math.max(step, 0.6)) {
      m.x = x; m.z = z; m.y = heightAt(x, z);
      return true;
    }
    m.x += ((x - m.x) / d) * step;
    m.z += ((z - m.z) / d) * step;
    m.face = Math.atan2(x - m.x, z - m.z);
    m.y = heightAt(m.x, m.z);
    return false;
  }
  function bossPattern(m, nowMs) {
    const pat = BOSS.patterns[(rng() * BOSS.patterns.length) | 0];
    if (pat.kind === 'summon') {
      for (let i = 0; i < pat.count; i++) {
        if (S.monsters.size >= MONSTER_CAP) break;
        const a = rng() * Math.PI * 2;
        spawnMonster('brute',
          clamp(m.x + Math.cos(a) * 5, -BOUND, BOUND),
          clamp(m.z + Math.sin(a) * 5, -BOUND, BOUND),
          5, false, null);
      }
      return;
    }
    let px = m.x, pz = m.z;
    if (pat.kind === 'slam') {
      const eng = [];
      for (const q of S.players.values()) {
        if (!q.dead && d2(q.x, q.z, m.x, m.z) <= BOSS.aggro) eng.push(q);
      }
      if (!eng.length) return;
      const v = eng[(rng() * eng.length) | 0];
      px = v.x; pz = v.z;
    }
    const id = 't' + (++S.seq.t);
    S.telegraphs.push({
      id, x: px, z: pz, r: pat.radius, until: nowMs + pat.telegraphMs,
      atk: m.atk, mult: pat.dmgMul, from: m.id, fromName: m.name, kind: 'm',
    });
    emit({ e: E.TELE, id, x: px, z: pz, r: pat.radius, durMs: pat.telegraphMs, kind: pat.kind, scope: 'all' });
  }
  function monsterTick(m, dt, nowMs) {
    let tgt = m.targetId ? S.players.get(m.targetId) : null;
    if (tgt && (tgt.dead || hasNoAggro(tgt, nowMs))) tgt = null;
    if (tgt) {
      if (d2(m.x, m.z, tgt.x, tgt.z) <= m.aggro) m.lastSeen = nowMs;
      if (nowMs - m.lastSeen > MONSTER.aggroDropMs) tgt = null;
    }
    if (!tgt) {
      m.targetId = null;
      let best = null, bd = Infinity;
      for (const q of S.players.values()) {
        if (q.dead || hasNoAggro(q, nowMs)) continue;
        const d = d2(m.x, m.z, q.x, q.z);
        if (d <= m.aggro && d < bd) { bd = d; best = q; }
      }
      if (best) { tgt = best; m.targetId = best.id; m.lastSeen = nowMs; }
    }
    if (d2(m.x, m.z, m.spawnX, m.spawnZ) > MONSTER.leashDist) m.state = 'return';
    else if (tgt) m.state = 'chase';
    else if (m.state === 'chase') m.state = 'idle';

    if (m.state === 'chase' && tgt) {
      const d = d2(m.x, m.z, tgt.x, tgt.z);
      if (d <= m.attackRange) {
        m.face = Math.atan2(tgt.x - m.x, tgt.z - m.z);
        if (nowMs >= m.attackAt) {
          m.attackAt = nowMs + m.attackCd * 1000;
          if (m.ranged) {
            const dd = Math.max(0.001, d), sp = 18;
            S.projectiles.push({
              x: m.x, z: m.z,
              vx: ((tgt.x - m.x) / dd) * sp, vz: ((tgt.z - m.z) / dd) * sp,
              life: m.attackRange / sp + 0.6,
              atk: m.atk, from: m.id, fromName: m.name, kind: 'm',
            });
          } else {
            damageEntity(tgt, m.atk, { id: m.id, name: m.name, kind: 'm' }, nowMs);
          }
        }
      } else {
        moveToward(m, tgt.x, tgt.z, m.speed * dt);
      }
    } else if (m.state === 'return') {
      if (moveToward(m, m.spawnX, m.spawnZ, m.speed * dt)) {
        m.hp = m.mhp; m.state = 'idle'; m.targetId = null; // heal to full on arrive
      }
    } else {
      if (nowMs >= m.wanderAt) {
        m.wanderAt = nowMs + 2000 + rng() * 3000;
        const a = rng() * Math.PI * 2, r = rng() * MONSTER.wanderRadius;
        m.wx = m.spawnX + Math.cos(a) * r;
        m.wz = m.spawnZ + Math.sin(a) * r;
      }
      moveToward(m, m.wx, m.wz, m.speed * 0.5 * dt);
    }
    if (m.boss) {
      if (nowMs >= m.patternAt) {
        m.patternAt = nowMs + BOSS.patternEveryMs;
        if (m.targetId) bossPattern(m, nowMs);
      }
    }
  }

  // ------------------------------------------------------------ respawn
  function doRespawn(p, nowMs) {
    const s = FACTIONS[p.fac].spawn;
    p.x = s.x; p.z = s.z; p.y = heightAt(s.x, s.z);
    p.buffs = []; p.debuffs = []; p.cds = [0, 0, 0, 0];
    p.input.mx = 0; p.input.mz = 0; p.castFx = null;
    const st = statsOf(p, nowMs);
    p.hp = st.mhp; p.mana = st.mmana;
    p.dead = false; p.deadAt = 0;
    emit({ e: E.RESPAWN, id: p.id, scope: 'all' });
  }

  // ------------------------------------------------------------ public API
  function addPlayer(data) {
    if (!data || typeof data !== 'object') return { error: 'bad args' };
    let { name, classId, faction } = data;
    if (typeof name !== 'string') return { error: 'bad name' };
    name = name.trim();
    if (name.length < 1 || name.length > WORLD.nameMax) return { error: 'bad name' };
    if (!CLASSES[classId]) return { error: 'bad class' };
    if (!FACTIONS[faction]) return { error: 'bad faction' };
    for (const q of S.players.values()) if (q.name === name) return { error: 'name taken' };
    const id = 'p' + (++S.seq.p);
    const s = FACTIONS[faction].spawn;
    const p = {
      id, k: 'p', name, cls: classId, fac: faction,
      x: s.x, z: s.z, y: heightAt(s.x, s.z), face: 0,
      hp: 0, mana: 0, lvl: 1, xp: 0, gold: 0, fame: 0,
      cds: [0, 0, 0, 0], buffs: [], debuffs: [],
      inv: [], equip: { weapon: null, armor: null, trinket: null },
      partyId: null, dead: false, deadAt: 0,
      input: { mx: 0, mz: 0 }, targetId: null, lastDmgAt: 0, castFx: null,
    };
    const st = statsOf(p, now());
    p.hp = st.mhp; p.mana = st.mmana;
    S.players.set(id, p);
    return { id };
  }

  function removePlayer(id) {
    const p = S.players.get(id);
    if (!p) return;
    leaveParty(id);
    for (const [k, v] of S.invites) {
      if (v.fromId === id || v.toId === id) S.invites.delete(k);
    }
    S.players.delete(id);
  }

  function setInput(id, mv) {
    const p = S.players.get(id);
    if (!p || !mv || typeof mv !== 'object') return;
    let { mx, mz } = mv;
    if (typeof mx !== 'number' || !isFinite(mx)) mx = 0;
    if (typeof mz !== 'number' || !isFinite(mz)) mz = 0;
    const l = Math.hypot(mx, mz);
    if (l > 1) { mx /= l; mz /= l; } // clamp length to 1
    if (p.dead) { p.input.mx = 0; p.input.mz = 0; return; }
    p.input.mx = mx; p.input.mz = mz;
  }

  function castSkill(id, skillIdx, tx, tz) {
    const nowMs = now();
    const p = S.players.get(id);
    if (!p) return { ok: false, err: 'no player' };
    if (p.dead) return { ok: false, err: 'dead' };
    if (!Number.isInteger(skillIdx) || skillIdx < 0 || skillIdx > 3) {
      return { ok: false, err: 'bad skill' };
    }
    const sk = SKILLS[p.cls][skillIdx];
    if (!sk) return { ok: false, err: 'bad skill' };
    if (p.cds[skillIdx] > 0) return { ok: false, err: 'cooldown' };
    if (typeof tx !== 'number' || typeof tz !== 'number' || !isFinite(tx) || !isFinite(tz)) {
      return { ok: false, err: 'bad target' };
    }
    const cx = clamp(tx, -WORLD.size / 2, WORLD.size / 2);
    const cz = clamp(tz, -WORLD.size / 2, WORLD.size / 2);
    const st = statsOf(p, nowMs);
    if (p.mana < sk.mana) return { ok: false, err: 'mana' };
    if (sk.range > 0) {
      // range checked vs point; for melee/debuff/heal also vs nearest valid target
      let okRange = d2(p.x, p.z, cx, cz) <= sk.range + 1e-6;
      if (!okRange && (sk.kind === 'melee' || sk.kind === 'debuff')) {
        okRange = enemiesOfPlayer(p).some((e) => d2(p.x, p.z, e.x, e.z) <= sk.range);
      }
      if (!okRange && sk.kind === 'heal') {
        for (const q of S.players.values()) {
          if (!q.dead && q.fac === p.fac && d2(p.x, p.z, q.x, q.z) <= sk.range) { okRange = true; break; }
        }
      }
      if (!okRange) return { ok: false, err: 'range' };
    }
    p.mana -= sk.mana;
    p.cds[skillIdx] = sk.cd;
    p.face = Math.atan2(cx - p.x, cz - p.z);
    p.castFx = { skill: skillIdx, until: nowMs + 400 };
    emit({ e: E.CAST, id: p.id, skill: skillIdx, tx: cx, tz: cz, cls: p.cls, scope: 'all' });
    applySkill(p, sk, skillIdx, cx, cz, st, nowMs);
    return { ok: true };
  }

  function sendChat(id, channel, text) {
    const p = S.players.get(id);
    if (!p) return { error: 'no player' };
    if (channel !== 'global' && channel !== 'party') return { error: 'bad channel' };
    if (typeof text !== 'string') return { error: 'bad text' };
    const t = text.slice(0, 140);
    if (!t.trim()) return { error: 'empty' };
    if (channel === 'party') {
      if (!p.partyId || !S.parties.has(p.partyId)) return { error: 'no party' };
      emit({ e: E.CHAT, from: p.name, ch: 'party', text: t, scope: { party: p.partyId } });
    } else {
      emit({ e: E.CHAT, from: p.name, ch: 'global', text: t, scope: 'all' });
    }
    return { ok: true };
  }

  function inviteParty(fromId, name) {
    const from = S.players.get(fromId);
    if (!from) return { error: 'no player' };
    if (typeof name !== 'string' || !name.trim()) return { error: 'bad name' };
    const to = [...S.players.values()].find((q) => q.name === name.trim());
    if (!to) return { error: 'not online' };
    if (to.id === fromId) return { error: 'self' };
    const fp = from.partyId ? S.parties.get(from.partyId) : null;
    if (fp) {
      if (to.partyId === fp.id) return { error: 'same party' };
      if (to.partyId) return { error: 'in party' };
      if (fp.members.size >= WORLD.partyMax) return { error: 'party full' };
    } else if (to.partyId) {
      return { error: 'in party' };
    }
    const until = now() + INVITE_MS;
    for (const inv of S.invites.values()) {
      if (inv.fromId === fromId && inv.toId === to.id) {
        inv.until = until; inv.partyId = fp ? fp.id : null; // update existing
        emit({ e: E.PINV, pid: inv.pid, from: fromId, fromName: from.name, scope: { player: to.id } });
        return { ok: true, pid: inv.pid };
      }
    }
    const pid = 'inv' + (++S.seq.inv);
    S.invites.set(pid, { pid, fromId, toId: to.id, partyId: fp ? fp.id : null, until });
    emit({ e: E.PINV, pid, from: fromId, fromName: from.name, scope: { player: to.id } });
    return { ok: true, pid };
  }

  function acceptParty(id, pid) {
    const p = S.players.get(id);
    if (!p) return { error: 'no player' };
    const inv = S.invites.get(pid);
    if (!inv || inv.toId !== id) return { error: 'bad invite' };
    if (inv.until <= now()) { S.invites.delete(pid); return { error: 'expired' }; }
    const from = S.players.get(inv.fromId);
    if (!from) { S.invites.delete(pid); return { error: 'inviter gone' }; }
    if (p.partyId) return { error: 'in party' };
    let party = inv.partyId ? S.parties.get(inv.partyId) : null;
    if (party) {
      if (party.members.size >= WORLD.partyMax) return { error: 'party full' };
      party.members.add(id);
      p.partyId = party.id;
    } else {
      const nid = 'pt' + (++S.seq.pt);
      party = { id: nid, leader: from.id, members: new Set([from.id, id]) };
      S.parties.set(nid, party);
      from.partyId = nid;
      p.partyId = nid;
    }
    for (const [k, v] of S.invites) if (v.toId === id) S.invites.delete(k);
    emit({ e: E.PJOIN, pname: p.name, partyId: party.id, scope: { party: party.id } });
    return { ok: true };
  }

  function leaveParty(id) {
    const p = S.players.get(id);
    if (!p || !p.partyId) return;
    const party = S.parties.get(p.partyId);
    p.partyId = null;
    if (!party) return;
    party.members.delete(id);
    emit({ e: E.PLEAVE, pname: p.name, partyId: party.id, scope: { party: party.id } });
    if (party.members.size === 0) {
      S.parties.delete(party.id);
      emit({ e: E.PDISBAND, partyId: party.id, scope: 'all' });
    } else if (party.leader === id) {
      party.leader = [...party.members][0]; // oldest member takes leadership
    }
  }

  function equipItem(id, uid) {
    const p = S.players.get(id);
    if (!p) return { error: 'no player' };
    const i = p.inv.findIndex((it) => it && it.uid === uid);
    if (i < 0) return { error: 'no item' };
    const it = p.inv[i];
    if (!it.slot || !Object.prototype.hasOwnProperty.call(p.equip, it.slot)) {
      return { error: 'bad slot' };
    }
    p.inv.splice(i, 1);
    const old = p.equip[it.slot];
    p.equip[it.slot] = it;
    if (old) p.inv.push(old); // swap
    const st = statsOf(p, now());
    if (p.hp > st.mhp) p.hp = st.mhp;
    if (p.mana > st.mmana) p.mana = st.mmana;
    return { ok: true };
  }

  function respawn(id) {
    const p = S.players.get(id);
    if (!p) return { error: 'no player' };
    if (!p.dead) return { error: 'not dead' };
    doRespawn(p, now());
    return { ok: true };
  }

  function snapshot(playerId) {
    const p = S.players.get(playerId);
    if (!p) return null;
    const nowMs = tnow();
    const st = statsOf(p, nowMs);
    const you = {
      id: p.id, x: p.x, y: p.y, z: p.z,
      hp: Math.max(0, Math.ceil(p.hp)), mhp: st.mhp,
      mana: Math.max(0, Math.floor(p.mana)), mmana: st.mmana,
      lvl: p.lvl, xp: Math.floor(p.xp), xpNext: LEVEL.xpNext(p.lvl),
      gold: p.gold, fame: p.fame,
      cds: p.cds.map((c) => Math.round(c * 100) / 100),
      dead: p.dead, inv: p.inv,
      equip: { weapon: p.equip.weapon, armor: p.equip.armor, trinket: p.equip.trinket },
      partyId: p.partyId,
    };
    const ents = [];
    for (const q of S.players.values()) {
      if (q.id !== p.id && d2(q.x, q.z, p.x, p.z) > REPLICATE_RADIUS) continue;
      const qs = statsOf(q, nowMs);
      ents.push({
        id: q.id, k: 'p', x: q.x, y: q.y, z: q.z, face: q.face,
        hp: Math.max(0, Math.ceil(q.hp)), mhp: qs.mhp, name: q.name, lvl: q.lvl,
        cls: q.cls, fac: q.fac, party: q.partyId,
        elite: false, boss: false,
        cast: q.castFx && q.castFx.until > nowMs ? { skill: q.castFx.skill, until: q.castFx.until } : null,
        buff: q.buffs.some((b) => b.until > nowMs),
      });
    }
    for (const m of S.monsters.values()) {
      if (d2(m.x, m.z, p.x, p.z) > REPLICATE_RADIUS) continue;
      ents.push({
        id: m.id, k: 'm', x: m.x, y: m.y, z: m.z, face: m.face,
        hp: Math.max(0, Math.ceil(m.hp)), mhp: m.mhp, name: m.name, lvl: m.lvl,
        elite: m.elite, boss: m.boss, cast: null, buff: false,
      });
    }
    const teles = [];
    for (const t of S.telegraphs) {
      if (d2(t.x, t.z, p.x, p.z) <= REPLICATE_RADIUS) {
        teles.push({ id: t.id, x: t.x, z: t.z, r: t.r, until: t.until });
      }
    }
    for (const z of S.zones) {
      if (d2(z.x, z.z, p.x, p.z) <= REPLICATE_RADIUS) {
        teles.push({ id: z.id, x: z.x, z: z.z, r: z.r, until: z.until });
      }
    }
    return { tick: S.tickN, you, ents, teles };
  }

  function tick(nowMs) {
    if (typeof nowMs !== 'number' || !isFinite(nowMs)) nowMs = now();
    S.nowMs = nowMs;
    let dt = S.lastTick < 0 ? 0 : (nowMs - S.lastTick) / 1000;
    dt = clamp(dt, 0, 0.25);
    S.lastTick = nowMs;
    S.tickN++;

    // --- players: auto-respawn, movement, regen, cooldowns, expiry
    for (const p of S.players.values()) {
      if (p.dead) {
        if (nowMs - p.deadAt >= WORLD.respawnMs) doRespawn(p, nowMs);
        continue;
      }
      const st = statsOf(p, nowMs);
      const mx = p.input.mx, mz = p.input.mz;
      if (Math.hypot(mx, mz) > 0.01) {
        p.x = clamp(p.x + mx * st.speed * dt, -BOUND, BOUND);
        p.z = clamp(p.z + mz * st.speed * dt, -BOUND, BOUND);
        p.y = heightAt(p.x, p.z);
        p.face = Math.atan2(mx, mz);
      }
      const hpRate = CLASSES[p.cls].hpRegen * (nowMs - p.lastDmgAt < 5000 ? 0.5 : 1);
      p.hp = Math.min(st.mhp, p.hp + hpRate * dt);
      p.mana = Math.min(st.mmana, p.mana + CLASSES[p.cls].manaRegen * dt);
      for (let i = 0; i < 4; i++) if (p.cds[i] > 0) p.cds[i] = Math.max(0, p.cds[i] - dt);
      if (p.buffs.length) p.buffs = p.buffs.filter((b) => b.until > nowMs);
      if (p.debuffs.length) p.debuffs = p.debuffs.filter((d) => d.until > nowMs);
      if (p.castFx && p.castFx.until <= nowMs) p.castFx = null;
    }

    // --- projectiles
    for (let i = S.projectiles.length - 1; i >= 0; i--) {
      const pr = S.projectiles[i];
      pr.x += pr.vx * dt; pr.z += pr.vz * dt; pr.life -= dt;
      let gone = pr.life <= 0 || Math.abs(pr.x) > WORLD.size / 2 || Math.abs(pr.z) > WORLD.size / 2;
      if (!gone) {
        const targets = pr.kind === 'p'
          ? enemiesOfPlayerId(pr.from)
          : [...S.players.values()].filter((q) => !q.dead);
        for (const e of targets) {
          if (e.id === pr.from) continue;
          if (d2(pr.x, pr.z, e.x, e.z) <= 1.2) {
            if (pr.kind === 'p') {
              damageEntity(e, pr.atk * pr.mult, { id: pr.from, name: pr.fromName, kind: 'p' }, nowMs);
            } else {
              damageEntity(e, pr.atk, { id: pr.from, name: pr.fromName, kind: 'm' }, nowMs);
            }
            gone = true;
            break;
          }
        }
      }
      if (gone) S.projectiles.splice(i, 1);
    }

    // --- telegraphs resolve
    for (let i = S.telegraphs.length - 1; i >= 0; i--) {
      const t = S.telegraphs[i];
      if (nowMs < t.until) continue;
      S.telegraphs.splice(i, 1);
      const targets = t.kind === 'p'
        ? enemiesOfPlayerId(t.from)
        : [...S.players.values()].filter((q) => !q.dead);
      const tsrc = { id: t.from, name: t.fromName, kind: t.kind };
      for (const e of targets) {
        if (d2(e.x, e.z, t.x, t.z) <= t.r) damageEntity(e, t.atk * t.mult, tsrc, nowMs);
      }
    }

    // --- heal zones tick
    for (let i = S.zones.length - 1; i >= 0; i--) {
      const z = S.zones[i];
      if (nowMs >= z.until) { S.zones.splice(i, 1); continue; }
      if (nowMs >= z.nextTick) {
        z.nextTick += z.tickEveryMs;
        const amt = Math.max(1, Math.round(z.atk * z.healMult));
        for (const q of S.players.values()) {
          if (q.dead || q.fac !== z.fac) continue;
          if (d2(q.x, q.z, z.x, z.z) <= z.r) healEntity(q, amt, z.from, nowMs);
        }
      }
    }

    // --- monster AI (incl. boss patterns)
    for (const m of S.monsters.values()) monsterTick(m, dt, nowMs);

    // --- spawners: one monster per point, respawn after MONSTER.respawnMs
    for (const s of S.spawners) {
      if (s.monsterId && S.monsters.has(s.monsterId)) continue;
      s.monsterId = null;
      if (nowMs - s.deadAt >= MONSTER.respawnMs && S.monsters.size < MONSTER_CAP) {
        const type = s.types[(rng() * s.types.length) | 0];
        spawnMonster(type, s.x, s.z, s.ring, rng() < ELITE.chance, s);
      }
    }

    // --- boss respawn
    if (!S.bossId && nowMs - S.bossDeadAt >= BOSS.respawnMs) spawnBoss(nowMs);

    // --- expired invites
    for (const [k, v] of S.invites) if (v.until <= nowMs) S.invites.delete(k);

    const out = S.events;
    S.events = [];
    return out;
  }

  // --- host/test helpers (read-only extras, not part of the core contract)
  function partyOf(id) {
    const p = S.players.get(id);
    if (!p || !p.partyId) return null;
    const party = S.parties.get(p.partyId);
    if (!party) return null;
    return {
      id: party.id, leader: party.leader,
      members: [...party.members]
        .map((mid) => S.players.get(mid))
        .filter(Boolean)
        .map((m) => ({ id: m.id, name: m.name, cls: m.cls, lvl: m.lvl })),
    };
  }
  function pendingInvites(id) {
    const out = [];
    for (const inv of S.invites.values()) {
      if (inv.toId !== id) continue;
      const from = S.players.get(inv.fromId);
      out.push({ pid: inv.pid, from: inv.fromId, fromName: from ? from.name : '?', until: inv.until });
    }
    return out;
  }

  // --- init world
  initSpawners();
  S.bossDeadAt = now() - BOSS.respawnMs; // spawn boss immediately below
  spawnBoss(now());

  return {
    tick, addPlayer, removePlayer, setInput, castSkill, sendChat,
    inviteParty, acceptParty, leaveParty, equipItem, respawn,
    snapshot, getPlayer: (id) => S.players.get(id) || null,
    playerCount: () => S.players.size,
    partyOf, pendingInvites,
  };
}
