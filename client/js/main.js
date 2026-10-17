// hordes3d client — boot: login -> connect -> game loop. Wires net/world/entities/fx/ui/input.

import * as THREE from 'three';
import { getServerUrl } from '../config.js';
import { createNet } from './net.js';
import { createWorld } from './world3d.js';
import { createEntities } from './entities.js';
import { createFx } from './fx.js';
import { createUI } from './ui.js';
import { createInput } from './input.js';
import { WORLD, FACTIONS } from '../shared/world.js';

const $ = (id) => document.getElementById(id);

// ---- modules ----
const world = createWorld();
const entities = createEntities(world.scene, world);
const fx = createFx(world.scene, world, entities);
const net = createNet();

let myId = null;
let myName = '', myClass = 'warrior', myFaction = 'bloodlust';
let joined = false;
let seq = 0;
let deathAt = 0;
let targetEntId = null;

const ui = createUI({
  onPlay(name, classId, faction, serverInput) {
    myName = name; myClass = classId; myFaction = faction;
    const url = (serverInput && serverInput.trim()) || getServerUrl();
    ui.setStatus('Connecting to ' + url + ' ...');
    net.connect(url);
  },
  onChatSend(ch, text) { net.send({ t: 'chat', ch, text }); },
  onInvite(name) { net.send({ t: 'pinv', name }); },
  onAcceptInvite(pid) { net.send({ t: 'pacc', pid }); },
  onDeclineInvite(pid) { net.send({ t: 'pleave' }); }, // no explicit decline msg; leaving = decline
  onLeaveParty() { net.send({ t: 'pleave' }); },
  onEquip(uid) { net.send({ t: 'equip', uid }); },
  onRespawn() { net.send({ t: 'respawn' }); },
});

// ---- net events ----
net.on('open', () => {
  ui.setStatus('Connected. Joining...');
  if (joined) { // reconnect: drop stale world state, fresh join
    entities.clear();
    fx.clear();
    targetEntId = null;
    ui.setTarget(null);
  }
  net.send({ t: 'join', name: myName, classId: myClass, faction: myFaction });
});

net.on('welcome', (m) => {
  myId = m.id;
  ui.setMyId(myId);
  joined = true;
  ui.enterGame(myName);
  ui.setStatus('');
  ui.addFeed('Welcome to the realm, ' + myName + '.', 'sys');
});

net.on('reconnecting', (n) => ui.setStatus(`Connection lost. Retrying (${n}/5)...`));
net.on('close', () => { if (!joined) ui.setStatus('Connection closed.'); });
net.on('dead', (msg) => ui.setError(msg));

net.on('snap', (s) => {
  if (!joined) return;
  const you = s.you;
  ui.updateHUD(you);
  // death screen
  if (you.dead) {
    if (!deathAt) {
      deathAt = performance.now();
      ui.showDeath();
    }
    const left = Math.max(0, Math.ceil((WORLD.respawnMs - (performance.now() - deathAt)) / 1000));
    ui.setDeathCount(left);
  } else if (deathAt) {
    deathAt = 0;
    ui.hideDeath();
  }
  // keep target frame fresh
  if (targetEntId) {
    const ent = s.ents.find(e => e.id === targetEntId);
    ui.updateTarget(ent || null);
    if (!ent) { targetEntId = null; ui.setTarget(null); }
  }
});

net.on('ev', (ev) => {
  if (!joined) return;
  switch (ev.e) {
    case 'cast': fx.onCast(ev); break;
    case 'dmg': fx.onDmg(ev); break;
    case 'heal': fx.onHeal(ev); break;
    case 'die': {
      fx.onDie(ev);
      const victim = ev.id === myId ? 'You' : entities.getName(ev.id);
      ui.addFeed(`${ev.pname} slew ${victim}` + (ev.fame ? ` (+${ev.fame} fame)` : ''), 'kill');
      if (ev.id === myId) ui.showDeath(ev.pname);
      break;
    }
    case 'loot':
      ui.toast(`Looted: ${ev.item.name}${ev.gold ? ` (+${ev.gold}g)` : ''}`, 'loot');
      break;
    case 'lvl':
      fx.onLvl(ev);
      ui.addFeed(`${ev.pname} reached level ${ev.lvl}!`, 'lvl');
      break;
    case 'respawn':
      if (ev.id === myId) { deathAt = 0; ui.hideDeath(); }
      break;
    case 'pinv':
      ui.toast(`${ev.fromName} invited you to a party`, 'party');
      break;
    case 'pjoin': ui.addFeed(`${ev.pname} joined the party.`, 'party'); break;
    case 'pleave': ui.addFeed(`${ev.pname} left the party.`, 'party'); break;
    case 'pdisband': ui.addFeed('Party disbanded.', 'party'); break;
  }
});

net.on('chat', (m) => ui.addChat(m));
net.on('party', (m) => ui.setParty(m.you, m.invites || []));
net.on('err', (m) => ui.addFeed('Error: ' + m.msg, 'err'));

// ---- input ----
const raycaster = new THREE.Raycaster();
const ndcV = new THREE.Vector2();
const input = createInput({
  dom: world.dom,
  scene: world.scene,
  camera: world.camera,
  get classId() { return myClass; },
  getPlayer() {
    const f = net.frame();
    return f ? f.you : null;
  },
  terrainY: (x, z) => world.groundY(x, z),
  pickEntity(cx, cy) {
    ndcV.set((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndcV, world.camera);
    const hits = raycaster.intersectObjects(entities.pickMeshes(), true);
    if (!hits.length) return null;
    let o = hits[0].object;
    while (o && o.userData.entId === undefined) o = o.parent;
    return o ? o.userData.entId : null;
  },
  onMove(mx, mz) { if (joined) net.send({ t: 'input', seq: ++seq, mx, mz }); },
  onCast(skill, tx, tz) {
    if (!joined) return;
    net.send({ t: 'cast', skill, tx: +tx.toFixed(2), tz: +tz.toFixed(2) });
  },
  onTarget(entId) {
    targetEntId = entId;
    ui.setTarget(entId ? entities.getEnt(entId) : null);
  },
  onToggleInventory() { ui.toggleInventory(); },
  onChatKey() { ui.focusChat(); },
  isTyping() {
    const a = document.activeElement;
    return ui.chatFocused() || (a && a.tagName === 'INPUT');
  },
  setTargeting(on) { ui.setTargeting(on); },
});

// ---- main loop ----
const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, clock.getDelta());
  const f = net.frame();
  if (f && joined) {
    entities.sync(f.ents, performance.now());
    entities.updateFades(dt);
    entities.updateLabels(world.project);
    fx.update(dt);
    fx.syncTelegraphs(f.teles, net.simNow());
    const you = f.you;
    world.updateCamera(you.x, you.y, you.z);
    ui.drawMinimap(f.ents, you, f.teles);
  } else {
    // login backdrop: slow orbit around boss arena
    const t = performance.now() / 1000;
    world.updateCamera(Math.cos(t * 0.08) * 30, 4, Math.sin(t * 0.08) * 30);
    fx.update(dt);
  }
  world.render();
}
frame();

// expose for debugging
window.hordes = { net, ui, world, entities, fx };
