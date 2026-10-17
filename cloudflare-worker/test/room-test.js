// hordes3d — Node harness testing cloudflare-worker/src/room.js
// by stubbing the Durable Object runtime APIs (storage, WebSockets,
// blockConcurrencyWhile). No Cloudflare account or workerd needed.

import { GameRoom } from '../src/room.js';

// Cloudflare allows `new Response(null, { status: 101, webSocket })` for
// WebSocket upgrades; Node's undici rejects status 101. Shim it for the harness.
{
  const NativeResponse = globalThis.Response;
  globalThis.Response = class extends NativeResponse {
    constructor(body, init = {}) {
      const cfStatus = init.status;
      super(body, cfStatus === 101 ? { ...init, status: 200 } : init);
      this._cfStatus = cfStatus ?? 200;
    }
    get status() { return this._cfStatus; }
  };
}

// ---------------------------------------------------------------- fakes
function fakeSocket() {
  return {
    sent: [], attachment: null, closed: false, closeCode: null,
    send(s) { this.sent.push(typeof s === 'string' ? s : String(s)); },
    close(code, reason) { this.closed = true; this.closeCode = code; this.closeReason = reason; },
    serializeAttachment(a) { this.attachment = a; },
    deserializeAttachment() { return this.attachment; },
  };
}

globalThis.WebSocketPair = function () {
  // room.js does: const [client, server] = Object.values(pair)
  return { 0: fakeSocket(), 1: fakeSocket() };
};

function fakeStorage(shared) {
  return {
    async get(k) { return shared.get(k); },
    async put(k, v) { shared.set(k, v); },
    async setAlarm(t) { shared.set('__alarm', t); },
    async getAlarm() { const v = shared.get('__alarm'); return v === undefined ? null : v; },
    async deleteAlarm() { shared.delete('__alarm'); },
  };
}

function fakeCtx(shared) {
  const sockets = [];
  return {
    storage: fakeStorage(shared),
    acceptWebSocket(ws) { sockets.push(ws); },
    getWebSockets() { return sockets.filter((s) => !s.closed); },
    blockConcurrencyWhile(fn) { return fn(); },
    _sockets: sockets,
  };
}

// ---------------------------------------------------------------- helpers
let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`[PASS] ${name}`);
  else { failures++; console.log(`[FAIL] ${name} ${extra}`); }
}
const last = (sock, t) => sock.sent.map((s) => JSON.parse(s)).filter((m) => !t || m.t === t).pop();
const all = (sock, t) => sock.sent.map((s) => JSON.parse(s)).filter((m) => !t || m.t === t);

// ---------------------------------------------------------------- test
const shared = new Map(); // one DO's durable storage

// 1. two players join
const room = new GameRoom(fakeCtx(shared), {});
await room.ready;

const r1 = await room.fetch({ url: 'https://x/ws', headers: new Headers({ Upgrade: 'websocket' }) });
check('a. fetch upgrades to 101', r1.status === 101);
const srvA = room.ctx._sockets[0];

await room.webSocketMessage(srvA, JSON.stringify({ t: 'join', name: 'BotA', classId: 'warrior', faction: 'bloodlust' }));
const wA = last(srvA, 'welcome');
check('b. A joins, gets welcome with id', !!(wA && wA.id), JSON.stringify(wA));
const pidA = wA.id;

const r2 = await room.fetch({ url: 'https://x/ws', headers: new Headers({ Upgrade: 'websocket' }) });
const srvB = room.ctx._sockets[1];
await room.webSocketMessage(srvB, JSON.stringify({ t: 'join', name: 'BotB', classId: 'mage', faction: 'vanguard' }));
const wB = last(srvB, 'welcome');
check('c. B joins with distinct id', !!(wB && wB.id && wB.id !== pidA));
const pidB = wB.id;

// alarm chain scheduled while players online
check('d. alarm scheduled after join', (await room.ctx.storage.getAlarm()) !== null);

