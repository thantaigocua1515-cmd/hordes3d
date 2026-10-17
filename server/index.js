// hordes3d — thin Node server adapter.
//
// No game rules live here: all simulation logic is in ../shared/sim.js
// (contract: docs/SIM_CONTRACT.md). This file only does:
//   - static file serving for local dev,
//   - WebSocket plumbing (join / C2S messages per shared/protocol.js),
//   - the 20Hz tick loop that drives sim.tick(),
//   - routing sim events to the right sockets by their `scope`.
//
// Original code; zero game-asset copying.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { createSim } from '../shared/sim.js';
import { TICK_MS } from '../shared/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const PORT = Number(process.env.PORT || 3000);
const IDLE_TIMEOUT_MS = 60_000;

const sim = createSim({ now: () => Date.now(), rng: Math.random });

// ---------------------------------------------------------------- static files
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Map a request path to a file under ROOT, or null when not served.
function mapUrl(urlPath) {
  if (urlPath === '/') return 'client/index.html';
  if (
    urlPath.startsWith('/js/') ||
    urlPath.startsWith('/css/') ||
    urlPath === '/config.js'
  ) {
    return 'client' + urlPath;
  }
  if (urlPath.startsWith('/shared/')) return urlPath.slice(1); // 'shared/world.js'
  return null;
}

const httpServer = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const u = new URL(req.url || '/', 'http://localhost');
    const rel = mapUrl(u.pathname);
    if (!rel) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep)) {
      res.writeHead(404); // path traversal attempt
      res.end('not found');
      return;
    }
    const body = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'content-type': CONTENT_TYPES[ext] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

// ---------------------------------------------------------------- clients
// ws -> { ws, playerId: string|null, lastMsg: number }
const clients = new Map();

let tick = 0;

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// PartyView is read straight from the sim's read-only helpers
// (sim.partyOf / sim.pendingInvites, see SIM_CONTRACT.md).
function partyView(playerId) {
  try {
    return sim.partyOf(playerId); // { id, leader, members } | null
  } catch {
    return null;
  }
}

function sendParty(ws, playerId) {
  let invites = [];
  try {
    invites = sim
      .pendingInvites(playerId)
      .map(({ pid, from, fromName }) => ({ pid, from, fromName }));
  } catch {
    // fall through with empty invites
  }
  send(ws, { t: 'party', you: partyView(playerId), invites });
}

function findPlayerIdByName(name) {
  for (const c of clients.values()) {
    if (!c.playerId) continue;
    const p = sim.getPlayer(c.playerId);
    if (p && p.name === name) return c.playerId;
  }
  return null;
}

// Expand an event `scope` into the player ids that should receive it.
function scopeTargets(scope) {
  if (scope === 'all') {
    return [...clients.values()].filter((c) => c.playerId).map((c) => c.playerId);
  }
  if (scope && scope.party) {
    const out = [];
    for (const c of clients.values()) {
      if (!c.playerId) continue;
      const p = sim.getPlayer(c.playerId);
      if (p && p.partyId === scope.party) out.push(c.playerId);
    }
    return out;
  }
  if (scope && scope.player) {
    for (const c of clients.values()) {
      if (c.playerId === scope.player) return [scope.player];
    }
    return [];
  }
  return [];
}

// Route one tick's drained events: `evs` batches, `chat` messages, and
// `party` view refreshes on membership/invite changes. Scope is stripped
// before anything reaches the client (per protocol.js).
function routeEvents(events) {
  const perPlayerEvs = new Map(); // playerId -> Ev[] (scope-stripped)
  const chatOut = []; // { id, msg }
  const partyDirty = new Set(); // playerIds needing a fresh { t:'party' }

  for (const ev of events) {
    if (!ev || typeof ev.e !== 'string') continue;

    if (ev.e === 'chat') {
      const msg = { t: 'chat', from: ev.from, ch: ev.ch, text: ev.text };
      for (const id of scopeTargets(ev.scope)) chatOut.push({ id, msg });
      continue;
    }

    if (ev.e === 'pinv') {
      // { e:'pinv', pid, from, fromName } scoped to the invitee — the invite
      // list itself is read from sim.pendingInvites() when pushing party views.
      const to = ev.scope && ev.scope.player;
      if (to) partyDirty.add(to);
    }

    if (ev.e === 'pjoin' || ev.e === 'pleave' || ev.e === 'pdisband') {
      if (ev.partyId) {
        for (const id of scopeTargets({ party: ev.partyId })) partyDirty.add(id);
      }
      const id = findPlayerIdByName(ev.pname);
      if (id) partyDirty.add(id); // leaver/joinee sees their new (null or set) party
    }

    const { scope, ...stripped } = ev;
    for (const id of scopeTargets(scope)) {
      if (!perPlayerEvs.has(id)) perPlayerEvs.set(id, []);
      perPlayerEvs.get(id).push(stripped);
    }
  }

  const byId = new Map();
  for (const c of clients.values()) {
    if (c.playerId) byId.set(c.playerId, c.ws);
  }
  for (const [id, list] of perPlayerEvs) {
    const ws = byId.get(id);
    if (ws) send(ws, { t: 'evs', list });
  }
  for (const { id, msg } of chatOut) {
    const ws = byId.get(id);
    if (ws) send(ws, msg);
  }
  for (const id of partyDirty) {
    const ws = byId.get(id);
    if (ws) sendParty(ws, id);
  }
}

