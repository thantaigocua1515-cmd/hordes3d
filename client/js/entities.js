// hordes3d client — entity meshes + pooled HTML labels (name / level / HP bar).
// All models are original low-poly shapes built in code.

import * as THREE from 'three';
import { FACTIONS, CLASSES, MONSTERS, BOSS, ELITE } from '../shared/world.js';

function monsterDef(ent) {
  if (ent.boss) return BOSS;
  const k = Object.keys(MONSTERS).find(k => MONSTERS[k].name === ent.name);
  return MONSTERS[k] || { color: 0x888888, scale: 1 };
}

// ---- humanoid player: capsule body, sphere head, class-colored pads/headband, faction ring ----
function buildPlayer(ent) {
  const g = new THREE.Group();
  const cls = CLASSES[ent.cls] || CLASSES.warrior;
  const fac = FACTIONS[ent.fac];

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x39404d, roughness: 0.8 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.68, 1.5, 8), bodyMat);
  body.position.y = 1.05; g.add(body);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.42, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xe8b98a, roughness: 0.7 })
  );
  head.position.y = 2.15; g.add(head);

  const accentMat = new THREE.MeshStandardMaterial({ color: cls.color, roughness: 0.5 });
  const band = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.14, 0.9), accentMat);
  band.position.y = 2.32; g.add(band);
  const padGeo = new THREE.BoxGeometry(0.44, 0.24, 0.44);
  for (const sx of [-1, 1]) {
    const pad = new THREE.Mesh(padGeo, accentMat);
    pad.position.set(sx * 0.64, 1.72, 0); g.add(pad);
  }

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.75, 0.95, 24),
    new THREE.MeshBasicMaterial({ color: fac ? fac.color : 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.06; g.add(ring);

  // buff glow ring (hidden unless ent.buff)
  const glow = new THREE.Mesh(
    new THREE.RingGeometry(1.0, 1.25, 24),
    new THREE.MeshBasicMaterial({ color: 0xffd75e, transparent: true, opacity: 0.0, side: THREE.DoubleSide })
  );
  glow.rotation.x = -Math.PI / 2; glow.position.y = 0.08; g.add(glow);

  g.userData = { ring, glow, bodyMat, labelH: 3.0, kind: 'p' };
  return g;
}

// ---- monster: colored icosahedron body scaled by type; elite/boss rings ----
function buildMonster(ent) {
  const g = new THREE.Group();
  const def = monsterDef(ent);
  const s = def.scale * (ent.elite ? ELITE.scaleMul : 1);

  const mat = new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.85 });
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9, 0), mat);
  body.scale.set(s, s * 1.15, s);
  body.position.y = 0.95 * s;
  g.add(body);
  // simple horns for menace
  const hornGeo = new THREE.ConeGeometry(0.16 * s, 0.6 * s, 5);
  const hornMat = new THREE.MeshStandardMaterial({ color: 0xe8e0d0, roughness: 0.6 });
  for (const sx of [-1, 1]) {
    const horn = new THREE.Mesh(hornGeo, hornMat);
    horn.position.set(sx * 0.5 * s, 1.7 * s, 0);
    horn.rotation.z = -sx * 0.5;
    g.add(horn);
  }

  if (ent.elite) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.1 * s, 1.35 * s, 24),
      new THREE.MeshBasicMaterial({ color: 0x9b59b6, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.08; g.add(ring);
    g.userData.eliteRing = ring;
  }
  if (ent.boss) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(3.6, 4.1, 40),
      new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.08; g.add(ring);
    g.userData.bossRing = ring;
  }

  g.userData.labelH = (ent.boss ? 4.6 : 2.0) * s + 0.6;
  g.userData.kind = 'm';
  return g;
}

