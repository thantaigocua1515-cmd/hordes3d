// hordes3d client — keyboard/mouse input: WASD movement (10Hz), skill keys with
// point-targeting mode, click-to-target, I inventory, Enter chat.

import * as THREE from 'three';
import { SKILLS } from '../shared/world.js';

const INSTANT_RANGE_ZERO = true; // range==0 skills cast immediately; range>0 -> targeting mode

export function createInput(o) {
  // o: { dom, camera, terrain, getPlayer()->{x,y,z}|null, classId,
  //      pickEntity(nx,ny)->entId|null, onMove(mx,mz), onCast(skill,tx,tz),
  //      onTarget(entId|null), onToggleInventory(), onChatKey(), onCancelTargeting(), setTargeting(bool) }
  const keys = {};
  let moveVec = { x: 0, z: 0 };
  let sentVec = { x: 9, z: 9 };
  let targeting = null; // { skill, def }
  const ray = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ndc = new THREE.Vector2();

  let ghost = null;
  function ensureGhost() {
    if (ghost) return ghost;
    ghost = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.1, 32),
      new THREE.MeshBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
    );
    ghost.rotation.x = -Math.PI / 2;
    ghost.visible = false;
    o.scene.add(ghost);
    return ghost;
  }

  function skillDef(i) { return (SKILLS[o.classId] || [])[i]; }

  function computeMove() {
    let x = 0, z = 0;
    if (keys.KeyA || keys.ArrowLeft) x -= 1;
    if (keys.KeyD || keys.ArrowRight) x += 1;
    if (keys.KeyW || keys.ArrowUp) z -= 1;   // camera looks toward -z, so up = -z
    if (keys.KeyS || keys.ArrowDown) z += 1;
    const l = Math.hypot(x, z);
    if (l > 1) { x /= l; z /= l; }
    moveVec = { x, z };
  }

  function maybeSendMove(force) {
    if (force || moveVec.x !== sentVec.x || moveVec.z !== sentVec.z) {
      sentVec = { ...moveVec };
      o.onMove(moveVec.x, moveVec.z);
    }
  }
  const moveTimer = setInterval(() => maybeSendMove(false), 100); // 10Hz heartbeat

  function groundPoint(clientX, clientY) {
    const p = o.getPlayer();
    if (!p) return null;
    ndc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, o.camera);
    groundPlane.constant = -p.y;
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(groundPlane, hit)) return null;
    return hit;
  }

  function startTargeting(skill) {
    const def = skillDef(skill);
    if (!def) return;
    if (INSTANT_RANGE_ZERO && def.range === 0) { // instant: cast at own position
      const p = o.getPlayer();
      if (p) o.onCast(skill, p.x, p.z);
      return;
    }
    targeting = { skill, def };
    const g = ensureGhost();
    g.visible = true;
    o.setTargeting(true);
  }
  function cancelTargeting() {
    if (!targeting) return;
    targeting = null;
    if (ghost) ghost.visible = false;
    o.setTargeting(false);
  }

  function onKeyDown(e) {
    if (e.repeat) return;
    const typing = o.isTyping && o.isTyping();
    if (typing) return; // chat / inputs handle their own keys
    keys[e.code] = true;
    if (e.code.startsWith('Key') || e.code.startsWith('Arrow')) { computeMove(); maybeSendMove(true); }
    if (targeting && e.code === 'Escape') { cancelTargeting(); return; }
    if (e.code === 'Enter') { o.onChatKey(); return; }
    if (e.code === 'KeyI') { o.onToggleInventory(); return; }
    const m = /^Digit([1-4])$/.exec(e.code);
    if (m) {
      const i = Number(m[1]) - 1;
      if (targeting && targeting.skill === i) { cancelTargeting(); return; }
      cancelTargeting();
      startTargeting(i);
    }
  }
  function onKeyUp(e) {
    keys[e.code] = false;
    if (e.code.startsWith('Key') || e.code.startsWith('Arrow')) { computeMove(); maybeSendMove(true); }
  }

  function onMouseMove(e) {
    if (!targeting) return;
    const hit = groundPoint(e.clientX, e.clientY);
    if (!hit) return;
    const p = o.getPlayer();
    const def = targeting.def;
    // clamp to skill range
    const dx = hit.x - p.x, dz = hit.z - p.z;
    const d = Math.hypot(dx, dz);
    const maxR = def.range || 5;
    const k = d > maxR ? maxR / d : 1;
    const tx = p.x + dx * k, tz = p.z + dz * k;
    const g = ensureGhost();
    const r = def.radius || 1.6;
    g.scale.set(r, r, 1);
    g.position.set(tx, o.terrainY(tx, tz) + 0.25, tz);
    g.userData.tx = tx; g.userData.tz = tz;
  }

  function onMouseDown(e) {
    if (e.button === 2) { cancelTargeting(); return; } // right-click cancels
    if (e.button !== 0) return;
    if (targeting) {
      const g = ghost;
      if (g && g.userData.tx !== undefined) {
        const { skill } = targeting;
        const tx = g.userData.tx, tz = g.userData.tz;
        cancelTargeting();
        o.onCast(skill, tx, tz);
      }
      return;
    }
    // click entity to target
    const id = o.pickEntity(e.clientX, e.clientY);
    o.onTarget(id);
  }

  function onContextMenu(e) { e.preventDefault(); }

  o.dom.addEventListener('mousemove', onMouseMove);
  o.dom.addEventListener('mousedown', onMouseDown);
  o.dom.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  return {
    cancelTargeting,
    isTargeting: () => !!targeting,
    destroy() {
      clearInterval(moveTimer);
      o.dom.removeEventListener('mousemove', onMouseMove);
      o.dom.removeEventListener('mousedown', onMouseDown);
      o.dom.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      if (ghost) o.scene.remove(ghost);
    },
  };
}
