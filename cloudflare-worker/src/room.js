// hordes3d — GameRoom Durable Object (Cloudflare).
//
// One DO = one persistent open world (like hordes.io's single world).
// All game rules live in ../../shared/sim.js (pure ES module, zero Node deps),
// so this file is only an adapter, mirroring server/index.js:
//
//   - WebSocket plumbing via the Hibernation API (acceptWebSocket +
//     serializeAttachment, so sockets survive hibernation/eviction),
//   - C2S messages per shared/protocol.js,
//   - an alarm-driven tick (setInterval is FORBIDDEN here: a scheduled timer
//     blocks hibernation and would bill duration forever),
//   - routing sim events to the right sockets by their `scope`.
//
// Lifecycle: the alarm chain runs at 10Hz only while players are connected.
// When the room empties, the world is persisted to storage, the alarm chain
// stops, and the DO hibernates ($0). The next join restores the world.
//
// Free-tier note: each alarm tick counts as a Durable Object request
// (100k/day free ≈ ~2.5h of active 10Hz play/day). Past the quota the free
// plan fails closed (no surprise billing); Workers Paid ($5/mo) raises it.

import { createSim } from '../../shared/sim.js';

const TICK_MS = 100; // 10Hz — matches the client's 10Hz input heartbeat
const IDLE_TIMEOUT_MS = 90_000;
const PERSIST_KEY = 'sim-state-v1';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sim = null;
    this.lastMsg = new Map(); // playerId -> ms (best-effort; rebuilt lazily)
    this.lastPersist = 0;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const sim = createSim({ now: () => Date.now(), rng: Math.random });
      const saved = await ctx.storage.get(PERSIST_KEY);
      let restored = false;
      if (typeof saved === 'string') {
        try {
          sim.restore(saved);
          restored = true;
        } catch {
          // corrupted snapshot — fall through to a fresh world
        }
      }
      this.sim = sim;
      if (!restored) {
        // Fresh world after eviction: pre-existing sockets reference dead
        // player ids — ask them to rejoin instead of leaving them dangling.
        for (const ws of ctx.getWebSockets()) {
          try {
            ws.send(JSON.stringify({ t: 'err', msg: 'server restarted — please rejoin' }));
          } catch { /* ignore */ }
          try { ws.close(1012, 'restart'); } catch { /* ignore */ }
        }
      } else {
        // Woke with a live world and sockets attached (eviction mid-game):
        // make sure the tick chain is running.
        await this.ensureAlarm();
      }
    });
  }

  // ------------------------------------------------------------ socket helpers
  attachment(ws) {
    try {
      return ws.deserializeAttachment() || {};
    } catch {
      return {};
    }
  }

  pidOf(ws) {
    const a = this.attachment(ws);
    return typeof a.playerId === 'string' ? a.playerId : null;
  }

  // All sockets currently attached to this room.
  sockets() {
    try {
      return this.ctx.getWebSockets();
    } catch {
      return [];
    }
  }

  // playerId -> socket (joined players only).
  socketFor(pid) {
    for (const ws of this.sockets()) {
      if (this.pidOf(ws) === pid) return ws;
    }
    return null;
  }

  send(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch { /* peer gone */ }
  }

  // ------------------------------------------------------------ sim view helpers
  partyView(playerId) {
    try {
      return this.sim.partyOf(playerId);
    } catch {
      return null;
    }
  }

  sendParty(ws, playerId) {
    let invites = [];
    try {
      invites = this.sim
        .pendingInvites(playerId)
        .map(({ pid, from, fromName }) => ({ pid, from, fromName }));
    } catch { /* fall through with empty invites */ }
    this.send(ws, { t: 'party', you: this.partyView(playerId), invites });
  }

  // Expand an event `scope` into the player ids that should receive it.
  scopeTargets(scope) {
    if (scope === 'all') {
      const out = [];
      for (const ws of this.sockets()) {
        const pid = this.pidOf(ws);
        if (pid) out.push(pid);
      }
      return out;
    }
    if (scope && scope.party) {
      const out = [];
      for (const ws of this.sockets()) {
        const pid = this.pidOf(ws);
        if (!pid) continue;
        const p = this.sim.getPlayer(pid);
        if (p && p.partyId === scope.party) out.push(pid);
      }
      return out;
    }
    if (scope && scope.player) {
      return this.socketFor(scope.player) ? [scope.player] : [];
    }
    return [];
  }

  findPlayerIdByName(name) {
    for (const ws of this.sockets()) {
      const pid = this.pidOf(ws);
      if (!pid) continue;
      const p = this.sim.getPlayer(pid);
      if (p && p.name === name) return pid;
    }
    return null;
  }

  playerCount() {
    let n = 0;
    for (const ws of this.sockets()) if (this.pidOf(ws)) n++;
    return n;
  }

  // Route one tick's drained events: `evs` batches, `chat` messages, and
  // `party` view refreshes on membership/invite changes. Scope is stripped
  // before anything reaches the client (per protocol.js).
  routeEvents(events) {
    const perPlayerEvs = new Map(); // playerId -> Ev[] (scope-stripped)
    const chatOut = []; // { id, msg }
    const partyDirty = new Set(); // playerIds needing a fresh { t:'party' }

    for (const ev of events) {
      if (!ev || typeof ev.e !== 'string') continue;

      if (ev.e === 'chat') {
        const msg = { t: 'chat', from: ev.from, ch: ev.ch, text: ev.text };
        for (const id of this.scopeTargets(ev.scope)) chatOut.push({ id, msg });
        continue;
      }

      if (ev.e === 'pinv') {
        const to = ev.scope && ev.scope.player;
        if (to) partyDirty.add(to);
      }

      if (ev.e === 'pjoin' || ev.e === 'pleave' || ev.e === 'pdisband') {
        if (ev.partyId) {
          for (const id of this.scopeTargets({ party: ev.partyId })) partyDirty.add(id);
        }
        const id = this.findPlayerIdByName(ev.pname);
        if (id) partyDirty.add(id);
      }

      const { scope, ...stripped } = ev;
      for (const id of this.scopeTargets(scope)) {
        if (!perPlayerEvs.has(id)) perPlayerEvs.set(id, []);
        perPlayerEvs.get(id).push(stripped);
      }
    }

    for (const [id, list] of perPlayerEvs) {
      const ws = this.socketFor(id);
      if (ws) this.send(ws, { t: 'evs', list });
    }
    for (const { id, msg } of chatOut) {
      const ws = this.socketFor(id);
      if (ws) this.send(ws, msg);
    }
    for (const id of partyDirty) {
      const ws = this.socketFor(id);
      if (ws) this.sendParty(ws, id);
    }
  }

  // ------------------------------------------------------------ C2S messages
  handleMsg(pid, m, ws) {
    const sim = this.sim;
    const fail = (r) => {
      if (r && (r.error || r.ok === false)) {
        this.send(ws, { t: 'err', msg: r.error || r.err || 'error' });
        return true;
      }
      return false;
    };
    switch (m.t) {
      case 'input':
        sim.setInput(pid, { mx: num(m.mx), mz: num(m.mz) });
        break;
      case 'cast':
        fail(sim.castSkill(pid, m.skill, num(m.tx), num(m.tz)));
        break;
      case 'chat':
        fail(sim.sendChat(pid, m.ch, String(m.text ?? '')));
        break;
      case 'pinv':
        fail(sim.inviteParty(pid, String(m.name ?? '')));
        break;
      case 'pacc':
        fail(sim.acceptParty(pid, m.pid));
        break;
      case 'pleave':
        sim.leaveParty(pid);
        break;
      case 'equip':
        fail(sim.equipItem(pid, m.uid));
        break;
      case 'respawn':
        fail(sim.respawn(pid));
        break;
      default:
        break; // unknown message: ignore
    }
  }

  dropPlayer(pid) {
    if (!pid) return;
    this.lastMsg.delete(pid);
    try {
      this.sim.removePlayer(pid);
    } catch { /* ignore */ }
    this.markDirty(); // membership changed → persist on next tick
  }

  // Force a world persist on the next alarm tick (for rare but important
  // state changes; positions are covered by the periodic persist).
  markDirty() {
    this.lastPersist = 0;
  }

  // ------------------------------------------------------------ alarm chain
  // setInterval is forbidden in a hibernatable DO, so the tick is driven by
  // alarms. The chain only runs while players are connected.
  async ensureAlarm() {
    if (this.playerCount() === 0) return;
    let cur = null;
    try {
      cur = await this.ctx.storage.getAlarm();
    } catch { /* ignore */ }
    if (cur === null || cur === undefined || cur <= Date.now()) {
      try {
        await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
      } catch { /* ignore */ }
    }
  }

  async alarm() {
    await this.ready;
    try {
      const nowMs = Date.now();
      let events = [];
      try {
        events = this.sim.tick(nowMs) || [];
      } catch (e) {
        console.error('[tick] sim.tick failed:', e);
      }

      // idle timeout (mirrors the Node adapter's 60s; relaxed to 90s here)
      for (const ws of this.sockets()) {
        const pid = this.pidOf(ws);
        if (!pid) continue;
        const last = this.lastMsg.get(pid) || nowMs;
        if (nowMs - last > IDLE_TIMEOUT_MS) {
          try { ws.close(1000, 'idle'); } catch { /* ignore */ }
          this.dropPlayer(pid);
        }
      }

      this.routeEvents(events);

      for (const ws of this.sockets()) {
        const pid = this.pidOf(ws);
        if (!pid) continue;
        try {
          const s = this.sim.snapshot(pid);
          if (s) this.send(ws, { t: 'snap', ...s });
        } catch (e) {
          console.error('[snap] player', pid, 'failed:', e);
        }
      }
    } catch (e) {
      // One bad tick must never kill the room.
      console.error('[tick] fatal:', e);
    }

    if (this.playerCount() > 0) {
      // Periodic persist so an isolate eviction mid-game (rare while the
      // alarm chain runs, but real on deploys) loses at most ~30s of world.
      if (Date.now() - this.lastPersist > 30_000) {
        this.lastPersist = Date.now();
        try {
          await this.ctx.storage.put(PERSIST_KEY, this.sim.serialize());
        } catch (e) {
          console.error('[persist] periodic failed:', e);
        }
      }
      try {
        await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
      } catch { /* ignore */ }
    } else {
      // Room empty: persist the world, stop the chain, let the DO hibernate.
      try {
        await this.ctx.storage.put(PERSIST_KEY, this.sim.serialize());
      } catch (e) {
        console.error('[persist] failed:', e);
      }
      try {
        await this.ctx.storage.deleteAlarm();
      } catch { /* ignore */ }
    }
  }

  // ------------------------------------------------------------ DO handlers
  async fetch(req) {
    await this.ready;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Hibernation API: the socket survives DO hibernation/eviction.
    // playerId is attached after the {t:'join'} message (serializeAttachment
    // survives hibernation, unlike in-memory maps).
    this.ctx.acceptWebSocket(server);
    await this.ensureAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    await this.ready;
    let m;
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      m = JSON.parse(text);
    } catch {
      return; // malformed: ignore
    }
    if (!m || typeof m.t !== 'string') return;

    let pid = this.pidOf(ws);
    if (!pid) {
      // Pre-join: only { t:'join' } is accepted.
      if (m.t !== 'join') {
        this.send(ws, { t: 'err', msg: 'send join first' });
        return;
      }
      let r;
      try {
        r = this.sim.addPlayer({ name: m.name, classId: m.classId, faction: m.faction });
      } catch {
        this.send(ws, { t: 'err', msg: 'join failed' });
        return;
      }
      if (r.error) {
        this.send(ws, { t: 'err', msg: r.error });
        return;
      }
      pid = r.id;
      try {
        ws.serializeAttachment({ playerId: pid });
      } catch { /* ignore */ }
      this.lastMsg.set(pid, Date.now());
      this.markDirty(); // new player → persist on next tick
      let tickN = 0;
      try {
        const s = this.sim.snapshot(pid);
        if (s && typeof s.tick === 'number') tickN = s.tick;
      } catch { /* ignore */ }
      this.send(ws, { t: 'welcome', id: pid, tick: tickN });
      this.sendParty(ws, pid);
      await this.ensureAlarm();
      return;
    }

    this.lastMsg.set(pid, Date.now());
    try {
      this.handleMsg(pid, m, ws);
    } catch {
      this.send(ws, { t: 'err', msg: 'internal error' });
    }
    // Membership-changing messages persist on the next tick.
    if (m.t === 'pinv' || m.t === 'pacc' || m.t === 'pleave') this.markDirty();
  }

  async webSocketClose(ws, code, reason, wasClean) {
    await this.ready;
    this.dropPlayer(this.pidOf(ws));
    // The alarm chain notices the empty room on its next fire (<=100ms),
    // persists, and stops. No work needed here.
  }

  async webSocketError(ws, error) {
    await this.ready;
    this.dropPlayer(this.pidOf(ws));
  }
}
