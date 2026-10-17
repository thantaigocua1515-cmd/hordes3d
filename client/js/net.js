// hordes3d client — WebSocket wrapper with snapshot jitter buffer + auto-reconnect.
// Dispatches: 'open' 'welcome' 'snap' 'ev' 'chat' 'party' 'err' 'close' 'reconnecting' 'dead'.

import { TICK_MS } from '../shared/protocol.js';

const MAX_TRIES = 5;
const RENDER_DELAY_MS = 100; // interpolate snapshots 100ms in the past

export function createNet() {
  const subs = {};
  const snaps = []; // ring buffer of recent snapshots {tick,you,ents,teles,recv}
  let ws = null, url = null, tries = 0, manualClose = false, retryTimer = 0;

  function emit(t, d) { const l = subs[t]; if (l) for (const f of l) { try { f(d); } catch (e) { console.error(e); } } }
  function on(t, fn) { (subs[t] = subs[t] || []).push(fn); }

  function open() {
    let s;
    try { s = new WebSocket(url); } catch (e) { scheduleRetry(); return; }
    ws = s;
    s.onopen = () => { tries = 0; emit('open'); };
    s.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch (e) { return; }
      route(msg);
    };
    s.onclose = () => { ws = null; emit('close'); scheduleRetry(); };
    s.onerror = () => { /* onclose follows */ };
  }

  function scheduleRetry() {
    if (manualClose) return;
    tries++;
    if (tries > MAX_TRIES) { emit('dead', 'Connection failed after 5 attempts. Check the server URL.'); return; }
    emit('reconnecting', tries);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, 600 * tries);
  }

  function route(m) {
    switch (m.t) {
      case 'welcome': emit('welcome', m); break;
      case 'snap':
        m.recv = performance.now();
        snaps.push(m);
        if (snaps.length > 8) snaps.shift();
        emit('snap', m);
        break;
      case 'evs': for (const e of m.list || []) emit('ev', e); break;
      case 'chat': emit('chat', m); break;
      case 'party': emit('party', m); break;
      case 'err': emit('err', m); break;
    }
  }

  function latest() { return snaps[snaps.length - 1] || null; }

  // Interpolated render frame. Entities/you are lerped between the two snaps
  // bracketing (now - RENDER_DELAY_MS); HUD fields (hp, cds, inv) come from latest().
  function frame() {
    if (!snaps.length) return null;
    const now = performance.now(), target = now - RENDER_DELAY_MS;
    let a = snaps[0], b = snaps[snaps.length - 1];
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].recv <= target) { a = snaps[i]; b = snaps[Math.min(i + 1, snaps.length - 1)]; break; }
    }
    const span = Math.max(1, b.recv - a.recv);
    const k = Math.min(1, Math.max(0, (target - a.recv) / span));
    const am = new Map(a.ents.map(e => [e.id, e]));
    const ents = [];
    for (const be of b.ents) {
      const ae = am.get(be.id);
      ents.push(ae
        ? { ...be, x: ae.x + (be.x - ae.x) * k, y: ae.y + (be.y - ae.y) * k, z: ae.z + (be.z - ae.z) * k }
        : be);
    }
    const ay = a.you, by = b.you;
    const you = { ...by, x: ay.x + (by.x - ay.x) * k, y: ay.y + (by.y - ay.y) * k, z: ay.z + (by.z - ay.z) * k };
    return { ents, you, teles: b.teles || [] };
  }

  // Estimated sim clock (ms) — for telegraph `until` timestamps.
  function simNow() {
    const s = latest();
    if (!s) return 0;
    return s.tick * TICK_MS + (performance.now() - s.recv);
  }

  return {
    on,
    connect(u) { manualClose = false; tries = 0; url = u; snaps.length = 0; clearTimeout(retryTimer); open(); },
    disconnect() { manualClose = true; clearTimeout(retryTimer); if (ws) { try { ws.close(); } catch (e) {} } ws = null; },
    send(o) { if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify(o)); } catch (e) {} } },
    latest,
    frame,
    simNow,
  };
}
