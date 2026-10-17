// hordes3d — shared network protocol (client <-> server).
// Pure ES module: NO Node.js imports. Used by browser client and Node server alike.
// All messages are JSON objects sent over a single WebSocket connection.

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------
// { t:'join',   name:string, classId:'warrior'|'mage'|'shaman'|'archer',
//               faction:'bloodlust'|'vanguard' }
//   -> server replies { t:'welcome', id, tick } then starts sending snapshots.
//
// { t:'input',  seq:number, mx:number, mz:number }   movement vector (-1..1), sent
//   at ~10Hz or whenever it changes. (0,0) = stop.
//
// { t:'cast',   skill:0|1|2|3, tx:number, tz:number } cast skill aimed at world point.
//   Server validates range / mana / cooldown / line-of-sight (MVP: range only).
//
// { t:'chat',   ch:'global'|'party', text:string }    text max 140 chars (server trims).
//
// { t:'pinv',   name:string }    invite player (by exact name) to party.
// { t:'pacc',   pid:string }     accept pending invite id.
// { t:'pleave' }                 leave current party.
//
// { t:'equip',  uid:string }      equip inventory item (weapon|armor|trinket slot).
// { t:'respawn' }                respawn at faction spawn after death.

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------
// { t:'welcome', id:string, tick:number }
// { t:'snap', tick:number, you:YouState, ents:Ent[], teles:Telegraph[] }
//   Sent at 20Hz. `ents` = entities within REPLICATE_RADIUS of the player,
//   including other players, monsters, elites and the boss. Projectiles are
//   NOT replicated (client draws them from `cast` events + sim-less fx).
// { t:'evs', list:Ev[] }          gameplay events since last tick (batched).
// { t:'chat', from:string, ch:'global'|'party'|'sys', text:string }
// { t:'party', you:PartyView|null, invites:Invite[] }
//   Party state pushed on change. PartyView { id, leader, members:[{id,name,cls,lvl}] }.
// { t:'err', msg:string }          non-fatal error (bad cast, bad invite, ...).

// ---------------------------------------------------------------------------
// Snapshot shapes
// ---------------------------------------------------------------------------
// YouState (the connected player):
// { id, x,y,z, hp,mhp, mana,mmana, lvl, xp, xpNext, gold, fame,
//   cds:[s0,s1,s2,s3] (seconds remaining), dead:bool,
//   inv:[Item], equip:{ weapon:Item|null, armor:Item|null, trinket:Item|null },
//   partyId:string|null }
//
// Ent (any replicated entity):
// { id, k:'p'|'m',            // player | monster (boss is a monster with boss:true)
//   x,y,z, face,              // face = facing angle radians
//   hp, mhp, name, lvl,
//   cls, fac,                 // classId / factionId (players only)
//   party:string|null,         // party id (players only, for marker color)
//   elite:bool, boss:bool,     // monsters only
//   cast:{skill:number, until:number}|null,  // currently casting (for anim/fx)
//   buff:boolean }             // has active buff (client shows glow)
//
// Telegraph (boss / skill ground effects the client must render):
// { id, x, z, r, until }       // until = sim timestamp (ms) when it resolves
//
// Item:
// { uid, slot:'weapon'|'armor'|'trinket', name, q:0..4 (quality index),
//   atk, def, hp, mana }        // bonus stats granted when equipped

// ---------------------------------------------------------------------------
// Events (Ev) — each carries a routing `scope` so the thin server adapter knows
// who should receive it. scope is stripped before sending to clients.
// ---------------------------------------------------------------------------
// scope:'all'                       -> every connected player
// scope:{ party:'<partyId>' }       -> members of that party
// scope:{ player:'<playerId>' }     -> that player only
//
// Event types:
// { e:'dmg',  to, amt, crit, src }            damage number at entity `to`
// { e:'heal', to, amt, src }
// { e:'die',  id, by, pname, fame }           fame>0 on PvP kill (killer's gain)
// { e:'cast', id, skill, tx, tz, cls }        someone cast a skill (client fx)
// { e:'loot', item:Item, gold }               you picked up loot (auto-loot)
// { e:'lvl',  id, lvl, pname }
// { e:'tele', id, x, z, r, durMs, kind }      telegraph appeared (also in snap)
// { e:'chat', from, ch, text }                routed as scope (global/party/sys)
// { e:'pinv', pid, from, fromName }           party invite (scope player=invitee)
// { e:'pjoin', pname, partyId } / { e:'pleave', pname, partyId } /
// { e:'pdisband', partyId }
// { e:'respawn', id }

export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;
export const REPLICATE_RADIUS = 70;

// Event names (avoid typos across sim / server / client).
export const E = {
  DMG: 'dmg', HEAL: 'heal', DIE: 'die', CAST: 'cast', LOOT: 'loot',
  LVL: 'lvl', TELE: 'tele', CHAT: 'chat',
  PINV: 'pinv', PJOIN: 'pjoin', PLEAVE: 'pleave', PDISBAND: 'pdisband',
  RESPAWN: 'respawn',
};
