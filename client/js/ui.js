// hordes3d client — login screen, HUD, skill bar, chat, party, inventory,
// death screen, minimap, kill feed, toasts. No emojis: text + CSS/SVG only.

import { CLASSES, FACTIONS, SKILLS, QUALITIES, WORLD } from '../shared/world.js';
import { getSavedServer } from '../config.js';

const CLASS_DESC = {
  warrior: 'Melee bruiser. Huge HP, charges into the fray.',
  mage: 'Ranged burst caster. Fragile, devastating.',
  shaman: 'Lightning and healing. Holds the warband together.',
  archer: 'Fast skirmisher. Death from afar.',
};

function skillDesc(def) {
  const d = def.dmg ? `${def.dmg}x atk dmg` : '';
  switch (def.kind) {
    case 'melee': return `Melee strike. ${d}.`;
    case 'proj': return `Fires a projectile. ${d}.`;
    case 'aoe_self': return `Nova around you (r ${def.radius}). ${d}.`;
    case 'aoe_point': return `Blast at target point (r ${def.radius}). ${d}.`;
    case 'line': return `Piercing line shot. ${d}.`;
    case 'cone': return `Cone volley. ${d}.`;
    case 'dash': return `Dash forward, damaging foes. ${d}.`;
    case 'blink': return `Teleport to target point.`;
    case 'chain': return `Lightning chains between foes. ${d}.`;
    case 'heal': return `Heal an ally (${def.heal}x).`;
    case 'hot': return `Healing zone (r ${def.radius}).`;
    case 'debuff': return `Weaken and slow a foe.`;
    case 'buff': return `Empower yourself (${def.dur}s).`;
    default: return '';
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function createUI(h) {
  // h: hooks { onPlay(name,classId,faction,serverUrl), onChatSend(ch,text), onInvite(name),
  //          onAcceptInvite(pid), onDeclineInvite(pid), onLeaveParty(), onEquip(uid), onRespawn(), onDisconnect() }
  const root = document.getElementById('ui');
  let selClass = 'warrior', selFaction = 'bloodlust';
  let chatChannel = 'global';
  let myId = null, myName = '';
  let targetId = null;
  let lastInvSig = '';

  root.innerHTML = `
  <div id="login" class="overlay">
    <div class="login-card">
      <h1>HORDES<span>3D</span></h1>
      <p class="tagline">Two factions. One shattered realm.</p>
      <label class="fld">Warrior name
        <input id="login-name" maxlength="16" placeholder="Your name" autocomplete="off">
      </label>
      <div class="sec">Class</div>
      <div id="class-cards" class="cards"></div>
      <div class="sec">Faction</div>
      <div id="faction-btns" class="factions"></div>
      <label class="fld">Server
        <input id="login-server" placeholder="wss://host" autocomplete="off" spellcheck="false">
      </label>
      <button id="play-btn" class="primary">Enter the Realm</button>
      <div id="login-status" class="status"></div>
      <div id="login-err" class="err"></div>
    </div>
  </div>
  <div id="hud" class="hidden">
    <div id="player-panel">
      <div class="pname"><span id="p-name"></span> <span id="p-lvl" class="lvlbadge"></span></div>
      <div class="bar hp"><div id="bar-hp" class="fill"></div><span id="bar-hp-t" class="bt"></span></div>
      <div class="bar mana"><div id="bar-mana" class="fill"></div><span id="bar-mana-t" class="bt"></span></div>
      <div class="bar xp"><div id="bar-xp" class="fill"></div></div>
      <div class="pstats"><span id="p-gold">0g</span><span id="p-fame">0 fame</span></div>
    </div>
    <div id="target-frame" class="hidden">
      <div class="tname"><span id="t-name"></span> <span id="t-lvl" class="lvlbadge"></span></div>
      <div class="bar hp"><div id="t-hp" class="fill"></div></div>
    </div>
    <div id="top-right">
      <canvas id="minimap" width="170" height="170"></canvas>
      <div id="feed"></div>
    </div>
    <div id="skillbar"></div>
    <div id="chat">
      <div class="tabs"><button data-ch="global" class="active">Global</button><button data-ch="party">Party</button></div>
      <div id="chat-log"></div>
      <input id="chat-input" maxlength="140" placeholder="Enter to chat (/p for party)" autocomplete="off">
    </div>
    <div id="party-panel">
      <div class="ph">Party <button id="party-toggle" class="mini">-</button></div>
      <div id="party-body"></div>
    </div>
    <div id="inv-panel" class="hidden">
      <div class="ph">Inventory <span class="hint">[I]</span></div>
      <div id="equip-slots"></div>
      <div id="inv-list"></div>
    </div>
    <div id="toasts"></div>
    <div id="death" class="hidden overlay">
      <div class="death-card">
        <h2>YOU DIED</h2>
        <p id="death-info"></p>
        <button id="respawn-btn" class="primary">Respawn</button>
        <p class="hint">Auto-respawn in <span id="death-count">10</span>s</p>
      </div>
    </div>
    <div id="targeting-hint" class="hidden">Left-click to aim — Right-click / Esc to cancel</div>
  </div>`;

  const $ = (id) => document.getElementById(id);

  // ---- login screen ----
  const cardsEl = $('class-cards');
  for (const [id, c] of Object.entries(CLASSES)) {
    const d = document.createElement('div');
    d.className = 'class-card' + (id === selClass ? ' sel' : '');
    d.innerHTML = `<div class="swatch" style="background:${c.css}"></div><div class="cname">${c.name}</div><div class="cdesc">${CLASS_DESC[id]}</div>`;
    d.onclick = () => {
      selClass = id;
      cardsEl.querySelectorAll('.class-card').forEach(x => x.classList.remove('sel'));
      d.classList.add('sel');
    };
    cardsEl.appendChild(d);
  }
  const facEl = $('faction-btns');
  for (const [id, f] of Object.entries(FACTIONS)) {
    const b = document.createElement('button');
    b.className = 'fac-btn' + (id === selFaction ? ' sel' : '');
    b.style.setProperty('--fac', f.css);
    b.textContent = f.name;
    b.onclick = () => {
      selFaction = id;
      facEl.querySelectorAll('.fac-btn').forEach(x => x.classList.remove('sel'));
      b.classList.add('sel');
    };
    facEl.appendChild(b);
  }
  $('login-server').value = getSavedServer();
  $('play-btn').onclick = () => {
    const name = $('login-name').value.trim();
    const err = $('login-err');
    if (name.length < 1 || name.length > WORLD.nameMax) { err.textContent = `Name must be 1-${WORLD.nameMax} characters.`; return; }
    err.textContent = '';
    $('play-btn').disabled = true;
    h.onPlay(name, selClass, selFaction, $('login-server').value.trim());
  };
  $('login-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('play-btn').click(); e.stopPropagation(); });

  function setStatus(s) { $('login-status').textContent = s; }
  function setError(s) { $('login-err').textContent = s; $('play-btn').disabled = false; }
  function enterGame(name) {
    myName = name;
    $('login').classList.add('hidden');
    $('hud').classList.remove('hidden');
    buildSkillbar();
  }

  // ---- skill bar ----
  function buildSkillbar() {
    const bar = $('skillbar');
    bar.innerHTML = '';
    const skills = SKILLS[selClass];
    skills.forEach((def, i) => {
      const s = document.createElement('div');
      s.className = 'skill';
      s.id = 'skill-' + i;
      s.innerHTML = `<div class="key">${i + 1}</div><div class="icon">${esc(def.name[0])}</div>` +
        `<div class="cost">${def.mana}</div><div class="cdov"><span></span></div>` +
        `<div class="tip"><b>${esc(def.name)}</b><br>Mana ${def.mana} · CD ${def.cd}s · Range ${def.range}<br><span>${esc(skillDesc(def))}</span></div>`;
      bar.appendChild(s);
    });
  }
  function setCooldowns(cds, mana) {
    const skills = SKILLS[selClass];
    skills.forEach((def, i) => {
      const s = $('skill-' + i);
      if (!s) return;
      const cd = cds[i] || 0;
      const ov = s.querySelector('.cdov');
      if (cd > 0.05) {
        ov.style.display = 'block';
        ov.style.height = Math.min(100, (cd / def.cd) * 100) + '%';
        ov.querySelector('span').textContent = cd.toFixed(1);
      } else ov.style.display = 'none';
      s.classList.toggle('nomana', mana < def.mana);
    });
  }

  // ---- HUD ----
  function updateHUD(you) {
    if (!you) return;
    $('p-name').textContent = you.name || myName;
    $('p-lvl').textContent = 'Lv ' + you.lvl;
    const hpP = (you.hp / Math.max(1, you.mhp)) * 100;
    $('bar-hp').style.width = hpP + '%';
    $('bar-hp-t').textContent = `${Math.ceil(you.hp)} / ${Math.ceil(you.mhp)}`;
    $('bar-mana').style.width = (you.mana / Math.max(1, you.mmana)) * 100 + '%';
    $('bar-mana-t').textContent = `${Math.floor(you.mana)} / ${Math.floor(you.mmana)}`;
    $('bar-xp').style.width = (you.xp / Math.max(1, you.xpNext)) * 100 + '%';
    $('p-gold').textContent = you.gold + 'g';
    $('p-fame').textContent = you.fame + ' fame';
    setCooldowns(you.cds || [0, 0, 0, 0], you.mana);
    updateInventory(you);
  }

  // ---- target frame ----
  function setTarget(ent) {
    targetId = ent ? ent.id : null;
    const f = $('target-frame');
    if (!ent) { f.classList.add('hidden'); return; }
    f.classList.remove('hidden');
    $('t-name').textContent = ent.name;
    $('t-lvl').textContent = 'Lv ' + ent.lvl;
    $('t-hp').style.width = (ent.hp / Math.max(1, ent.mhp)) * 100 + '%';
  }
  function updateTarget(ent) { if (ent && ent.id === targetId) setTarget(ent); }

  // ---- chat ----
  const chatLog = $('chat-log'), chatInput = $('chat-input');
  document.querySelectorAll('#chat .tabs button').forEach(b => {
    b.onclick = () => {
      chatChannel = b.dataset.ch;
      document.querySelectorAll('#chat .tabs button').forEach(x => x.classList.toggle('active', x === b));
      chatInput.focus();
    };
  });
  function setChannel(ch) {
    chatChannel = ch;
    document.querySelectorAll('#chat .tabs button').forEach(x => x.classList.toggle('active', x.dataset.ch === ch));
  }
  chatInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const t = chatInput.value.trim();
      chatInput.value = '';
      if (t) {
        let ch = chatChannel, text = t;
        if (t.startsWith('/p ')) { ch = 'party'; text = t.slice(3); }
        else if (t === '/p') { setChannel('party'); chatInput.blur(); return; }
        if (text) h.onChatSend(ch, text);
      }
      chatInput.blur();
    } else if (e.key === 'Escape') chatInput.blur();
    else if (e.key === 'Tab') { e.preventDefault(); setChannel(chatChannel === 'global' ? 'party' : 'global'); }
  });
  function addChat(m) {
    const d = document.createElement('div');
    d.className = 'cmsg ' + m.ch;
    d.innerHTML = `<b>${esc(m.from)}</b> <span class="ch">(${m.ch})</span>: ${esc(m.text)}`;
    chatLog.appendChild(d);
    while (chatLog.children.length > 60) chatLog.firstChild.remove();
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  function chatFocused() { return document.activeElement === chatInput; }
  function focusChat() { chatInput.focus(); }

  // ---- party ----
  $('party-toggle').onclick = () => {
    const b = $('party-body');
    b.classList.toggle('hidden');
    $('party-toggle').textContent = b.classList.contains('hidden') ? '+' : '-';
  };
  function setParty(view, invites) {
    const body = $('party-body');
    let html = '';
    if (view) {
      html += '<div class="members">' + view.members.map(m =>
        `<div class="mem">${esc(m.name)} <span class="cls">${esc(CLASSES[m.cls] ? CLASSES[m.cls].name : m.cls)} Lv${m.lvl}</span>${m.id === view.leader ? ' <span class="ldr">LEAD</span>' : ''}</div>`
      ).join('') + '</div><button id="pleave" class="mini danger">Leave party</button>';
    }
    html += `<div class="invrow"><input id="pinv-name" maxlength="16" placeholder="Player name" autocomplete="off"><button id="pinv-btn" class="mini">Invite</button></div>`;
    if (invites && invites.length) {
      html += '<div class="pinvs">' + invites.map(i =>
        `<div class="pinv"><span>${esc(i.fromName)} invites you</span><button class="mini" data-acc="${i.pid}">Accept</button><button class="mini danger" data-dec="${i.pid}">Decline</button></div>`
      ).join('') + '</div>';
    }
    body.innerHTML = html;
    const inv = $('pinv-name');
    $('pinv-btn').onclick = () => { if (inv.value.trim()) h.onInvite(inv.value.trim()); inv.value = ''; };
    inv.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') $('pinv-btn').click(); });
    const lv = $('pleave');
    if (lv) lv.onclick = () => h.onLeaveParty();
    body.querySelectorAll('[data-acc]').forEach(b => b.onclick = () => h.onAcceptInvite(b.dataset.acc));
    body.querySelectorAll('[data-dec]').forEach(b => b.onclick = () => h.onDeclineInvite(b.dataset.dec));
  }

  // ---- inventory ----
  function itemStats(it) {
    const parts = [];
    if (it.atk) parts.push(`+${it.atk} atk`);
    if (it.def) parts.push(`+${it.def} def`);
    if (it.hp) parts.push(`+${it.hp} hp`);
    if (it.mana) parts.push(`+${it.mana} mana`);
    return parts.join(' ');
  }
  function updateInventory(you) {
    const sig = JSON.stringify([(you.inv || []).map(i => i.uid), you.equip]);
    if (sig === lastInvSig) return;
    lastInvSig = sig;
    const eq = you.equip || {};
    $('equip-slots').innerHTML = ['weapon', 'armor', 'trinket'].map(slot => {
      const it = eq[slot];
      const q = it ? QUALITIES[it.q] : null;
      return `<div class="eqslot"><span class="slotname">${slot}</span>` +
        (it ? `<span class="iname" style="color:${q.css}">${esc(it.name)}</span><span class="istats">${esc(itemStats(it))}</span>`
            : `<span class="empty">—</span>`) + `</div>`;
    }).join('');
    const inv = you.inv || [];
    $('inv-list').innerHTML = inv.length ? inv.map(it => {
      const q = QUALITIES[it.q] || QUALITIES[0];
      return `<div class="irow" data-uid="${esc(it.uid)}" title="Click to equip">` +
        `<span class="iname" style="color:${q.css}">${esc(it.name)}</span>` +
        `<span class="qname" style="color:${q.css}">${q.name} ${it.slot}</span>` +
        `<span class="istats">${esc(itemStats(it))}</span></div>`;
    }).join('') : '<div class="emptyinv">Empty — slay monsters for loot.</div>';
    $('inv-list').querySelectorAll('.irow').forEach(r => r.onclick = () => h.onEquip(r.dataset.uid));
  }
  function toggleInventory() { $('inv-panel').classList.toggle('hidden'); }

  // ---- feed / toasts ----
  const feed = $('feed');
  function addFeed(text, cls) {
    const d = document.createElement('div');
    d.className = 'fmsg ' + (cls || '');
    d.textContent = text;
    feed.prepend(d);
    while (feed.children.length > 8) feed.lastChild.remove();
    setTimeout(() => { d.classList.add('fade'); setTimeout(() => d.remove(), 800); }, 6000);
  }
  function toast(text, cls) {
    const d = document.createElement('div');
    d.className = 'toast ' + (cls || '');
    d.textContent = text;
    $('toasts').appendChild(d);
    setTimeout(() => { d.classList.add('fade'); setTimeout(() => d.remove(), 600); }, 2600);
  }

  // ---- death ----
  function showDeath(killer) {
    $('death').classList.remove('hidden');
    $('death-info').textContent = killer ? `Slain by ${killer}.` : 'You have fallen.';
  }
  function hideDeath() { $('death').classList.add('hidden'); }
  function setDeathCount(s) { $('death-count').textContent = s; }
  $('respawn-btn').onclick = () => h.onRespawn();

  // ---- targeting hint ----
  function setTargeting(on) { $('targeting-hint').classList.toggle('hidden', !on); }

  // ---- minimap ----
  const mm = $('minimap').getContext('2d');
  function drawMinimap(ents, you, teles) {
    const S = 170, half = WORLD.size / 2;
    const px = x => (x + half) / WORLD.size * S;
    const pz = z => (z + half) / WORLD.size * S;
    mm.clearRect(0, 0, S, S);
    mm.fillStyle = 'rgba(8,12,24,0.85)';
    mm.fillRect(0, 0, S, S);
    // spawn zones + boss arena
    for (const f of Object.values(FACTIONS)) {
      mm.fillStyle = f.css + '55';
      mm.fillRect(px(f.spawn.x) - 8, pz(f.spawn.z) - 8, 16, 16);
    }
    mm.strokeStyle = '#ff3b3088';
    mm.strokeRect(px(0) - 12, pz(0) - 12, 24, 24);
    // telegraphs
    mm.fillStyle = '#ff3b30aa';
    for (const t of teles || []) { mm.beginPath(); mm.arc(px(t.x), pz(t.z), Math.max(2, t.r / WORLD.size * S), 0, 7); mm.fill(); }
    // entities
    for (const e of ents || []) {
      if (e.id === (you && you.id)) continue;
      if (e.k === 'p') {
        const f = FACTIONS[e.fac];
        mm.fillStyle = f ? f.css : '#fff';
        mm.fillRect(px(e.x) - 2, pz(e.z) - 2, 4, 4);
      } else if (e.boss) {
        mm.fillStyle = '#ff3b30';
        mm.beginPath();
        mm.moveTo(px(e.x), pz(e.z) - 5); mm.lineTo(px(e.x) + 5, pz(e.z));
        mm.lineTo(px(e.x), pz(e.z) + 5); mm.lineTo(px(e.x) - 5, pz(e.z));
        mm.closePath(); mm.fill();
      } else {
        mm.fillStyle = '#ff7043';
        mm.fillRect(px(e.x) - 1.5, pz(e.z) - 1.5, 3, 3);
      }
    }
    // self
    if (you) {
      mm.fillStyle = '#fff';
      mm.beginPath(); mm.arc(px(you.x), pz(you.z), 3, 0, 7); mm.fill();
      mm.strokeStyle = '#fff';
      mm.beginPath(); mm.arc(px(you.x), pz(you.z), 5.5, 0, 7); mm.stroke();
    }
  }

  return {
    setStatus, setError, enterGame,
    updateHUD, setTarget, updateTarget, getTargetId: () => targetId,
    addChat, chatFocused, focusChat,
    setParty, toggleInventory,
    addFeed, toast,
    showDeath, hideDeath, setDeathCount,
    setTargeting, drawMinimap,
    get myId() { return myId; }, setMyId: (id) => { myId = id; },
  };
}