export function createEntities(scene, world) {
  const labelLayer = document.getElementById('labels');
  const meshes = new Map();  // entId -> { group, ent }
  const labels = new Map();  // entId -> { el, nameEl, hpEl, lastPct }
  const fading = new Map();  // entId -> { t } for death fade-out
  const seen = new Set();

  function makeLabel(ent) {
    const el = document.createElement('div');
    el.className = 'ent-label' + (ent.k === 'p' ? ' player' : ' monster') + (ent.boss ? ' boss' : '');
    const nameColor = ent.k === 'p' && FACTIONS[ent.fac] ? FACTIONS[ent.fac].css : (ent.boss ? '#ff6b60' : '#ffd9d4');
    el.innerHTML = `<div class="nm" style="color:${nameColor}">${escapeHtml(ent.name)} <span class="lv">Lv${ent.lvl}</span></div>` +
                   `<div class="hpbar"><div class="hpfill"></div></div>`;
    labelLayer.appendChild(el);
    const rec = { el, hpEl: el.querySelector('.hpfill'), lastPct: -1 };
    labels.set(ent.id, rec);
    return rec;
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function sync(frameEnts, now) {
    seen.clear();
    for (const ent of frameEnts) {
      seen.add(ent.id);
      let m = meshes.get(ent.id);
      if (!m) {
        const group = ent.k === 'p' ? buildPlayer(ent) : buildMonster(ent);
        group.userData.entId = ent.id;
        scene.add(group);
        m = { group, ent };
        meshes.set(ent.id, m);
      }
      m.ent = ent;
      const g = m.group;
      g.position.set(ent.x, ent.y, ent.z);
      if (typeof ent.face === 'number') g.rotation.y = ent.face;
      // casting pulse
      const cs = ent.cast ? 1 + 0.08 * Math.sin(now / 90) : 1;
      g.scale.set(cs, 1, cs);
      // buff glow
      if (g.userData.glow) g.userData.glow.material.opacity = ent.buff ? 0.55 + 0.3 * Math.sin(now / 200) : 0;
      if (g.userData.eliteRing) g.userData.eliteRing.material.opacity = 0.6 + 0.35 * Math.sin(now / 180);
      if (g.userData.bossRing) g.userData.bossRing.material.opacity = 0.6 + 0.35 * Math.sin(now / 150);
    }
    // remove entities that left replication range (fade quickly)
    for (const [id, m] of meshes) {
      if (!seen.has(id) && !fading.has(id)) fading.set(id, { t: 0, remove: true });
    }
  }

  // Death fade: shrink + sink, then remove mesh + label.
  function fadeOut(id) {
    if (meshes.has(id)) fading.set(id, { t: 0, remove: true, death: true });
  }

  function updateFades(dt) {
    for (const [id, f] of fading) {
      f.t += dt;
      const m = meshes.get(id);
      if (!m) { fading.delete(id); continue; }
      const k = Math.min(1, f.t / 0.6);
      m.group.scale.setScalar(Math.max(0.01, 1 - k));
      m.group.position.y -= dt * 2;
      if (k >= 1) {
        scene.remove(m.group);
        meshes.delete(id);
        const l = labels.get(id);
        if (l) { l.el.remove(); labels.delete(id); }
        fading.delete(id);
      }
    }
  }

  function updateLabels(project, maxDist) {
    const tmp = { x: 0, y: 0, behind: false };
    for (const [id, m] of meshes) {
      const ent = m.ent;
      let rec = labels.get(id);
      if (!rec) rec = makeLabel(ent);
      const p = project(ent.x, ent.y + (m.group.userData.labelH || 2.5), ent.z);
      const far = p.behind;
      rec.el.style.display = far ? 'none' : 'block';
      if (!far) {
        rec.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -100%)`;
        const pct = Math.max(0, Math.min(100, (ent.hp / Math.max(1, ent.mhp)) * 100));
        if (Math.abs(pct - rec.lastPct) > 1) {
          rec.hpEl.style.width = pct + '%';
          rec.hpEl.style.background = pct > 50 ? '#4caf50' : pct > 25 ? '#ff9800' : '#f44336';
          rec.lastPct = pct;
        }
      }
    }
  }

  function getPos(id) {
    const m = meshes.get(id);
    return m ? { x: m.ent.x, y: m.ent.y, z: m.ent.z } : null;
  }
  function getEnt(id) { const m = meshes.get(id); return m ? m.ent : null; }
  function getName(id) { const m = meshes.get(id); return m ? m.ent.name : '???'; }
  function pickMeshes() {
    const arr = [];
    for (const m of meshes.values()) arr.push(m.group);
    return arr;
  }
  function clear() {
    for (const m of meshes.values()) scene.remove(m.group);
    meshes.clear(); fading.clear();
    for (const l of labels.values()) l.el.remove();
    labels.clear();
  }

  return {
    sync, fadeOut, updateFades, updateLabels,
    getPos, getEnt, getName, pickMeshes, clear,
    get count() { return meshes.size; },
  };
}
