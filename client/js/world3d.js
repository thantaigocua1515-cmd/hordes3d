// hordes3d client — THREE scene: terrain, lights, decorations, spawn pads, boss marker.
// Decorations use a local seeded RNG (visual only, never affects gameplay).

import * as THREE from 'three';
import { heightAt, terrainColor, FACTIONS, WORLD } from '../shared/world.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CAM_OFF = new THREE.Vector3(0, 20, 13); // fixed third-person offset

export function createWorld() {
  const mount = document.getElementById('scene');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1020);
  scene.fog = new THREE.Fog(0x0b1020, 60, 175);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 600);

  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x2a2118, 0.85));
  const sun = new THREE.DirectionalLight(0xfff2d9, 1.2);
  sun.position.set(60, 90, 30);
  scene.add(sun);

  // ---- terrain: 220x220 plane, 110x110 segments, displaced by shared heightAt ----
  const size = WORLD.size, seg = 110;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = heightAt(x, z);
    pos.setY(i, h);
    const slope = Math.abs(heightAt(x + 1, z) - heightAt(x - 1, z)) / 2
                + Math.abs(heightAt(x, z + 1) - heightAt(x, z - 1)) / 2;
    const c = terrainColor(h, Math.min(1, slope));
    colors[i * 3] = c[0]; colors[i * 3 + 1] = c[1]; colors[i * 3 + 2] = c[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  scene.add(terrain);

  // ---- decorations (seeded, visual only) ----
  const rng = mulberry32(1337);
  const sp1 = FACTIONS.bloodlust.spawn, sp2 = FACTIONS.vanguard.spawn;
  function clearOfSpots(x, z) {
    if (Math.hypot(x - sp1.x, z - sp1.z) < 30) return false;
    if (Math.hypot(x - sp2.x, z - sp2.z) < 30) return false;
    if (Math.hypot(x, z) < 34) return false; // boss arena
    return true;
  }
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5d4037, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 1 });
  const leafMat2 = new THREE.MeshStandardMaterial({ color: 0x388e3c, roughness: 1 });
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x757575, roughness: 1 });
  const treeTrunk = new THREE.CylinderGeometry(0.35, 0.5, 2.2, 6);
  const treeTop = new THREE.ConeGeometry(2.0, 4.5, 7);
  const rockGeo = new THREE.IcosahedronGeometry(1, 0);

  let placed = 0, guard = 0;
  while (placed < 46 && guard++ < 600) { // trees
    const x = (rng() * 2 - 1) * 104, z = (rng() * 2 - 1) * 104;
    if (!clearOfSpots(x, z)) continue;
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(treeTrunk, trunkMat); trunk.position.y = 1.1; g.add(trunk);
    const top = new THREE.Mesh(treeTop, rng() < 0.5 ? leafMat : leafMat2);
    top.position.y = 4.2; top.rotation.y = rng() * Math.PI; g.add(top);
    const s = 0.8 + rng() * 0.9;
    g.scale.set(s, s, s);
    g.position.set(x, heightAt(x, z), z);
    scene.add(g);
    placed++;
  }
  placed = 0; guard = 0;
  while (placed < 26 && guard++ < 600) { // rocks
    const x = (rng() * 2 - 1) * 104, z = (rng() * 2 - 1) * 104;
    if (!clearOfSpots(x, z)) continue;
    const r = new THREE.Mesh(rockGeo, rockMat);
    const s = 0.5 + rng() * 1.4;
    r.scale.set(s, s * 0.75, s);
    r.rotation.y = rng() * Math.PI;
    r.position.set(x, heightAt(x, z) + 0.2, z);
    scene.add(r);
    placed++;
  }

  // ---- faction spawn pads: colored rings ----
  for (const f of Object.values(FACTIONS)) {
    const y = heightAt(f.spawn.x, f.spawn.z);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(WORLD.safeRadius - 1.2, WORLD.safeRadius, 40),
      new THREE.MeshBasicMaterial({ color: f.color, transparent: true, opacity: 0.55, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(f.spawn.x, y + 0.15, f.spawn.z);
    scene.add(ring);
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(3, 24),
      new THREE.MeshBasicMaterial({ color: f.color, transparent: true, opacity: 0.35 })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(f.spawn.x, y + 0.12, f.spawn.z);
    scene.add(disc);
  }

  // ---- boss arena marker at (0,0) ----
  {
    const y = heightAt(0, 0);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(11.4, 12.6, 48),
      new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.7, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, y + 0.15, 0);
    scene.add(ring);
    // 8 obsidian pillars around the arena
    const pillarGeo = new THREE.BoxGeometry(1.6, 7, 1.6);
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x1c1c26, roughness: 0.6 });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const px = Math.cos(a) * 16, pz = Math.sin(a) * 16;
      const p = new THREE.Mesh(pillarGeo, pillarMat);
      p.position.set(px, heightAt(px, pz) + 3.5, pz);
      scene.add(p);
    }
  }

  const v3 = new THREE.Vector3();
  function project(x, y, z) {
    v3.set(x, y, z).project(camera);
    return {
      x: (v3.x * 0.5 + 0.5) * window.innerWidth,
      y: (-v3.y * 0.5 + 0.5) * window.innerHeight,
      behind: v3.z > 1,
    };
  }

  function updateCamera(px, py, pz) {
    const cx = Math.max(-104, Math.min(104, px));
    const cz = Math.max(-104, Math.min(104, pz));
    camera.position.set(cx + CAM_OFF.x, py + CAM_OFF.y, cz + CAM_OFF.z);
    camera.lookAt(cx, py + 1.2, cz);
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return {
    scene, camera, renderer, terrain,
    groundY: (x, z) => heightAt(x, z),
    project,
    updateCamera,
    render: () => renderer.render(scene, camera),
    dom: renderer.domElement,
  };
}
