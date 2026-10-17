// hordes3d — smoke test: two headless bots vs the REAL server (child process).
//
// No browser. Spawns `node server/index.js` on a free-ish port, drives two
// ws clients through join -> move -> chat -> party -> PvE kill -> PvP kill ->
// respawn -> bad-input, asserting protocol shapes from shared/protocol.js.
//
// Run: `npm test`  (node test/smoke.js)

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const PORT = Number(process.env.SMOKE_PORT || 4177);
const TOTAL_TIMEOUT_MS = 4 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Bot: thin ws wrapper tracking latest protocol state.
// ---------------------------------------------------------------------------
class Bot {
  constructor(name, classId, faction) {
    this.name = name;
    this.classId = classId;
    this.faction = faction;
    this.ws = null;
    this.id = null;
    this.snap = null;      // latest { t:'snap', ... }
    this.party = null;     // latest party view (you)
    this.invites = [];     // latest invites
    this.evs = [];         // accumulated stripped events (cleared manually)
    this.chats = [];       // received { t:'chat', ... }
    this.errs = [];        // received { t:'err', ... }
    this.seq = 1;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      this.ws = ws;
      const onErr = (e) => reject(new Error(`ws error for ${this.name}: ${e.message || e}`));
      ws.on('error', onErr);
      ws.on('open', () => {
        ws.off('error', onErr);
        ws.on('error', () => {});
        ws.send(JSON.stringify({ t: 'join', name: this.name, classId: this.classId, faction: this.faction }));
        resolve();
      });
      ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(String(raw)); } catch { return; }
        this.handle(m);
      });
      ws.on('close', () => {});
    });
  }

  handle(m) {
    if (!m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'welcome': this.id = m.id; break;
      case 'snap': this.snap = m; break;
      case 'party': this.party = m.you; this.invites = m.invites || []; break;
      case 'evs': if (Array.isArray(m.list)) this.evs.push(...m.list); break;
      case 'chat': this.chats.push(m); break;
      case 'err': this.errs.push(m); break;
      default: break;
    }
  }

  send(o) { this.ws.send(JSON.stringify(o)); }
  input(mx, mz) { this.send({ t: 'input', seq: this.seq++, mx, mz }); }
  stop() { this.input(0, 0); }
  cast(skill, tx, tz) { this.send({ t: 'cast', skill, tx, tz }); }
  clearEvs() { this.evs = []; }
  close() { try { this.ws && this.ws.close(); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
async function waitForState(get, pred, timeoutMs, label) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = get();
    if (pred(last)) return last;
    await sleep(100);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

function dist2d(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }

// Steer bot toward (tx,tz); returns distance. Sends stop when very close.
function moveToward(bot, tx, tz) {
  const s = bot.snap;
  if (!s) return Infinity;
  const dx = tx - s.you.x, dz = tz - s.you.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.6) { bot.stop(); return d; }
  bot.input(dx / d, dz / d);
  return d;
}

function nearestEnt(bot, pred) {
  const s = bot.snap;
  if (!s) return null;
  let best = null, bd = Infinity;
  for (const e of s.ents || []) {
    if (!pred(e)) continue;
    const d = dist2d(e, s.you);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

// Chase-and-cast loop until `done(bot)` is true or timeout. Used for PvE.
async function huntLoop(bot, { skillIdx, castRange, prefer, timeoutMs, done, label }) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (done(bot)) return true;
    const s = bot.snap;
    if (!s) { await sleep(150); continue; }
    if (s.you.dead) throw new Error(`${bot.name} died during ${label}`);
    const tgt = prefer(bot);
    if (!tgt) { await sleep(200); continue; }
    const d = dist2d(tgt, s.you);
    if (d <= castRange) {
      bot.stop();
      bot.cast(skillIdx, tgt.x, tgt.z);
    } else {
      moveToward(bot, tgt.x, tgt.z);
    }
    await sleep(120);
  }
  return done(bot);
}

// ---------------------------------------------------------------------------
// Server child process
// ---------------------------------------------------------------------------
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const to = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not print listening line in 10s. output: ${out}`));
    }, 10000);
    child.stdout.on('data', (d) => {
      out += String(d);
      if (/listening/i.test(out)) { clearTimeout(to); resolve(child); }
    });
    child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    child.on('error', (e) => { clearTimeout(to); reject(e); });
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        process.stderr.write(`[server] exited with code ${code}\n`);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`[PASS] ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    results.push(true);
  } catch (e) {
    console.log(`[FAIL] ${name}: ${e.message}`);
    results.push(false);
  }
}

