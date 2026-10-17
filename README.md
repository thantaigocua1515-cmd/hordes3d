# hordes3d — 3D browser MMORPG MVP

An **original** 3D browser MMORPG in the spirit of hordes.io's early alpha:
*“MMO, reduced to its absolute MVP form.”* All code and art are written from
scratch for this project — no copied code, assets, or branding.

**MVP scope:** 1 small open world · 4 classes × 4 skills · 2 factions with
open-world PvP · monsters + elites + 1 world boss · loot with 5 qualities ·
basic parties · global/party chat · guest names (no accounts yet).

## Architecture

```
hordes3d/
├── shared/
│   ├── protocol.js   # network message/event shapes (client <-> server)
│   ├── world.js      # world constants, classes, skills, factions, loot tables
│   └── sim.js        # ★ ALL game simulation — pure ES module, ZERO Node deps
├── server/
│   └── index.js      # thin adapter: Node + ws, static files (dev), 20Hz tick
├── client/           # 100% static: HTML/CSS/JS, Three.js via CDN importmap
│   ├── index.html  config.js  css/  js/
├── tools/
│   └── make-static.js# copies client + shared/{world,protocol}.js -> dist/
├── test/
│   └── smoke.js      # bot smoke test (pure Node, no browser)
└── docs/
    └── SIM_CONTRACT.md
```

**The key design decision:** every game rule — movement, combat, skills,
monster AI, boss patterns, loot, XP, factions, parties — lives in
`shared/sim.js`, which imports nothing but `./protocol.js` and `./world.js`.
Time and randomness are injected (`createSim({ now, rng })`), so the exact
same module runs in plain Node today and in a Cloudflare Durable Object
tomorrow, unchanged. The `server/` folder is only networking + the tick loop.

## Run locally

```bash
cd hordes3d
npm install
npm start        # listens on http://localhost:3000 (PORT env to change)
```

Open http://localhost:3000, pick a name, class, and faction, and play.
Open a second tab to test PvP/parties with yourself.

## Controls

| Input | Action |
|---|---|
| WASD / arrows | Move |
| 1 – 4 | Cast skill (ranged skills: click ground to aim, right-click/Esc cancels) |
| Left click on a character | Target (shows target frame) |
| Enter | Chat (Tab or `/p` toggles global/party) |
| I | Inventory (click an item to equip) |
| Mouse wheel | (camera is fixed-follow in MVP) |

## Deploy (no VPS required)

The game splits into two pieces that deploy separately:

```
CLIENT (static)                    SERVER (persistent world)
Vercel / GitHub Pages              Cloudflare Durable Objects (recommended)
                                   — or Render (free) / Fly.io (~$2/mo)
```

### Recommended: server → Cloudflare Durable Objects

Free tier, no credit card, no VPS. One Durable Object = one persistent open
world; it hibernates ($0) when nobody plays and the world is persisted.

See **[cloudflare-worker/HUONG-DAN.md](cloudflare-worker/HUONG-DAN.md)**
(Vietnamese step-by-step). Short version:

```bash
npm install -g wrangler && wrangler login
cd cloudflare-worker && npm install
npx wrangler deploy   # → https://hordes3d.<account>.workers.dev
```

Game WebSocket URL: `wss://hordes3d.<account>.workers.dev/ws`

How it works: `cloudflare-worker/src/room.js` (GameRoom DO) imports the
**same** `shared/sim.js` as the Node server — zero game-logic duplication.
The tick is alarm-driven at 10Hz (`setInterval` is forbidden in a
hibernatable DO), state persists to DO storage on a 30s cadence + on
membership changes + when the room empties. Tested in
`cloudflare-worker/test/room-test.js` (17/17 PASS in Node with stubbed
DO APIs: join, chat, snapshots, movement, party, eviction→restore,
empty→persist→hibernate).

Free-tier note: 100k DO requests/day ≈ 2–3h of active 10Hz play/day.
The free plan fails closed past quota (no surprise billing).

### 1. Client → Vercel (static)

1. Push this repo to GitHub.
2. Vercel dashboard → **Add New → Project** → import the repo.
3. Build & Output settings:
   - **Build Command:** `npm run make-static`
   - **Output Directory:** `dist`
   - (Install Command stays `npm install`; no env vars needed.)
