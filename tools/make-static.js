// hordes3d — build the static site into dist/ for Vercel / GitHub Pages.
//
// Layout:
//   dist/index.html, dist/config.js, dist/css/*, dist/js/*   (from client/)
//   dist/shared/world.js, dist/shared/protocol.js            (from shared/)
//
// client/js/*.js imports '../shared/world.js' and '../shared/protocol.js',
// so this layout keeps those relative imports working with zero rewriting.
// NOTE: shared/sim.js is NEVER copied (server-side only).

import { rm, mkdir, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const DIST = path.join(ROOT, 'dist');

const SHARED_ALLOW = new Set(['world.js', 'protocol.js']);

async function main() {
  // Clean first.
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // Whole client/ tree verbatim.
  await cp(path.join(ROOT, 'client'), DIST, { recursive: true });

  // Only the two browser-safe shared modules.
  await mkdir(path.join(DIST, 'shared'), { recursive: true });
  for (const f of SHARED_ALLOW) {
    await cp(path.join(ROOT, 'shared', f), path.join(DIST, 'shared', f));
  }

  console.log('static site written to', DIST);
}

main().catch((err) => {
  console.error('make-static failed:', err);
  process.exit(1);
});
