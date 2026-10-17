// hordes3d — world constants, class/skill/faction data, deterministic terrain.
// Pure ES module: NO Node.js imports. Shared by sim (server) and client.

export const WORLD = {
  size: 220,            // playable square, coordinates in [-110, 110]
  safeRadius: 14,       // faction spawn safe zone (no PvP damage inside)
  xpShareRadius: 30,    // party XP share range
  partyMax: 5,
  respawnMs: 10000,     // auto-respawn after death
  nameMax: 16,
};

// ---------------------------------------------------------------- deterministic noise
function hash2(ix, iz) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function smooth(t) { return t * t * (3 - 2 * t); }
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const a = hash2(ix, iz), b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  const ux = smooth(fx), uz = smooth(fz);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}
// Terrain height. Deterministic: server and client compute identical values.
export function heightAt(x, z) {
  let h = vnoise(x * 0.02, z * 0.02) * 10
        + vnoise(x * 0.06, z * 0.06) * 3
        + vnoise(x * 0.15, z * 0.15) * 1;
  h -= 7;
  // Flatten gameplay-critical areas: both spawns and the boss arena.
  const flat = (cx, cz, r) => {
    const d = Math.hypot(x - cx, z - cz);
    if (d >= r) return 1;
    const t = smooth(d / r);
    return t;
  };
  const f = Math.min(
    flat(FACTIONS.bloodlust.spawn.x, FACTIONS.bloodlust.spawn.z, 26),
    flat(FACTIONS.vanguard.spawn.x, FACTIONS.vanguard.spawn.z, 26),
    flat(0, 0, 30),
  );
  return h * f;
}
// Vertex color ramp for terrain (client renderer).
export function terrainColor(h, slope) {
  // h: height, slope: 0..1 steepness. Returns [r,g,b] 0..1.
  if (h < -2.5) return [0.76, 0.70, 0.50];       // sand
  if (slope > 0.55) return [0.45, 0.42, 0.40];  // rock
  if (h > 5.5) return [0.90, 0.90, 0.95];        // snow
  const t = Math.min(1, Math.max(0, (h + 2.5) / 8));
  return [0.25 + t * 0.15, 0.45 + t * 0.10, 0.22]; // grass gradient
}

// ---------------------------------------------------------------- factions
export const FACTIONS = {
  bloodlust: { id: 'bloodlust', name: 'Bloodlust', css: '#e74c3c', color: 0xc0392b,
               spawn: { x: -80, z: 0 } },
  vanguard:  { id: 'vanguard',  name: 'Vanguard',  css: '#3498db', color: 0x2980b9,
               spawn: { x: 80, z: 0 } },
};

// ---------------------------------------------------------------- classes
// hp/mana/atk/def are base stats at level 1; per-level growth below.
export const CLASSES = {
  warrior: { id: 'warrior', name: 'Warrior', color: 0xb03a2e, css: '#e74c3c',
             hp: 130, mana: 40, atk: 14, def: 7, speed: 6.2,
             hpRegen: 2.5, manaRegen: 1.5, range: 3.2 },
  mage:    { id: 'mage', name: 'Mage', color: 0x8e44ad, css: '#a569bd',
             hp: 85, mana: 110, atk: 19, def: 3, speed: 5.8,
             hpRegen: 1.8, manaRegen: 4.0, range: 3.2 },
  shaman:  { id: 'shaman', name: 'Shaman', color: 0x1e8449, css: '#58d68d',
             hp: 100, mana: 85, atk: 12, def: 5, speed: 5.9,
             hpRegen: 2.2, manaRegen: 3.0, range: 3.2 },
  archer:  { id: 'archer', name: 'Archer', color: 0x935116, css: '#f0a832',
             hp: 95, mana: 65, atk: 16, def: 4, speed: 6.5,
             hpRegen: 2.0, manaRegen: 2.2, range: 3.2 },
};
export const LEVEL = {
  max: 20,
  hpMul: 0.12, manaMul: 0.10, atkMul: 0.10, defMul: 0.08, // per-level growth
  xpNext: (lvl) => Math.round(40 * Math.pow(lvl, 1.6)),   // xp to go lvl -> lvl+1
};