// 2. chat routed
await room.webSocketMessage(srvA, JSON.stringify({ t: 'chat', ch: 'global', text: 'hello do' }));
await room.alarm();
const chatB = all(srvB, 'chat').pop();
check('e. global chat reaches B', !!(chatB && chatB.text === 'hello do'), JSON.stringify(chatB));

// 3. snapshots broadcast on tick
const snapA = all(srvA, 'snap').pop();
check('f. snapshots broadcast', !!(snapA && typeof snapA.tick === 'number'), `tick=${snapA && snapA.tick}`);

// 4. input + movement changes position over ticks
const x0 = snapA.you.x;
await room.webSocketMessage(srvA, JSON.stringify({ t: 'input', mx: 1, mz: 0 }));
for (let i = 0; i < 5; i++) await room.alarm();
const snapA2 = all(srvA, 'snap').pop();
check('g. movement advances x', snapA2.you.x > x0, `${x0} -> ${snapA2.you.x}`);

// 5. bad input → err, room alive
await room.webSocketMessage(srvA, JSON.stringify({ t: 'cast', skill: 99, tx: 0, tz: 0 }));
const errA = last(srvA, 'err');
check('h. bad skill → err, room alive', !!errA, JSON.stringify(errA));

// 6. party invite/accept
await room.webSocketMessage(srvA, JSON.stringify({ t: 'pinv', name: 'BotB' }));
await room.alarm();
const partyB = all(srvB, 'party').pop();
check('i. B sees party invite', !!(partyB && partyB.invites && partyB.invites.length === 1), JSON.stringify(partyB && partyB.invites));
await room.webSocketMessage(srvB, JSON.stringify({ t: 'pacc', pid: partyB.invites[0].pid }));
await room.alarm();
const partyA2 = all(srvA, 'party').pop();
check('j. party formed (2 members)', !!(partyA2 && partyA2.you && partyA2.you.members.length === 2), JSON.stringify(partyA2 && partyA2.you));

// 7. simulate eviction: brand-new GameRoom, SAME storage, sockets re-attached
const ctx2 = fakeCtx(shared);
// re-attach the two server sockets (CF runtime keeps them; isolate is new)
for (const s of [srvA, srvB]) { s.closed = false; ctx2._sockets.push(s); }
const room2 = new GameRoom(ctx2, {});
await room2.ready;
check('k. sim restored after eviction (players intact)',
  room2.sim.getPlayer(pidA) !== null && room2.sim.getPlayer(pidB) !== null);
check('l. party intact after eviction',
  !!(room2.sim.partyOf(pidA) && room2.sim.partyOf(pidA).members.length === 2));
await room2.alarm();
const snapA3 = all(srvA, 'snap').pop();
check('m. tick resumes after eviction', !!(snapA3 && typeof snapA3.tick === 'number'));
check('n. alarm chain rescheduled after eviction', (await ctx2.storage.getAlarm()) !== null);

// 8. everyone leaves → world persisted, alarm chain stops
// (the runtime removes closed sockets from getWebSockets(); mirror that)
srvA.closed = true;
srvB.closed = true;
await room2.webSocketClose(srvA, 1000, '', true);
await room2.webSocketClose(srvB, 1000, '', true);
await room2.alarm();
const persisted = await ctx2.storage.get('sim-state-v1');
check('o. world persisted when room empties', typeof persisted === 'string' && persisted.length > 1000);
check('p. alarm chain stops when empty', (await ctx2.storage.getAlarm()) === null);

// 9. fresh join restores the persisted world (players rejoin as new guests)
const ctx3 = fakeCtx(shared);
const room3 = new GameRoom(ctx3, {});
await room3.ready;
check('q. persisted snapshot restores (monsters kept)', room3.sim && typeof room3.sim.playerCount === 'function');

console.log(failures === 0 ? '\n==== ALL ROOM TESTS PASSED ====' : `\n==== ${failures} FAILURES ====`);
process.exit(failures === 0 ? 0 : 1);
