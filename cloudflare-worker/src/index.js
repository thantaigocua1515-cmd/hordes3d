// hordes3d — Cloudflare Worker entry point.
// Routes WebSocket upgrades to the single GameRoom Durable Object.
// The game client (static, on Vercel/Pages) connects to wss://<worker-host>/ws.

import { GameRoom } from './room.js';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/ws' || url.pathname === '/ws/') {
      if (req.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected a WebSocket upgrade request.', { status: 426 });
      }
      // One shared world (like hordes.io's open world). Shard later by using
      // idFromName('world-2'), etc.
      const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName('world-1'));
      return stub.fetch(req);
    }
    if (url.pathname === '/health') return new Response('ok');
    return new Response('hordes3d room server — connect with a WebSocket client at /ws', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};

export { GameRoom };
