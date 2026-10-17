// hordes3d client — combat FX: skill visuals from `cast` events, telegraph rings,
// floating damage/heal numbers, death flashes. All shapes are original code-built geometry.

import * as THREE from 'three';
import { SKILLS } from '../shared/world.js';

function mat(color, opacity = 1) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
}

export function createFx(scene, world, entities) {
  const floatLayer = document.getElementById('floaters');
  const live = [];     // { obj, born, life, tick }
  const floaters = []; // { el, born, life, x, y, z, vy }
  const teles = new Map(); // teleId -> mesh

  const now = () => performance.now();
  function addTemp(obj, life, tick) {
    scene.add(obj);
    live.push({ obj, born: now(), life, tick });
  }
  function ground(x, z) { return world.groundY(x, z); }

  function update(dt) {
    const t = now();
    for (let i = live.length - 1; i >= 0; i--) {
      const f = live[i];
      const k = (t - f.born) / 1000 / f.life;
      if (k >= 1) { scene.remove(f.obj); live.splice(i, 1); continue; }
      if (f.tick) f.tick(k, f.obj);
    }
    // floating combat text rises and fades
    const proj = world.project;
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      const k = (t - f.born) / 1000 / f.life;
      if (k >= 1) { f.el.remove(); floaters.splice(i, 1); continue; }
      f.y += f.vy * dt;
      const p = proj(f.x, f.y, f.z);
      if (p.behind) { f.el.style.display = 'none'; continue; }
      f.el.style.display = 'block';
      f.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%,-50%) scale(${(1 + k * 0.3).toFixed(2)})`;
      f.el.style.opacity = String(1 - k * k);
    }
  }

  function floater(x, y, z, text, cls) {
    const el = document.createElement('div');
    el.className = 'floater ' + cls;
    el.textContent = text;
    floatLayer.appendChild(el);
    floaters.push({ el, born: now(), life: 1.1, x, y, z, vy: 3.2 });
    if (floaters.length > 40) { const f = floaters.shift(); f.el.remove(); }
  }

  // ---- public event handlers ----
  function onCast(ev) {
    const pos = entities.getPos(ev.id);
    if (!pos) return;
    const def = (SKILLS[ev.cls] || [])[ev.skill];
    if (!def) { ringFx(pos.x, pos.z, 2, 0xffffff, 0.4); return; }
    const dx = ev.tx - pos.x, dz = ev.tz - pos.z;
    const dist = Math.hypot(dx, dz) || 0.001;
    const dir = { x: dx / dist, z: dz / dist };
    const ang = Math.atan2(dx, dz);
    switch (def.kind) {
      case 'melee': slashFx(pos, ang); break;
      case 'proj': projectileFx(pos, ev.tx, ev.tz, def); break;
      case 'aoe_self': ringFx(pos.x, pos.z, def.radius || 6, 0x7fd4ff, 0.6); break;
      case 'aoe_point': blastTelegraph(ev.tx, ev.tz, def); break;
      case 'line': beamFx(pos, dir, Math.min(dist, def.range || 24), 0xffb74d, def.width || 2.6); break;
      case 'cone': coneFx(pos, ang, def); break;
      case 'dash': dashFx(pos, dir, def); break;
      case 'blink': blinkFx(pos, ev.tx, ev.tz); break;
      case 'chain': lightningFx(pos, ev.tx, ev.tz); break;
      case 'heal': healFx(ev.tx, ev.tz, 2); break;
      case 'hot': healFx(ev.tx, ev.tz, def.radius || 7); break;
      case 'debuff': beamFx(pos, dir, dist, 0x9b59b6, 1.6); break;
      case 'buff': ringFx(pos.x, pos.z, 3.2, 0xffd75e, 0.7); break;
      default: ringFx(pos.x, pos.z, 2, 0xffffff, 0.4);
    }
  }

  function onDmg(ev) {
    const p = entities.getPos(ev.to);
    if (!p) return;
    floater(p.x, p.y + 3, p.z, (ev.crit ? 'CRIT ' : '') + ev.amt, ev.crit ? 'crit' : 'dmg');
  }
  function onHeal(ev) {
    const p = entities.getPos(ev.to);
    if (!p) return;
    floater(p.x, p.y + 3, p.z, '+' + ev.amt, 'heal');
  }
  function onDie(ev) {
    entities.fadeOut(ev.id);
    const p = entities.getPos(ev.id);
    if (p) ringFx(p.x, p.z, 2.5, 0xff3b30, 0.5);
  }
  function onLvl(ev) {
    const p = entities.getPos(ev.id);
    if (p) {
      ringFx(p.x, p.z, 3, 0xffd75e, 0.8);
      floater(p.x, p.y + 3.4, p.z, 'LEVEL ' + ev.lvl, 'lvl');
    }
  }

  // ---- shape builders ----
  function flat(geo, x, z, color, opacity, yOff = 0.25) {
    const m = new THREE.Mesh(geo, mat(color, opacity));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, ground(x, z) + yOff, z);
    return m;
  }

  function ringFx(x, z, r, color, life) {
    const m = flat(new THREE.RingGeometry(r * 0.7, r, 32), x, z, color, 0.9);
    addTemp(m, life, (k, o) => {
      const s = 0.6 + k * 0.7;
      o.scale.set(s, s, 1);
      o.material.opacity = 0.9 * (1 - k);
    });
  }

  function slashFx(pos, ang) {
    const m = flat(new THREE.TorusGeometry(2.3, 0.3, 8, 16, Math.PI * 0.85), pos.x, pos.z, 0xffe9a8, 0.95, 1.2);
    m.rotation.z = ang + Math.PI * 0.1;
    addTemp(m, 0.28, (k, o) => { o.material.opacity = 0.95 * (1 - k); });
  }

  function projectileFx(pos, tx, tz, def) {
    const color = { fireball: 0xff6b35 }[def.id] || 0xbfe9ff;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), mat(color, 1));
    const sx = pos.x, sy = pos.y + 1.6, sz = pos.z;
    const dist = Math.hypot(tx - sx, tz - sz);
    const dur = Math.min(0.9, Math.max(0.15, dist / (def.projSpeed || 24)));
    ball.position.set(sx, sy, sz);
    addTemp(ball, dur, (k, o) => {
      o.position.set(sx + (tx - sx) * k, sy + (ground(tx, tz) + 1 - sy) * k, sz + (tz - sz) * k);
    });
    // impact burst
    setTimeout(() => ringFx(tx, tz, 2, color, 0.35), dur * 1000);
  }

  function blastTelegraph(x, z, def) {
    const m = flat(new THREE.RingGeometry((def.radius || 5) - 0.7, def.radius || 5, 32), x, z, 0xff5252, 0.8);
    const delay = def.delay || 1;
    addTemp(m, delay, (k, o) => { o.material.opacity = 0.4 + 0.4 * Math.sin(performance.now() / 90); });
    setTimeout(() => {
      ringFx(x, z, def.radius || 5, 0xffa726, 0.5);
      const flash = flat(new THREE.CircleGeometry(def.radius || 5, 24), x, z, 0xffcc80, 0.7, 0.3);
      addTemp(flash, 0.3, (k, o) => { o.material.opacity = 0.7 * (1 - k); });
    }, delay * 1000);
  }

  function beamFx(pos, dir, len, color, width) {
    const geo = new THREE.BoxGeometry(width, 0.5, len);
    const m = new THREE.Mesh(geo, mat(color, 0.85));
    const y = ground(pos.x, pos.z) + 1.4;
    m.position.set(pos.x + dir.x * len / 2, y, pos.z + dir.z * len / 2);
    m.rotation.y = Math.atan2(dir.x, dir.z);
    addTemp(m, 0.35, (k, o) => { o.material.opacity = 0.85 * (1 - k); o.scale.x = 1 - k * 0.6; });
  }

  function coneFx(pos, ang, def) {
    const r = def.range || 18, a = def.angle || 0.65;
    const geo = new THREE.RingGeometry(0.5, r, 20, 1, -a / 2, a);
    const m = flat(geo, pos.x, pos.z, 0xffd54f, 0.8, 0.3);
    m.rotation.z = ang + Math.PI / 2;
    addTemp(m, 0.4, (k, o) => { o.material.opacity = 0.8 * (1 - k); });
  }

  function dashFx(pos, dir, def) {
    const len = def.dashDist || 11;
    const geo = new THREE.BoxGeometry(1.2, 0.4, len);
    const m = new THREE.Mesh(geo, mat(0xffffff, 0.6));
    m.position.set(pos.x + dir.x * len / 2, ground(pos.x, pos.z) + 0.6, pos.z + dir.z * len / 2);
    m.rotation.y = Math.atan2(dir.x, dir.z);
    addTemp(m, 0.3, (k, o) => { o.material.opacity = 0.6 * (1 - k); });
  }

  function blinkFx(from, tx, tz) {
    ringFx(from.x, from.z, 2, 0xb388ff, 0.4);
    setTimeout(() => ringFx(tx, tz, 2, 0xb388ff, 0.4), 60);
  }

  function lightningFx(pos, tx, tz) {
    const pts = [];
    const segs = 7;
    for (let i = 0; i <= segs; i++) {
      const k = i / segs;
      const jx = (Math.random() - 0.5) * 2.4, jz = (Math.random() - 0.5) * 2.4;
      pts.push(new THREE.Vector3(
        pos.x + (tx - pos.x) * k + (i === 0 || i === segs ? 0 : jx),
        ground(pos.x, pos.z) + 1.6 + (i === 0 || i === segs ? 0 : (Math.random() - 0.5) * 1.5),
        pos.z + (tz - pos.z) * k + (i === 0 || i === segs ? 0 : jz)
      ));
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xfff176, transparent: true, opacity: 1, blending: THREE.AdditiveBlending })
    );
    addTemp(line, 0.25, (k, o) => { o.material.opacity = 1 - k; });
  }

  function healFx(x, z, r) {
    ringFx(x, z, r, 0x69f0ae, 0.6);
    const col = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.7, r * 0.7, 4, 16, 1, true), mat(0x69f0ae, 0.35));
    col.position.set(x, ground(x, z) + 2, z);
    addTemp(col, 0.7, (k, o) => { o.material.opacity = 0.35 * (1 - k); o.position.y += 0.03; });
  }

  // ---- telegraphs from snapshots (boss / skill ground effects) ----
  function syncTelegraphs(telesArr, simNow) {
    const seen = new Set();
    for (const t of telesArr) {
      seen.add(t.id);
      let m = teles.get(t.id);
      if (!m) {
        const grp = new THREE.Group();
        const fill = new THREE.Mesh(new THREE.CircleGeometry(t.r, 32), mat(0xff3b30, 0.28));
        fill.rotation.x = -Math.PI / 2;
        const edge = new THREE.Mesh(new THREE.RingGeometry(t.r - 0.5, t.r, 40), mat(0xff3b30, 0.9));
        edge.rotation.x = -Math.PI / 2;
        edge.position.y = 0.05;
        grp.add(fill, edge);
        grp.position.set(t.x, ground(t.x, t.z) + 0.2, t.z);
        grp.userData = { fill, edge, r: t.r };
        scene.add(grp);
        teles.set(t.id, grp);
        m = grp;
      }
      m.userData.until = t.until;
    }
    for (const [id, m] of teles) {
      if (!seen.has(id)) { scene.remove(m); teles.delete(id); continue; }
      const remain = (m.userData.until - simNow) / 1000;
      const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 110);
      m.userData.fill.material.opacity = 0.28 * pulse * Math.min(1, Math.max(0.15, remain));
      m.userData.edge.material.opacity = 0.9 * pulse;
    }
  }

  function clear() {
    for (const f of live) scene.remove(f.obj);
    live.length = 0;
    for (const f of floaters) f.el.remove();
    floaters.length = 0;
    for (const [, m] of teles) scene.remove(m);
    teles.clear();
  }

  return { update, onCast, onDmg, onHeal, onDie, onLvl, syncTelegraphs, clear };
}