4. Deploy → you get `https://<your-project>.vercel.app`.

The client finds the game server via `client/config.js`:

1. `?server=wss://your-server.example.com` query param (saved to localStorage), or
2. a saved override (editable in the login screen's *Server* field), or
3. default: the same host the page was served from (`ws(s)://location.host`).

So the same `dist/` works against any server without rebuilding — after
deploying the server below, just open
`https://<your-project>.vercel.app/?server=wss://<your-server-host>` once,
or type the server URL into the login screen's *Server* field.

GitHub Pages alternative: enable Pages on the repo serving the `dist/`
folder (build it locally with `npm run make-static` and commit, or use a
GitHub Action).

### Alternative: server → Render / Fly.io (plain Node process)

Prefer not to use Cloudflare? The original Node adapter (`server/index.js`,
20Hz tick, serves the client too for local dev) still works everywhere
(a single persistent Node process with one npm dependency, `ws`).
Note: it is *not* suitable for Vercel Functions (message-driven, billed per
active CPU — a poor fit for a continuous authoritative tick).

**Option A — Render (free, no credit card):**

1. Render dashboard → **New → Blueprint** → connect this repo
   (uses `render.yaml` in the repo root).
2. Deploy → you get `https://hordes3d-server.onrender.com`.
3. Client URL becomes
   `https://<your-project>.vercel.app/?server=wss://hordes3d-server.onrender.com`.

Caveat: free Render services **sleep after 15 min idle** and take ~1 min to
wake — fine for testing with friends, annoying for real play.

**Option B — Fly.io (~$2/month, credit card required):**

1. Install flyctl: https://fly.io/docs/flyctl/install, then `fly auth login`.
2. In the repo root: `fly launch` (reuses the committed `fly.toml`;
   pick a unique app name, region `sin` = Singapore is pre-set).
3. `fly deploy` → you get `https://<app-name>.fly.dev`.
4. Client URL: `https://<your-project>.vercel.app/?server=wss://<app-name>.fly.dev`.

The committed `fly.toml` auto-stops the machine when idle to save money and
wakes on the next visit.

**Option C — any VPS / your own machine:**

```bash
npm install
PORT=3000 npm start
```

### Later

The same `shared/sim.js` can move into a Cloudflare Durable Object room
server with no game-logic changes — only the thin adapter is replaced.

## What's MVP vs planned

**In (MVP):** everything listed at the top, plus safe spawn zones, fame +
gold-steal on PvP kills, shared party XP, elite monsters, boss telegraphs,
auto-loot, damage numbers, minimap, death/respawn.

**Phase 2 (not built):** accounts + persistent characters/DB, item trading
between players, clans, mounts, quests/tutorial, more zones/bosses, anti-cheat
beyond authoritative sim, client-side prediction, sound, mobile controls.

## Verification

Run in sandbox 2026-10-17 — all passing:

- `node --check` on all 15 JS files (shared ×3, server, client ×8, tools, test): **PASS**
- `npm install` (ws 8.x): **PASS**; `node server/index.js` boots, serves `/`, `/shared/*`, `/js/*` over HTTP with 200s: **PASS**
- `npm test` (bot smoke test, real WebSockets on loopback, ~45s): **PASS 7/7**
  - join → distinct ids; movement (x −80 → −72.5); global chat delivered
  - party invite → accept, 2 members, correct leader
  - PvE: warrior bot killed monster `m7`, xp 0 → 8, `{e:'die'}` observed
  - PvP: cross-faction kill at neutral ground → fame 0 → 12, victim gold 11 → 10 (10% steal), death + respawn works
  - bad input (`cast skill:99`, invite unknown name) → `{t:'err'}`, server keeps ticking
- `npm run make-static`: **PASS** — `dist/` has `index.html`, `config.js`, `css/`, `js/`, `shared/{world,protocol}.js`; no `sim.js`, no server files
- Sim isolation: **PASS** — `shared/` has zero Node-only imports, no timers, no `Date.now()`/`Math.random()` (injected `now`/`rng` only)

**NOT verified here:** actual browser rendering (no WebGL in sandbox) —
needs Khang to open the page in a real browser. Client code is syntax-checked
only; gameplay visuals (terrain, models, skill fx, HUD) are untested.