// ---------------------------------------------------------------- C2S messages
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function handleMsg(st, m) {
  const id = st.playerId;
  const fail = (r) => {
    if (r && (r.error || r.ok === false)) {
      send(st.ws, { t: 'err', msg: r.error || r.err || 'error' });
      return true;
    }
    return false;
  };
  switch (m.t) {
    case 'input':
      sim.setInput(id, { mx: num(m.mx), mz: num(m.mz) });
      break;
    case 'cast':
      fail(sim.castSkill(id, m.skill, num(m.tx), num(m.tz)));
      break;
    case 'chat':
      fail(sim.sendChat(id, m.ch, String(m.text ?? '')));
      break;
    case 'pinv':
      fail(sim.inviteParty(id, String(m.name ?? '')));
      break;
    case 'pacc':
      fail(sim.acceptParty(id, m.pid));
      break;
    case 'pleave':
      sim.leaveParty(id);
      break;
    case 'equip':
      fail(sim.equipItem(id, m.uid));
      break;
    case 'respawn':
      fail(sim.respawn(id));
      break;
    default:
      break; // unknown message: ignore
  }
}

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  const st = { ws, playerId: null, lastMsg: Date.now() };
  clients.set(ws, st);

  ws.on('message', (raw) => {
    st.lastMsg = Date.now();
    let m;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return; // malformed: ignore
    }
    if (!m || typeof m.t !== 'string') return;

    if (st.playerId === null) {
      // Pre-join: only { t:'join' } is accepted. Errors keep the socket
      // open so the client can retry.
      if (m.t !== 'join') {
        send(ws, { t: 'err', msg: 'send join first' });
        return;
      }
      let r;
      try {
        r = sim.addPlayer({ name: m.name, classId: m.classId, faction: m.faction });
      } catch (err) {
        send(ws, { t: 'err', msg: 'join failed' });
        console.error('[join] addPlayer threw:', err);
        return;
      }
      if (r.error) {
        send(ws, { t: 'err', msg: r.error });
        return;
      }
      st.playerId = r.id;
      try {
        const s = sim.snapshot(r.id);
        if (s && typeof s.tick === 'number') tick = s.tick; // resync to sim clock
      } catch {
        // welcome still goes out with the adapter's tick below
      }
      console.log('join', r.id);
      send(ws, { t: 'welcome', id: r.id, tick });
      sendParty(ws, r.id);
      return;
    }

    try {
      handleMsg(st, m);
    } catch (err) {
      console.error('[msg]', m.t, 'for', st.playerId, 'threw:', err);
      send(ws, { t: 'err', msg: 'internal error' });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (st.playerId) {
      console.log('leave', st.playerId);
      try {
        sim.removePlayer(st.playerId);
      } catch (err) {
        console.error('[close] removePlayer threw:', err);
      }
      // Invite cleanup is handled by sim.removePlayer() itself.
    }
  });

  ws.on('error', () => {});
});

// ---------------------------------------------------------------- 20Hz loop
function doTick() {
  tick++;
  let events = [];
  try {
    events = sim.tick(Date.now()) || [];
  } catch (err) {
    console.error('[tick] sim.tick failed:', err);
  }

  const now = Date.now();
  for (const [ws, st] of clients) {
    if (now - st.lastMsg > IDLE_TIMEOUT_MS) {
      console.log('idle timeout', st.playerId || '(pre-join)');
      ws.terminate();
    }
  }

  routeEvents(events);

  for (const st of clients.values()) {
    if (!st.playerId) continue;
    try {
      const s = sim.snapshot(st.playerId);
      if (s) send(st.ws, { t: 'snap', ...s });
    } catch (err) {
      console.error('[snap] player', st.playerId, 'failed:', err);
    }
  }
}

setInterval(() => {
  try {
    doTick();
  } catch (err) {
    // One bad tick must never kill the server.
    console.error('[tick] fatal:', err);
  }
}, TICK_MS);

httpServer.listen(PORT, () => {
  console.log(`hordes3d listening on port ${PORT} (${TICK_MS}ms tick)`);
});