// ---------------------------------------------------------------- skills
// kind: 'melee' | 'proj' | 'aoe_self' | 'aoe_point' | 'line' | 'cone'
//       | 'dash' | 'blink' | 'chain' | 'heal' | 'hot' | 'debuff' | 'buff'
// dmg/heal numbers are multipliers of the caster's atk (heal uses atk too).
// Generic fields: cd (s), mana, range (cast range), radius, delay (s, for aoe_point).
export const SKILLS = {
  warrior: [
    { id: 'slash',     name: 'Slash',     cd: 1.1, mana: 0,  range: 3.4, kind: 'melee',    dmg: 1.25 },
    { id: 'whirlwind', name: 'Whirlwind', cd: 8,   mana: 14, range: 0,   kind: 'aoe_self', radius: 6.5, dmg: 1.9 },
    { id: 'charge',    name: 'Charge',    cd: 12,  mana: 10, range: 14,  kind: 'dash',     dashDist: 11, dmg: 1.1, radius: 3 },
    { id: 'warcry',    name: 'War Cry',   cd: 20,  mana: 18, range: 0,   kind: 'buff',     dur: 8, atkMul: 1.3, defAdd: 6 },
  ],
  mage: [
    { id: 'fireball', name: 'Fireball',  cd: 1.6, mana: 8,  range: 26, kind: 'proj',     dmg: 1.7, projSpeed: 24 },
    { id: 'frostnova',name: 'Frost Nova',cd: 10,  mana: 18, range: 0,  kind: 'aoe_self', radius: 8, dmg: 1.1, slow: 0.5, slowDur: 3 },
    { id: 'blink',    name: 'Blink',     cd: 14,  mana: 14, range: 13, kind: 'blink' },
    { id: 'meteor',   name: 'Meteor',    cd: 18,  mana: 30, range: 24, kind: 'aoe_point',radius: 6, dmg: 2.8, delay: 1.2 },
  ],
  shaman: [
    { id: 'bolt', name: 'Lightning Bolt', cd: 2.2, mana: 10, range: 22, kind: 'chain', dmg: 1.35, jumps: 3, jumpFalloff: 0.7 },
    { id: 'heal', name: 'Heal',           cd: 6,   mana: 20, range: 24, kind: 'heal',  heal: 2.2 },
    { id: 'ward', name: 'Healing Ward',   cd: 20,  mana: 26, range: 18, kind: 'hot',   radius: 7, dur: 6, tickHeal: 0.5, tickEvery: 1 },
    { id: 'hex',  name: 'Hex',            cd: 12,  mana: 15, range: 20, kind: 'debuff',dmg: 0.6, slow: 0.55, dur: 4 },
  ],
  archer: [
    { id: 'pierce',   name: 'Piercing Shot', cd: 1.8, mana: 6,  range: 24, kind: 'line', dmg: 1.5, width: 2.6 },
    { id: 'multishot',name: 'Multi-Shot',   cd: 7,   mana: 14, range: 18, kind: 'cone', dmg: 1.2, angle: 0.65 },
    { id: 'volley',   name: 'Volley',        cd: 16,  mana: 26, range: 26, kind: 'aoe_point', radius: 5.5, dmg: 2.3, delay: 0.8 },
    { id: 'camo',     name: 'Camouflage',    cd: 18,  mana: 12, range: 0,  kind: 'buff', dur: 6, speedMul: 1.35, noAggro: true },
  ],
};

// ---------------------------------------------------------------- monsters
export const MONSTERS = {
  gloom:   { name: 'Gloom',   hp: 42, atk: 7,  def: 0, speed: 3.6, xp: 12, gold: [2, 6],
             aggro: 11, attackRange: 2.3, attackCd: 1.4, ranged: false, color: 0x7d3c98, scale: 1.0 },
  spitter: { name: 'Spitter', hp: 30, atk: 9,  def: 0, speed: 3.2, xp: 17, gold: [3, 8],
             aggro: 13, attackRange: 13, attackCd: 2.1, ranged: true,  color: 0x229954, scale: 0.9 },
  brute:   { name: 'Brute',   hp: 95, atk: 11, def: 2, speed: 3.0, xp: 28, gold: [5, 12],
             aggro: 10, attackRange: 2.6, attackCd: 1.8, ranged: false, color: 0x943126, scale: 1.35 },
};
export const ELITE = { chance: 0.10, hpMul: 3.2, atkMul: 1.5, xpMul: 4, goldMul: 3, scaleMul: 1.5, lootBonus: 1 };
export const BOSS = {
  name: 'Ancient Colossus', hp: 2600, atk: 32, def: 6, speed: 3.4, xp: 600, gold: [80, 140],
  aggro: 26, attackRange: 4.5, attackCd: 2.0, color: 0x5d6d7e, scale: 3.2,
  spawn: { x: 0, z: 0 }, respawnMs: 5 * 60 * 1000,
  // telegraph patterns, picked round-robin-ish at random
  patterns: [
    { kind: 'slam',   radius: 9,  telegraphMs: 1400, dmgMul: 2.2 },
    { kind: 'ring',   radius: 14, telegraphMs: 1800, dmgMul: 1.4 }, // expanding ring
    { kind: 'summon', count: 3 },
  ],
  patternEveryMs: 7000,
};
// Spawner rings: { radius from center, monster types allowed, count }
export const SPAWNERS = [
  { r: 95, types: ['gloom'], count: 4 },
  { r: 80, types: ['gloom', 'spitter'], count: 4 },
  { r: 62, types: ['gloom', 'spitter', 'brute'], count: 4 },
  { r: 45, types: ['spitter', 'brute'], count: 3 },
  { r: 30, types: ['brute'], count: 3 },
];
export const MONSTER = {
  respawnMs: 22000, leashDist: 26, wanderRadius: 8,
  aggroDropMs: 6000, // lose target if it escapes aggro range this long
};

// ---------------------------------------------------------------- loot
export const QUALITIES = [
  { id: 'common',    name: 'Common',    css: '#bdc3c7', weight: 60, budget: 1.0 },
  { id: 'uncommon',  name: 'Uncommon',  css: '#2ecc71', weight: 25, budget: 1.6 },
  { id: 'rare',      name: 'Rare',      css: '#3498db', weight: 10, budget: 2.4 },
  { id: 'epic',      name: 'Epic',      css: '#9b59b6', weight: 4,  budget: 3.4 },
  { id: 'legendary', name: 'Legendary', css: '#f39c12', weight: 1,  budget: 4.8 },
];
export const LOOT = {
  dropChance: 0.35,          // normal monsters
  eliteDropChance: 0.9,
  bossDropCount: 3,          // boss always drops this many items
  prefixes: ['Worn', 'Fine', 'Knight\'s', 'Mystic', 'Warlord\'s'],
  slotNames: { weapon: 'Blade', armor: 'Plate', trinket: 'Charm' },
};

// ---------------------------------------------------------------- PvP
export const PVP = {
  fameBase: 10, famePerLevel: 2,
  goldSteal: 0.10, // fraction of victim gold stolen by killer
};