let child = null;
let A = null, B = null;

async function cleanup() {
  try { A && A.close(); } catch { /* ignore */ }
  try { B && B.close(); } catch { /* ignore */ }
  if (child) {
    child.kill('SIGTERM');
    await sleep(500);
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
}

async function main() {
  const watchdog = setTimeout(async () => {
    console.log('[FAIL] TOTAL TIMEOUT (4 min) — failing honestly');
    await cleanup();
    process.exit(1);
  }, TOTAL_TIMEOUT_MS);

  child = await startServer();
  console.log(`server up on port ${PORT}`);

  A = new Bot('BotA', 'warrior', 'bloodlust');
  B = new Bot('BotB', 'mage', 'vanguard');

  // ---- b. join -----------------------------------------------------------
  await step('b. join: both bots get welcome with distinct ids', async () => {
    await A.connect();
    await B.connect();
    await waitForState(() => A.id, Boolean, 10000, 'A welcome');
    await waitForState(() => B.id, Boolean, 10000, 'B welcome');
    await waitForState(() => A.snap && B.snap, Boolean, 10000, 'first snaps');
    if (A.id === B.id) throw new Error('ids not distinct');
    console.log(`    A.id=${A.id} B.id=${B.id}`);
  });

  // ---- c. movement -------------------------------------------------------
  await step('c. movement: A moves +x, snap x increases', async () => {
    const x0 = A.snap.you.x;
    const t0 = Date.now();
    while (Date.now() - t0 < 1200) { A.input(1, 0); await sleep(100); }
    A.stop();
    const s = await waitForState(() => A.snap, (sn) => sn.you.x > x0 + 2, 5000, 'x increased');
    console.log(`    x: ${x0.toFixed(1)} -> ${s.you.x.toFixed(1)}`);
  });

  // ---- d. chat -----------------------------------------------------------
  await step('d. chat: B receives global chat from A', async () => {
    B.chats = [];
    A.send({ t: 'chat', ch: 'global', text: 'hello' });
    const m = await waitForState(
      () => B.chats.find((c) => c.from === 'BotA' && c.text === 'hello'),
      Boolean, 5000, 'chat delivery',
    );
    if (m.ch !== 'global') throw new Error(`wrong channel: ${m.ch}`);
  });

  // ---- e. party ----------------------------------------------------------
  await step('e. party: invite -> accept -> 2-member party, A leader', async () => {
    A.send({ t: 'pinv', name: 'BotB' });
    const inv = await waitForState(
      () => B.invites.find((i) => i.fromName === 'BotA'),
      Boolean, 8000, 'invite arrival',
    );
    B.send({ t: 'pacc', pid: inv.pid });
    const pa = await waitForState(
      () => A.party, (p) => p && p.members.length === 2, 8000, 'A party view',
    );
    const pb = await waitForState(
      () => B.party, (p) => p && p.members.length === 2, 8000, 'B party view',
    );
    if (pa.leader !== A.id) throw new Error(`A sees leader=${pa.leader}, want ${A.id}`);
    if (pb.leader !== A.id) throw new Error(`B sees leader=${pb.leader}, want ${A.id}`);
    const names = pa.members.map((m) => m.name).sort().join(',');
    if (names !== 'BotA,BotB') throw new Error(`members=${names}`);
    console.log(`    party=${pa.id} leader=${pa.leader}`);
  });

  // ---- f. PvE kill -------------------------------------------------------
  await step('f. PvE: A kills nearest monster, die event + xp up', async () => {
    const xp0 = A.snap.you.xp;
    A.clearEvs();
    const prefer = (bot) => nearestEnt(bot, (e) => e.k === 'm');
    const ok = await huntLoop(A, {
      skillIdx: 0, castRange: 3.0, prefer, timeoutMs: 60000,
      label: 'A monster kill',
      done: (bot) => bot.evs.some((e) => e.e === 'die' && e.id !== A.id && e.id !== B.id),
    });
    A.stop();
    if (!ok) throw new Error('no monster die event within 60s');
    const die = A.evs.find((e) => e.e === 'die' && e.id !== A.id && e.id !== B.id);
    console.log(`    die: id=${die.id} by=${die.pname}`);
    const s = await waitForState(() => A.snap, (sn) => sn.you.xp > xp0, 5000, 'xp increase');
    console.log(`    xp: ${xp0} -> ${s.you.xp}`);
  });

  // ---- g. PvP kill -------------------------------------------------------
  await step('g. PvP: A kills B at neutral ground; fame/steal/death/respawn', async () => {
    // g0. B earns gold first (10% steal of 0 would be unobservable).
    B.clearEvs();
    const bok = await huntLoop(B, {
      skillIdx: 0, castRange: 20, timeoutMs: 90000, label: 'B gold farm',
      prefer: (bot) => {
        const s = bot.snap;
        let best = null, bd = Infinity, be = Infinity;
        for (const e of (s && s.ents) || []) {
          if (e.k !== 'm') continue;
          const d = dist2d(e, s.you);
          const el = e.elite ? 1 : 0;
          if (el < be || (el === be && d < bd)) { be = el; bd = d; best = e; }
        }
        return best;
      },
      done: (bot) => bot.snap.you.gold >= 10 || bot.snap.you.dead,
    });
    B.stop();
    if (B.snap.you.dead) {
      B.send({ t: 'respawn' });
      await waitForState(() => B.snap, (s) => !s.you.dead, 8000, 'B respawn after farm death');
      throw new Error('B died while farming gold — retry needed');
    }
    if (!bok || B.snap.you.gold < 10) throw new Error('B could not farm >=10 gold in 90s');
    console.log(`    B farmed gold=${B.snap.you.gold} xp=${B.snap.you.xp}`);

    // g1. Rendezvous at (-40, 40): outside both safe zones (radius 14 at
    // (-80,0) and (80,0)), away from the boss at (0,0). B takes a dog-leg to
    // skirt the boss aggro range.
    const ARENA = { x: -40, z: 40 };
    const wpsA = [{ ...ARENA }];
    const wpsB = [{ x: 40, z: 40 }, { ...ARENA }];
    A.clearEvs(); B.clearEvs();
    const t1 = Date.now();
    let aArrivedAt = 0;
    while (Date.now() - t1 < 90000) {
      const aD = wpsA.length ? moveToward(A, wpsA[0].x, wpsA[0].z) : 0;
      const bD = wpsB.length ? moveToward(B, wpsB[0].x, wpsB[0].z) : 0;
      if (wpsA.length && aD < 3) { wpsA.shift(); aArrivedAt = Date.now(); }
      if (wpsB.length && bD < 3) wpsB.shift();
      // A arrived first: patrol a small circuit + clear nearby monsters
      // while waiting, instead of standing still as a punching bag.
      if (!wpsA.length && wpsB.length) {
        const s = A.snap;
        const mob = s && nearestEnt(A, (e) => e.k === 'm' && dist2d(e, ARENA) < 16);
        if (mob && s) {
          const d = dist2d(mob, s.you);
          if (d <= 3.0) { A.stop(); A.cast(0, mob.x, mob.z); }
          else moveToward(A, mob.x, mob.z);
        } else if (s) {
          const px = ARENA.x + (Math.floor((Date.now() - aArrivedAt) / 3000) % 2 === 0 ? -6 : 6);
          moveToward(A, px, ARENA.z);
        }
        if (s && s.you.dead) throw new Error('A died waiting at arena');
      }
      if (B.snap && B.snap.you.dead) throw new Error('B died en route to arena');
      if (!wpsA.length && !wpsB.length) break;
      await sleep(150);
    }
    if (wpsA.length || wpsB.length) throw new Error('rendezvous timed out');
    A.stop(); B.stop();
    await sleep(400);
    console.log(`    rendezvous at (${A.snap.you.x.toFixed(1)}, ${A.snap.you.z.toFixed(1)}) / (${B.snap.you.x.toFixed(1)}, ${B.snap.you.z.toFixed(1)})`);

    // g2. Fight: A slashes B until B dies.
    const fameA0 = A.snap.you.fame;
    const goldB0 = B.snap.you.gold;
    A.clearEvs();
    const t2 = Date.now();
    let dieEv = null;
    while (Date.now() - t2 < 60000) {
      const s = A.snap, sb = B.snap;
      if (!s || !sb) { await sleep(150); continue; }
      if (s.you.dead) throw new Error('A died during PvP');
      const d = dist2d(s.you, sb.you);
      if (d <= 3.0) { A.stop(); A.cast(0, sb.you.x, sb.you.z); }
      else moveToward(A, sb.you.x, sb.you.z);
      B.stop();
      dieEv = A.evs.find((e) => e.e === 'die' && e.id === B.id);
      if (dieEv) break;
      await sleep(120);
    }
    A.stop(); B.stop();
    if (!dieEv) throw new Error('B did not die within 60s of PvP');
    if (!(dieEv.fame > 0)) throw new Error(`die fame not >0: ${dieEv.fame}`);
    console.log(`    die: id=${dieEv.id} by=${dieEv.pname} fame=${dieEv.fame}`);

    const sa = await waitForState(() => A.snap, (s) => s.you.fame > fameA0, 5000, 'A fame increase');
    console.log(`    A fame: ${fameA0} -> ${sa.you.fame}`);
    const sbDead = await waitForState(() => B.snap, (s) => s.you.dead === true, 5000, 'B dead flag');
    if (!(sbDead.you.gold < goldB0)) {
      throw new Error(`B gold did not decrease: ${goldB0} -> ${sbDead.you.gold}`);
    }
    console.log(`    B gold: ${goldB0} -> ${sbDead.you.gold} (10% steal)`);

    // g3. Respawn.
    B.send({ t: 'respawn' });
    const sb2 = await waitForState(
      () => B.snap, (s) => s.you.dead === false && s.you.hp >= s.you.mhp,
      8000, 'B respawn',
    );
    console.log(`    B respawned at (${sb2.you.x.toFixed(1)}, ${sb2.you.z.toFixed(1)}) hp=${sb2.you.hp}/${sb2.you.mhp}`);
  });

  // ---- h. bad input ------------------------------------------------------
  await step('h. bad input: err replies, server still ticking', async () => {
    A.errs = [];
    A.send({ t: 'cast', skill: 99, tx: 0, tz: 0 });
    A.send({ t: 'pinv', name: 'Nobody' });
    await waitForState(() => A.errs, (e) => e.length >= 2, 5000, 'two err replies');
    console.log(`    errs: ${A.errs.map((e) => e.msg).join(' | ')}`);
    const tick0 = A.snap.tick;
    await waitForState(() => A.snap, (s) => s.tick > tick0 + 10, 5000, 'ticks keep flowing');
  });

  // ---- summary -----------------------------------------------------------
  const passed = results.filter(Boolean).length;
  console.log(`\n==== ${passed}/${results.length} steps passed ====`);
  clearTimeout(watchdog);
  await cleanup();
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(async (e) => {
  console.error('smoke harness error:', e);
  await cleanup();
  process.exit(1);
});
