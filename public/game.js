/* Snake Arena client */
const socket = io();
const $ = (id) => document.getElementById(id);

const screens = { home: $('home'), lobby: $('lobby'), game: $('game') };
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const isTouch = matchMedia('(pointer: coarse)').matches;

let cfg = null; // game constants from the server
let myId = null;
let state = null;
const orbs = new Map(); // id -> [x, y, v]
let prevBodies = new Map(); // id -> flat body from the previous tick, for smooth interpolation
let lastStateAt = 0;
let stateGap = 50; // measured ms between server updates
let countdownEnd = 0;
let rtt = 0;
let myLastLen = 0;

let fitScale = 1; // CSS px per world unit when the whole arena fits on screen
let zoomScale = 1; // CSS px per world unit when following a snake
let cssW = 0;
let cssH = 0;
const view = { s: 1, cx: 0, cy: 0 }; // current camera: scale + world point at canvas centre
let dpr = 1;

// Juice
const particles = [];
const popups = [];
let shake = 0;

// ---------- Helpers ----------
function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* storage unavailable */ }
  return null;
}

// The seat (room + secret token) lives in sessionStorage: it survives a refresh of this tab only
function seat(value) {
  try {
    if (value === undefined) return JSON.parse(sessionStorage.getItem('snakeSeat') || 'null');
    if (value === null) sessionStorage.removeItem('snakeSeat');
    else sessionStorage.setItem('snakeSeat', JSON.stringify(value));
  } catch { /* storage unavailable */ }
  return null;
}

function show(name) {
  for (const [k, el] of Object.entries(screens)) el.classList.toggle('active', k === name);
  if (name === 'game') resize();
  if (name === 'lobby') drawLookPreview();
}

function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const c of [].concat(children)) if (c != null) e.append(c);
  return e;
}

const me = () => state && state.players.find((p) => p.id === myId);
const isHost = () => state && state.hostId === myId;
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Rules are written once and shown in several places
for (const id of ['rulesHome', 'rulesLobby', 'rulesModalBody']) {
  $(id).append($('rulesTpl').content.cloneNode(true));
}
$('rulesModalBody').append(el('div', { className: 'row modal-actions' }, [
  el('button', { className: 'btn small', textContent: 'Close', onclick: () => $('rulesModal').classList.add('hidden') }),
  el('button', { className: 'btn small ghost', textContent: 'Leave match', onclick: () => leave() }),
]));

// ---------- Sound ----------
let audio;
let muted = store('snakeMuted') === '1';
function beep(freq, dur = 0.08, type = 'square', vol = 0.05, delay = 0) {
  if (muted) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime + delay;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + dur);
  } catch { /* audio not available */ }
}
const sfx = {
  eat: () => beep(660 + Math.random() * 80, 0.04, 'triangle', 0.03),
  go: () => beep(880, 0.15),
  tick: () => beep(440, 0.08),
  die: () => { beep(160, 0.3, 'sawtooth', 0.07); beep(90, 0.4, 'sawtooth', 0.05, 0.08); },
  ko: () => { beep(523, 0.08); beep(784, 0.08, 'square', 0.05, 0.07); beep(1046, 0.14, 'square', 0.05, 0.14); },
  power: () => { beep(600, 0.06, 'triangle'); beep(900, 0.06, 'triangle', 0.05, 0.06); beep(1200, 0.1, 'triangle', 0.05, 0.12); },
  shield: () => beep(300, 0.25, 'triangle', 0.08),
  win: () => { beep(523, 0.12); beep(784, 0.2, 'square', 0.05, 0.13); },
};
function renderSoundBtn() { $('soundBtn').textContent = muted ? '🔇' : '🔊'; }
$('soundBtn').onclick = () => {
  muted = !muted;
  store('snakeMuted', muted ? '1' : '0');
  renderSoundBtn();
  if (!muted) sfx.tick();
};
renderSoundBtn();

// ---------- Full screen ----------
if (!document.fullscreenEnabled) $('fullBtn').classList.add('hidden');
$('fullBtn').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      if (isTouch && screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
    }
  } catch { /* not allowed */ }
};
document.addEventListener('fullscreenchange', () => { $('fullBtn').textContent = document.fullscreenElement ? '🗗' : '⛶'; });

// ---------- Home ----------
const params = new URLSearchParams(location.search);
$('nameInput').value = store('snakeName') || '';
if (params.get('room')) {
  $('codeInput').value = params.get('room').toUpperCase().slice(0, 4);
  $('joinBtn').classList.add('primary');
  $('joinBtn').style.width = 'auto';
}

function getName() {
  const n = $('nameInput').value.trim();
  if (!n) {
    $('homeError').textContent = 'Pick a name first.';
    $('nameInput').focus();
    return null;
  }
  store('snakeName', n);
  return n;
}

$('createBtn').onclick = () => {
  const name = getName();
  if (name) socket.emit('create', { name });
};

function join() {
  const name = getName();
  const code = $('codeInput').value.trim().toUpperCase();
  if (!name) return;
  if (code.length !== 4) {
    $('homeError').textContent = 'Room codes are 4 letters.';
    return;
  }
  socket.emit('join', { name, code });
}
$('joinBtn').onclick = join;
$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
$('nameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') ($('codeInput').value.length === 4 ? join() : $('createBtn').click());
});

function resetGame() {
  myId = null;
  state = null;
  orbs.clear();
  prevBodies = new Map();
  particles.length = 0;
  popups.length = 0;
}

function leave() {
  socket.emit('leave');
  seat(null);
  resetGame();
  $('rulesModal').classList.add('hidden');
  history.replaceState(null, '', location.pathname);
  show('home');
}

// ---------- Connection & reconnect ----------
socket.on('connect', () => {
  $('banner').classList.add('hidden');
  const s = seat();
  if (s) socket.emit('rejoin', s);
});

socket.on('disconnect', () => {
  if (!myId) return;
  const b = $('banner');
  b.textContent = 'Connection lost — reconnecting… (autopilot is steering)';
  b.classList.remove('hidden');
  setBoost(false);
});

socket.on('rejoinFailed', () => {
  const s = seat();
  seat(null);
  resetGame();
  if (s) $('codeInput').value = s.code;
  $('homeError').textContent = 'That game is no longer available. Join again with the room code.';
  show('home');
});

socket.on('errorMsg', (msg) => { $('homeError').textContent = msg; show('home'); });

socket.on('joined', ({ code, id, token, config }) => {
  myId = id;
  cfg = config;
  seat({ code, token });
  $('homeError').textContent = '';
  history.replaceState(null, '', `?room=${code}`);
});

// Latency, measured every 2s (also feeds client-side prediction)
setInterval(() => {
  if (!socket.connected || !myId) return;
  const t = performance.now();
  socket.emit('ping2', t, () => {
    const sample = performance.now() - t;
    rtt = rtt ? rtt * 0.7 + sample * 0.3 : sample;
    const p = $('hudPing');
    p.textContent = `${Math.round(rtt)} ms`;
    p.className = `pill ping ${rtt < 80 ? 'good' : rtt < 180 ? 'ok' : 'bad'}`;
  });
}, 2000);

// ---------- Lobby ----------
$('startBtn').onclick = () => socket.emit('start');
$('leaveBtn').onclick = leave;
$('addBotBtn').onclick = () => socket.emit('addBot');
$('readyBtn').onclick = () => { const m = me(); if (m) socket.emit('ready', !m.ready); };
$('copyBtn').onclick = async () => {
  const link = `${location.origin}${location.pathname}?room=${state.code}`;
  try {
    await navigator.clipboard.writeText(link);
    $('copyBtn').textContent = 'Copied!';
  } catch {
    prompt('Copy this invite link:', link);
  }
  setTimeout(() => { $('copyBtn').textContent = 'Copy invite link'; }, 1500);
};

const SKIN_LABELS = { solid: 'Solid', stripes: 'Stripes', dots: 'Dots', neon: 'Neon' };
const ARENA_LABELS = { small: 'Small', medium: 'Medium', large: 'Large' };

function segmented(container, options, current, label, onPick, disabled) {
  container.replaceChildren(...options.map((v) => el('button', {
    type: 'button',
    textContent: label(v),
    className: v === current ? 'sel' : '',
    disabled: !!disabled,
    onclick: () => onPick(v),
  })));
}

function renderLobby() {
  const host = isHost();
  const m = me();
  $('lobbyCode').textContent = state.code;
  $('playerCount').textContent = `(${state.players.length}/${cfg.maxPlayers})`;

  $('playerList').replaceChildren(...state.players.map((p) => {
    const tags = [];
    if (p.id === state.hostId) tags.push(el('span', { className: 'tag host', textContent: 'host' }));
    if (p.bot) tags.push(el('span', { className: 'tag bot', textContent: 'bot' }));
    else if (!p.connected) tags.push(el('span', { className: 'tag off', textContent: 'offline' }));
    else if (p.id !== state.hostId) tags.push(el('span', { className: `tag ${p.ready ? 'ready' : ''}`, textContent: p.ready ? 'ready ✓' : 'not ready' }));
    if (p.bot && host) tags.push(el('button', { className: 'x-btn', textContent: '✕', title: 'Remove bot', onclick: () => socket.emit('removeBot', p.id) }));
    return el('li', { className: p.connected ? '' : 'offline' }, [
      el('span', { className: 'swatch', style: `background:${p.color};color:${p.color}` }),
      el('span', { className: 'pname', textContent: p.name + (p.id === myId ? ' (you)' : '') }),
      el('span', { className: 'tags' }, tags),
    ]);
  }));

  $('addBotBtn').classList.toggle('hidden', !host);
  $('addBotBtn').disabled = state.players.length >= cfg.maxPlayers;

  const others = state.players.filter((p) => !p.bot && p.id !== state.hostId);
  const notReady = others.filter((p) => !p.ready).length;
  $('startBtn').classList.toggle('hidden', !host);
  $('readyBtn').classList.toggle('hidden', host);
  if (m) {
    $('readyBtn').textContent = m.ready ? 'Ready ✓ (tap to undo)' : "I'm ready";
    $('readyBtn').classList.toggle('off', !!m.ready);
  }
  if (host) {
    $('startBtn').textContent = state.players.length < 2 ? 'Start practice (solo)' : `Start match (${state.players.length} snakes)`;
    $('lobbyHint').textContent = state.players.length < 2
      ? 'Playing alone is practice. Add a bot or invite friends for a real match.'
      : notReady ? `Waiting on ${notReady} player${notReady > 1 ? 's' : ''} to ready up — you can start anyway.` : 'Everyone is ready!';
  } else {
    $('lobbyHint').textContent = 'Waiting for the host to start…';
  }

  // Look picker
  const taken = new Set(state.players.filter((p) => p.id !== myId).map((p) => p.color));
  $('colorPicker').replaceChildren(...cfg.colors.map((c) => el('button', {
    type: 'button',
    title: taken.has(c) ? 'Taken' : 'Pick color',
    className: m && m.color === c ? 'sel' : '',
    disabled: taken.has(c),
    style: `background:${c};color:${c}`,
    onclick: () => socket.emit('look', { color: c }),
  })));
  segmented($('skinPicker'), cfg.skins, m && m.skin, (s) => SKIN_LABELS[s], (skin) => socket.emit('look', { skin }));
  drawLookPreview();

  // Host settings
  const st = state.settings;
  $('settingsNote').textContent = host ? '' : '(host decides)';
  const set = (patch) => socket.emit('settings', { ...st, ...patch });
  segmented($('setWins'), cfg.winsOptions, st.winsToMatch, (v) => String(v), (v) => set({ winsToMatch: v }), !host);
  segmented($('setArena'), cfg.arenas, st.arena, (v) => ARENA_LABELS[v], (v) => set({ arena: v }), !host);
  segmented($('setShrink'), cfg.shrinkOptions, st.shrinkAfter, (v) => `${v}s`, (v) => set({ shrinkAfter: v }), !host);
}

function drawLookPreview() {
  const m = me();
  const c = $('lookPreview');
  if (!m || !c.isConnected) return;
  const g = c.getContext('2d');
  const w = c.clientWidth || 360;
  const h = c.clientHeight || 72;
  const r = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * r)) { c.width = Math.round(w * r); c.height = Math.round(h * r); }
  g.setTransform(r, 0, 0, r, 0, 0);
  g.clearRect(0, 0, w, h);
  const pts = [];
  // Same point spacing as in game (every other body point = 16 units)
  for (let i = 0; i < 18; i++) {
    const x = w - 40 - i * 16;
    pts.push([x, h / 2 + Math.sin(i * 0.64 + 0.8) * 14]);
  }
  drawSnake(g, pts, { color: m.color, skin: m.skin, R: 9, name: null, glow: 12, angle: 0, fx: [0, 0, 0, 0], px: 1 });
}

// ---------- Game state ----------
socket.on('state', (s) => {
  if (!myId) return;
  const prevPhase = state && state.phase;
  const freshTick = !state || s.tick !== state.tick || s.round !== state.round || s.phase !== state.phase;
  if (freshTick) {
    prevBodies = state && state.phase === 'playing' && s.phase === 'playing' && s.round === state.round
      ? new Map(state.players.map((p) => [p.id, p.body]))
      : new Map();
    const now = performance.now();
    // Track the real gap between server updates so interpolation stays smooth even if timers drift
    if (prevBodies.size && lastStateAt) stateGap = Math.min(120, Math.max(30, stateGap * 0.9 + (now - lastStateAt) * 0.1));
    lastStateAt = now;
  }

  // Orbs arrive as deltas (or a full list after joining / a new round)
  const oldMe = me();
  if (s.orbFull) {
    orbs.clear();
    for (const [id, x, y, v] of s.orbFull) orbs.set(id, [x, y, v]);
  } else if (s.orbAdd) {
    for (const id of s.orbDel) {
      const o = orbs.get(id);
      if (o && oldMe && oldMe.alive && Math.hypot(o[0] - oldMe.body[0], o[1] - oldMe.body[1]) < 70) {
        popup(o[0], o[1] - 10, `+${o[2]}`, o[2] >= 6 ? '#ffd23f' : '#9effc8');
        burst(o[0], o[1], o[2] >= 6 ? '#ffd23f' : '#9effc8', o[2] >= 6 ? 10 : 4, 60);
        sfx.eat();
      }
      orbs.delete(id);
    }
    for (const [id, x, y, v] of s.orbAdd) orbs.set(id, [x, y, v]);
  }

  state = s;

  if (s.phase === 'lobby') {
    if (!screens.lobby.classList.contains('active')) show('lobby');
    renderLobby();
    return;
  }
  if (!screens.game.classList.contains('active')) show('game');

  if (s.phase === 'countdown' && prevPhase !== 'countdown') {
    countdownEnd = performance.now() + s.countdown;
    myLastLen = 0;
    lastSent = { angle: null, at: 0 };
    desiredAngle = null;
    particles.length = 0;
    popups.length = 0;
  }
  if (s.phase === 'playing' && prevPhase === 'countdown') sfx.go();

  for (const ev of s.events) handleEvent(ev);
  if (prevPhase === 'playing' && (s.phase === 'roundover' || s.phase === 'matchover')) sfx.win();

  const m = me();
  if (m && m.alive) myLastLen = m.length;

  renderHud();
  renderScores();
  renderOverlay();
});

function handleEvent(ev) {
  if (ev.type === 'death') {
    addFeed(ev);
    const p = state.players.find((q) => q.id === ev.id);
    burst(ev.x, ev.y, ev.color, 40, 260);
    ring(ev.x, ev.y, ev.color);
    if (ev.id === myId) { shake = Math.max(shake, 16); sfx.die(); }
    if (ev.killerId === myId) {
      shake = Math.max(shake, 8);
      const m = me();
      if (m && m.body.length) popup(m.body[0], m.body[1] - 30, 'KO!', '#ffd23f', true);
      sfx.ko();
    }
    if (p && ev.id !== myId && ev.killerId !== myId) beep(220, 0.12, 'sawtooth', 0.025);
  } else if (ev.type === 'shield') {
    ring(ev.x, ev.y, '#4dd2ff');
    burst(ev.x, ev.y, '#4dd2ff', 24, 180);
    if (ev.id === myId) { popup(ev.x, ev.y - 30, 'SHIELD SAVED YOU!', '#4dd2ff', true); shake = Math.max(shake, 8); }
    sfx.shield();
  } else if (ev.type === 'power') {
    burst(ev.x, ev.y, POWER_COLORS[ev.power], 18, 160);
    if (ev.id === myId) {
      popup(ev.x, ev.y - 24, `${ev.power.toUpperCase()}!`, POWER_COLORS[ev.power], true);
      sfx.power();
    }
  }
}

function addFeed(ev) {
  const msg = { wall: 'hit the wall', headon: 'crashed head-on', left: 'left the game' }[ev.cause];
  const line = el('div');
  line.append(el('b', { textContent: ev.name, style: `color:${ev.color}` }));
  line.append(ev.killer ? ` crashed into ${ev.killer}` : ` ${msg || 'crashed'}`);
  $('feed').append(line);
  while ($('feed').children.length > 4) $('feed').firstChild.remove();
  setTimeout(() => line.remove(), 3100);
}

function renderHud() {
  $('hudCode').textContent = state.code;
  $('hudRound').textContent = `Round ${state.round}`;
  $('winsTo').textContent = state.settings.winsToMatch;
  const status = $('hudStatus');
  status.classList.remove('danger');
  if (state.phase === 'playing') {
    const left = Math.ceil(((state.shrinkAt - state.tick) * cfg.tickMs) / 1000);
    if (left > 0) {
      status.textContent = `Walls close in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    } else {
      status.textContent = 'WALLS CLOSING!';
      status.classList.add('danger');
    }
  } else if (state.phase === 'countdown') {
    status.textContent = 'Get ready…';
  } else {
    status.textContent = '';
  }

  // Active power-ups
  const m = me();
  const canBoost = m && m.alive && (state.phase === 'playing' || state.phase === 'countdown');
  $('boostBtn').classList.toggle('hidden', !canBoost);
  if (!canBoost) setBoost(false);
  const chips = [];
  if (m && m.alive) {
    const [mag, ghost, shield] = m.fx;
    if (mag) chips.push(el('span', { className: 'chip magnet', textContent: `Magnet ${mag}s` }));
    if (ghost) chips.push(el('span', { className: 'chip ghost', textContent: `Ghost ${ghost}s` }));
    if (shield) chips.push(el('span', { className: 'chip shield', textContent: 'Shield' }));
  }
  $('effects').replaceChildren(...chips);
}

function renderScores() {
  const sorted = [...state.players].sort((a, b) => b.wins - a.wins || b.length - a.length);
  $('scoreList').replaceChildren(...sorted.map((p) => {
    let status = p.alive ? `length ${p.length}` : p.inRound ? 'out' : 'next round';
    if (!p.connected && !p.bot) status = 'offline · autopilot';
    return el('li', { className: `${p.alive ? '' : 'dead'} ${p.id === myId ? 'me' : ''}` }, [
      el('span', { className: 'swatch', style: `background:${p.color};color:${p.color}` }),
      el('span', { className: 'name', textContent: p.name + (p.id === myId ? ' (you)' : '') }),
      el('span', { className: 'stars', textContent: '★'.repeat(p.wins) + '☆'.repeat(Math.max(0, state.settings.winsToMatch - p.wins)) }),
      el('span', { className: 'sub', textContent: `${status} · ${p.stats.kills} KO` }),
    ]);
  }));
}

function statsTable() {
  const rows = [...state.players].sort((a, b) => b.wins - a.wins || b.stats.kills - a.stats.kills);
  const secs = (p) => Math.round((p.stats.aliveTicks * cfg.tickMs) / 1000);
  const max = (f) => Math.max(...rows.map(f));
  const best = { kills: max((p) => p.stats.kills), len: max((p) => p.stats.maxLen), time: max(secs), eaten: max((p) => p.stats.eaten) };
  const cell = (v, isBest, suffix = '') => el('td', { className: isBest && v > 0 ? 'best' : '', textContent: `${v}${suffix}` });
  const table = el('table', { className: 'stats' }, [
    el('thead', {}, el('tr', {}, ['Player', 'Wins', 'KOs', 'Longest', 'Survived', 'Orbs'].map((h) => el('th', { textContent: h })))),
    el('tbody', {}, rows.map((p) => el('tr', { className: p.id === myId ? 'me' : '' }, [
      el('td', {}, [el('span', { className: 'swatch', style: `display:inline-block;margin-right:6px;background:${p.color};color:${p.color}` }), p.name]),
      el('td', { textContent: p.wins }),
      cell(p.stats.kills, p.stats.kills === best.kills),
      cell(p.stats.maxLen, p.stats.maxLen === best.len),
      cell(secs(p), secs(p) === best.time, 's'),
      cell(p.stats.eaten, p.stats.eaten === best.eaten),
    ]))),
  ]);
  const pick = (f) => rows.reduce((a, b) => (f(b) > f(a) ? b : a));
  const awards = el('div', { className: 'awards' });
  if (best.kills > 0) awards.append(el('span', { textContent: `⚔ Most KOs: ${pick((p) => p.stats.kills).name}` }));
  awards.append(el('span', { textContent: `🐍 Longest snake: ${pick((p) => p.stats.maxLen).name}` }));
  awards.append(el('span', { textContent: `⏱ Survivor: ${pick(secs).name}` }));
  return [awards, table];
}

function renderOverlay() {
  const o = $('overlay');
  const m = me();
  const r = state.result;
  const host = isHost();
  let content = null;
  let mode = '';

  if (state.phase === 'countdown') {
    const how = isTouch ? 'Drag anywhere to steer · hold BOOST to speed up' : 'Steer with your mouse · hold click or Space to boost';
    const you = m && m.alive ? el('div', { className: 'sub' }, [
      'You are ',
      el('b', { textContent: '■ this color', style: `color:${m.color}` }),
      el('br'),
      how,
    ]) : el('div', { className: 'sub', textContent: 'Spectating — you join next round' });
    content = [el('div', { className: 'big', id: 'countNum', textContent: '3' }), you];
  } else if (state.phase === 'playing') {
    if (m && !m.alive) {
      mode = 'passive';
      content = [
        el('div', { className: 'title', textContent: m.inRound ? 'You crashed!' : 'Spectating' }),
        el('div', { className: 'sub', textContent: m.inRound ? 'Watch the rest of the round…' : 'You will join next round.' }),
      ];
    }
  } else if (state.phase === 'roundover') {
    content = [
      el('div', { className: 'title', textContent: r && r.practice ? 'Practice over' : r && r.winner ? `${r.winner.name} wins the round!` : 'Draw — nobody survived!' }),
      el('div', { className: 'sub', textContent: r && r.practice ? 'Add a bot or invite a friend for a real match. Next try starting…' : 'Next round starting…' }),
    ];
    if (r && r.winner) content[0].style.color = r.winner.color;
  } else if (state.phase === 'matchover') {
    mode = 'match';
    const btns = host
      ? el('div', { className: 'row' }, [
        el('button', { className: 'btn primary', textContent: 'Rematch', onclick: () => socket.emit('start') }),
        el('button', { className: 'btn', textContent: 'Back to lobby', onclick: () => socket.emit('toLobby') }),
      ])
      : el('div', { className: 'sub', textContent: 'Waiting for the host to start a rematch…' });
    content = [
      el('div', { className: 'title', textContent: `🏆 ${r.winner.name} wins the match!`, style: `color:${r.winner.color}` }),
      ...statsTable(),
      btns,
      el('button', { className: 'btn ghost small', textContent: 'Leave room', onclick: leave }),
    ];
  }

  o.className = `overlay ${mode}`;
  o.classList.toggle('hidden', !content);
  const key = `${state.phase}|${state.round}|${m && m.alive}|${host}`;
  if (content && o.dataset.key !== key) o.replaceChildren(...content);
  o.dataset.key = key;
}

// ---------- Input: free-angle steering ----------
// Mouse: the head turns toward the pointer. Keys: 8-way (arrows/WASD combined).
// Touch: drag anywhere like a virtual joystick.
let inputMode = isTouch ? 'touch' : 'mouse';
let mouse = null; // last pointer position in client coords
let touchAngle = null;
let desiredAngle = null; // where the player wants to go right now (used for prediction too)
const held = new Set();
let lastSent = { angle: null, at: 0 };
let boostOn = false;

const KEYS = {
  ArrowUp: [0, -1], KeyW: [0, -1],
  ArrowDown: [0, 1], KeyS: [0, 1],
  ArrowLeft: [-1, 0], KeyA: [-1, 0],
  ArrowRight: [1, 0], KeyD: [1, 0],
};

function canSteer() {
  return state && (state.phase === 'playing' || state.phase === 'countdown');
}

function sendSteer(angle, now) {
  if (angle == null || !canSteer()) return;
  const diff = lastSent.angle == null ? Infinity : Math.abs(wrapAngle(angle - lastSent.angle));
  if (diff < 0.02 || now - lastSent.at < 33) return;
  lastSent = { angle, at: now };
  socket.emit('steer', angle);
}

function setBoost(on) {
  if (on === boostOn) return;
  boostOn = on;
  $('boostBtn').classList.toggle('on', on);
  socket.emit('boost', on);
}

function keyAngle() {
  let x = 0;
  let y = 0;
  for (const code of held) { x += KEYS[code][0]; y += KEYS[code][1]; }
  return x || y ? Math.atan2(y, x) : null;
}

document.addEventListener('keydown', (e) => {
  if (!screens.game.classList.contains('active')) return;
  if (e.code === 'Space') { e.preventDefault(); setBoost(true); return; }
  if (!KEYS[e.code]) return;
  e.preventDefault();
  held.add(e.code);
  inputMode = 'keys';
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') setBoost(false);
  held.delete(e.code);
});
window.addEventListener('blur', () => { held.clear(); setBoost(false); });

screens.game.addEventListener('mousemove', (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  if (held.size === 0) inputMode = 'mouse';
});
$('stage').addEventListener('mousedown', (e) => {
  if (e.button === 0 && !e.target.closest('button, .overlay:not(.passive)')) setBoost(true);
});
document.addEventListener('mouseup', () => setBoost(false));

// Virtual joystick for touch screens
const stick = el('div', { className: 'stick hidden' }, [el('div', { className: 'knob' })]);
document.body.append(stick);
let touchOrigin = null;
screens.game.addEventListener('touchstart', (e) => {
  const t = [...e.changedTouches].find((tt) => !tt.target.closest('button, .overlay:not(.passive)'));
  if (!t || touchOrigin) return;
  touchOrigin = { id: t.identifier, x: t.clientX, y: t.clientY };
  inputMode = 'touch';
  stick.style.left = `${t.clientX}px`;
  stick.style.top = `${t.clientY}px`;
  stick.firstChild.style.transform = '';
  stick.classList.remove('hidden');
}, { passive: true });
screens.game.addEventListener('touchmove', (e) => {
  if (!touchOrigin) return;
  const t = [...e.changedTouches].find((tt) => tt.identifier === touchOrigin.id);
  if (!t) return;
  const dx = t.clientX - touchOrigin.x;
  const dy = t.clientY - touchOrigin.y;
  const d = Math.hypot(dx, dy);
  if (d < 8) return;
  touchAngle = Math.atan2(dy, dx);
  const k = Math.min(d, 40) / d;
  stick.firstChild.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
}, { passive: true });
function endTouch(e) {
  if (touchOrigin && [...e.changedTouches].some((t) => t.identifier === touchOrigin.id)) {
    touchOrigin = null;
    stick.classList.add('hidden');
  }
}
screens.game.addEventListener('touchend', endTouch);
screens.game.addEventListener('touchcancel', endTouch);

const boostBtn = $('boostBtn');
boostBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); setBoost(true); });
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) boostBtn.addEventListener(ev, () => setBoost(false));
boostBtn.addEventListener('contextmenu', (e) => e.preventDefault());

function updateSteering(now, myHead) {
  if (!canSteer()) return;
  if (inputMode === 'keys') desiredAngle = keyAngle() ?? desiredAngle;
  else if (inputMode === 'touch') desiredAngle = touchAngle ?? desiredAngle;
  else if (inputMode === 'mouse' && mouse && myHead) {
    const [hx, hy] = toScreen(myHead);
    if (Math.hypot(mouse.x - hx, mouse.y - hy) > 4) desiredAngle = Math.atan2(mouse.y - hy, mouse.x - hx);
  }
  sendSteer(desiredAngle, now);
}

$('helpBtn').onclick = () => $('rulesModal').classList.remove('hidden');
$('rulesModal').addEventListener('click', (e) => { if (e.target === $('rulesModal')) $('rulesModal').classList.add('hidden'); });

// ---------- Client-side prediction ----------
// Your own snake is simulated forward from the last server state using your *current* input,
// so steering feels instant even with network latency. The server stays authoritative.
function predictMe(p, now) {
  const pts = [];
  for (let i = 0; i < p.body.length; i += 2) pts.push([p.body[i], p.body[i + 1]]);
  let angle = p.angle;
  const target = desiredAngle ?? p.angle;
  const speed = boostOn && p.length > cfg.minBoost ? cfg.boostSpeed : cfg.speed;
  let ahead = Math.min(8, (now - lastStateAt) / cfg.tickMs + Math.min(6, rtt / 2 / cfg.tickMs));
  while (ahead > 0.001) {
    const f = Math.min(1, ahead);
    ahead -= f;
    const dt = (cfg.tickMs / 1000) * f;
    const mt = cfg.turnRate * dt;
    const gap = cfg.seg * 2; // the server sends every other body point
    angle = wrapAngle(angle + Math.max(-mt, Math.min(mt, wrapAngle(target - angle))));
    pts[0][0] += Math.cos(angle) * speed * dt;
    pts[0][1] += Math.sin(angle) * speed * dt;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d > gap) {
        b[0] = a[0] + ((b[0] - a[0]) / d) * gap;
        b[1] = a[1] + ((b[1] - a[1]) / d) * gap;
      }
    }
  }
  return { pts, angle };
}

// Smoothly blend every body point between the last two server ticks
function lerpBody(id, body, t) {
  const prev = prevBodies.get(id);
  const pts = [];
  for (let i = 0; i < body.length; i += 2) {
    let x = body[i];
    let y = body[i + 1];
    if (prev && i + 1 < prev.length) {
      const px = prev[i];
      const py = prev[i + 1];
      if (Math.abs(px - x) + Math.abs(py - y) < 40) {
        x = px + (x - px) * t;
        y = py + (y - py) * t;
      }
    }
    pts.push([x, y]);
  }
  return pts;
}

// ---------- Effects ----------
const POWER_COLORS = { magnet: '#ff8c42', ghost: '#c77dff', shield: '#4dd2ff' };

function burst(x, y, color, n, speed) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.3 + Math.random() * 0.7);
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, decay: 1.2 + Math.random(), size: 2 + Math.random() * 3, color });
  }
  if (particles.length > 600) particles.splice(0, particles.length - 600);
}

function ring(x, y, color) {
  particles.push({ x, y, vx: 0, vy: 0, life: 1, decay: 1.8, size: 0, color, ring: true });
}

function popup(x, y, text, color, big = false) {
  popups.push({ x, y, text, color, big, born: performance.now() });
  if (popups.length > 40) popups.shift();
}

// ---------- Rendering ----------
function resize() {
  if (!state) return;
  const stage = $('stage');
  const pad = window.innerWidth <= 760 ? 12 : 24;
  cssW = Math.max(100, Math.floor(stage.clientWidth - pad));
  cssH = Math.max(100, Math.floor(stage.clientHeight - pad));
  fitScale = Math.min(cssW / state.w, cssH / state.h);
  // Follow-camera zoom: roughly the same amount of arena visible on any screen
  zoomScale = Math.min(1.5, Math.max(0.55, Math.sqrt(cssW * cssH) / 820));
  dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
}
window.addEventListener('resize', resize);
new ResizeObserver(() => { resize(); drawLookPreview(); }).observe($('stage'));

function toScreen([x, y]) {
  const rect = canvas.getBoundingClientRect();
  return [rect.left + cssW / 2 + (x - view.cx) * view.s, rect.top + cssH / 2 + (y - view.cy) * view.s];
}

function toWorld(sx, sy) {
  const rect = canvas.getBoundingClientRect();
  return [(sx - rect.left - cssW / 2) / view.s + view.cx, (sy - rect.top - cssH / 2) / view.s + view.cy];
}

// The camera is always centred on a snake: yours, or (once you're out) the longest one still alive.
// With nobody alive it zooms out to show the whole arena.
function updateCamera(focus) {
  if (focus) {
    view.s = zoomScale;
    view.cx = focus[0];
    view.cy = focus[1];
  } else {
    view.s = fitScale;
    view.cx = state.w / 2;
    view.cy = state.h / 2;
  }
}

function strokePath(g, pts) {
  g.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
  if (pts.length === 1) g.lineTo(pts[0][0] + 0.01, pts[0][1]);
  g.stroke();
}

// Draws one snake with its skin. Used by the game and the lobby preview.
function drawSnake(g, pts, o) {
  const { color, skin, R, fx, px } = o;
  const [, ghost, shield, invuln] = fx;
  const now = performance.now();
  g.save();
  if (ghost) g.globalAlpha = 0.42 + 0.1 * Math.sin(now / 90);
  if (invuln && Math.floor(now / 80) % 2) g.globalAlpha = 0.35;
  g.lineCap = 'round';
  g.lineJoin = 'round';

  // Body
  g.shadowColor = color;
  g.shadowBlur = o.glow;
  g.strokeStyle = color;
  g.lineWidth = R * 2;
  strokePath(g, pts);
  g.shadowBlur = 0;

  if (skin === 'neon') {
    g.strokeStyle = '#0b0f14';
    g.lineWidth = R * 1.25;
    strokePath(g, pts);
    g.strokeStyle = color;
    g.lineWidth = R * 0.35;
    strokePath(g, pts);
  } else if (skin === 'stripes') {
    g.fillStyle = 'rgba(0,0,0,0.3)';
    for (let i = 2; i < pts.length; i += 2) {
      g.beginPath();
      g.arc(pts[i][0], pts[i][1], R * 0.92, 0, Math.PI * 2);
      g.fill();
    }
  } else if (skin === 'dots') {
    g.fillStyle = 'rgba(255,255,255,0.75)';
    for (let i = 2; i < pts.length; i++) {
      g.beginPath();
      g.arc(pts[i][0], pts[i][1], R * 0.3, 0, Math.PI * 2);
      g.fill();
    }
  } else {
    g.strokeStyle = 'rgba(0,0,0,0.2)';
    g.lineWidth = R * 0.55;
    strokePath(g, pts);
  }

  // Head + eyes looking where the snake is going
  const [hx, hy] = pts[0];
  const a = pts.length > 1 ? Math.atan2(hy - pts[1][1], hx - pts[1][0]) : o.angle;
  const fxx = Math.cos(a);
  const fyy = Math.sin(a);
  g.fillStyle = color;
  g.beginPath();
  g.arc(hx, hy, R * 1.15, 0, Math.PI * 2);
  g.fill();
  for (const s of [-1, 1]) {
    const ex = hx + fxx * R * 0.35 - fyy * s * R * 0.5;
    const ey = hy + fyy * R * 0.35 + fxx * s * R * 0.5;
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(ex, ey, R * 0.36, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#000';
    g.beginPath(); g.arc(ex + fxx * R * 0.14, ey + fyy * R * 0.14, R * 0.18, 0, Math.PI * 2); g.fill();
  }
  g.restore();

  // Shield bubble around the head
  if (shield) {
    g.strokeStyle = `rgba(77,210,255,${0.6 + 0.3 * Math.sin(now / 150)})`;
    g.lineWidth = 2.5 * px;
    g.beginPath();
    g.arc(hx, hy, R * 2.1, 0, Math.PI * 2);
    g.stroke();
  }

  if (o.name) {
    // Put the tag on the side of the head away from the body so it never sits on the snake
    const below = fyy > 0.35;
    g.font = `800 ${Math.max(11 * px, R * 1.3)}px Inter, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = below ? 'top' : 'alphabetic';
    g.lineWidth = 3 * px;
    g.strokeStyle = 'rgba(7,10,14,0.7)';
    const ty = below ? hy + R * 2.2 : hy - R * 2.2;
    g.strokeText(o.name, hx, ty);
    g.fillStyle = o.nameColor || 'rgba(232,240,247,0.85)';
    g.fillText(o.name, hx, ty);
    g.textBaseline = 'alphabetic';
  }
}

// Power-up icons drawn as simple vector shapes
function drawPowerup(g, x, y, type, now, px) {
  const c = POWER_COLORS[type];
  const bob = Math.sin(now / 250 + x) * 3;
  y += bob;
  g.save();
  g.shadowColor = c;
  g.shadowBlur = 18;
  g.fillStyle = 'rgba(11,15,20,0.85)';
  g.strokeStyle = c;
  g.lineWidth = 2.5 * px;
  g.beginPath();
  g.arc(x, y, 16, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.shadowBlur = 0;
  g.strokeStyle = c;
  g.fillStyle = c;
  g.lineWidth = 3;
  g.lineCap = 'round';
  if (type === 'magnet') {
    g.beginPath();
    g.arc(x, y - 1, 6.5, Math.PI, 0, true);
    g.moveTo(x - 6.5, y - 1); g.lineTo(x - 6.5, y - 7);
    g.moveTo(x + 6.5, y - 1); g.lineTo(x + 6.5, y - 7);
    g.stroke();
  } else if (type === 'ghost') {
    g.beginPath();
    g.arc(x, y - 2, 7, Math.PI, 0);
    g.lineTo(x + 7, y + 7);
    g.lineTo(x + 3.5, y + 4);
    g.lineTo(x, y + 7);
    g.lineTo(x - 3.5, y + 4);
    g.lineTo(x - 7, y + 7);
    g.closePath();
    g.fill();
    g.fillStyle = '#0b0f14';
    g.beginPath(); g.arc(x - 2.5, y - 2, 1.6, 0, Math.PI * 2); g.arc(x + 2.5, y - 2, 1.6, 0, Math.PI * 2); g.fill();
  } else {
    g.beginPath();
    g.moveTo(x, y - 9);
    g.lineTo(x + 7.5, y - 5.5);
    g.quadraticCurveTo(x + 7, y + 5, x, y + 9);
    g.quadraticCurveTo(x - 7, y + 5, x - 7.5, y - 5.5);
    g.closePath();
    g.fill();
  }
  g.restore();
}

function drawMinimap(snakes, now) {
  const mw = Math.round(Math.min(180, Math.max(110, cssW * 0.22)));
  const ms = mw / state.w;
  const mh = Math.round(state.h * ms);
  const x0 = cssW - mw - 10;
  const y0 = 10;
  const b = state.bounds;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = 'rgba(7,10,14,0.82)';
  ctx.fillRect(x0, y0, mw, mh);
  // Closed-in wall zone
  ctx.fillStyle = 'rgba(255,77,109,0.18)';
  ctx.fillRect(x0, y0, mw, b.y0 * ms);
  ctx.fillRect(x0, y0 + b.y1 * ms, mw, mh - b.y1 * ms);
  ctx.fillRect(x0, y0 + b.y0 * ms, b.x0 * ms, (b.y1 - b.y0) * ms);
  ctx.fillRect(x0 + b.x1 * ms, y0 + b.y0 * ms, mw - b.x1 * ms, (b.y1 - b.y0) * ms);
  ctx.strokeStyle = state.phase === 'playing' && state.tick >= state.shrinkAt ? '#ff4d6d' : '#3a4b60';
  ctx.lineWidth = 1;
  ctx.strokeRect(x0 + b.x0 * ms + 0.5, y0 + b.y0 * ms + 0.5, (b.x1 - b.x0) * ms - 1, (b.y1 - b.y0) * ms - 1);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, mw, mh);
  ctx.clip();
  // Current viewport
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.strokeRect(x0 + (view.cx - cssW / 2 / view.s) * ms, y0 + (view.cy - cssH / 2 / view.s) * ms, (cssW / view.s) * ms, (cssH / view.s) * ms);
  // Power-ups
  for (const [, x, y, type] of state.powerups) {
    ctx.fillStyle = POWER_COLORS[type];
    ctx.fillRect(x0 + x * ms - 1.5, y0 + y * ms - 1.5, 3, 3);
  }
  // Enemies: faint body + solid head dot
  let mine = null;
  for (const s of snakes) {
    if (s.p.id === myId) { mine = s; continue; }
    ctx.strokeStyle = s.p.color;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    s.pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x0 + x * ms, y0 + y * ms) : ctx.lineTo(x0 + x * ms, y0 + y * ms)));
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = s.p.color;
    ctx.beginPath();
    ctx.arc(x0 + s.pts[0][0] * ms, y0 + s.pts[0][1] * ms, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // You: bigger dot with a pulsing white ring, drawn on top
  if (mine) {
    const [hx, hy] = [x0 + mine.pts[0][0] * ms, y0 + mine.pts[0][1] * ms];
    ctx.strokeStyle = mine.p.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    mine.pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x0 + x * ms, y0 + y * ms) : ctx.lineTo(x0 + x * ms, y0 + y * ms)));
    ctx.stroke();
    ctx.fillStyle = mine.p.color;
    ctx.beginPath();
    ctx.arc(hx, hy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(hx, hy, 6 + 1.5 * Math.sin(now / 180), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = '#2b3a4d';
  ctx.lineWidth = 1;
  ctx.strokeRect(x0 - 0.5, y0 - 0.5, mw + 1, mh + 1);
}

// Little arrows on the screen edge pointing at rivals who are off-camera
function drawOffscreenArrows(snakes) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const m = 18;
  for (const { p, pts } of snakes) {
    if (p.id === myId) continue;
    const sx = cssW / 2 + (pts[0][0] - view.cx) * view.s;
    const sy = cssH / 2 + (pts[0][1] - view.cy) * view.s;
    if (sx > 0 && sx < cssW && sy > 0 && sy < cssH) continue;
    const a = Math.atan2(sy - cssH / 2, sx - cssW / 2);
    const kx = (cssW / 2 - m) / Math.abs(Math.cos(a) || 1e-6);
    const ky = (cssH / 2 - m) / Math.abs(Math.sin(a) || 1e-6);
    const k = Math.min(kx, ky);
    ctx.save();
    ctx.translate(cssW / 2 + Math.cos(a) * k, cssH / 2 + Math.sin(a) * k);
    ctx.rotate(a);
    ctx.fillStyle = p.color;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-6, -7);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

let lastFrame = 0;
function draw(now) {
  requestAnimationFrame(draw);
  const dt = Math.min(0.05, (now - (lastFrame || now)) / 1000);
  lastFrame = now;
  if (!state || !cfg || !screens.game.classList.contains('active')) return;

  const W = state.w;
  const H = state.h;
  const b = state.bounds;
  const R = cfg.radius;

  // Interpolate other snakes; predict my own
  const playing = state.phase === 'playing';
  const t = playing ? Math.min(1, (now - lastStateAt) / stateGap) : 1;
  const snakes = state.players.filter((p) => p.alive && p.body.length).map((p) => {
    if (p.id === myId && playing) {
      const pr = predictMe(p, now);
      return { p, pts: pr.pts, angle: pr.angle };
    }
    return { p, pts: lerpBody(p.id, p.body, t), angle: p.angle };
  });
  const mine = snakes.find((s) => s.p.id === myId);
  const myHead = mine ? mine.pts[0] : null;
  const leader = snakes.reduce((best, s) => (!best || s.p.length > best.p.length ? s : best), null);
  const focus = mine || leader;
  updateCamera(focus ? focus.pts[0] : null);
  const px = 1 / view.s; // one CSS pixel in world units

  // Screen shake
  shake *= Math.pow(0.02, dt);
  const sx = shake > 0.3 ? (Math.random() - 0.5) * shake : 0;
  const sy = shake > 0.3 ? (Math.random() - 0.5) * shake : 0;

  // Visible world rectangle (with a margin) for culling
  const vx0 = view.cx - cssW / 2 / view.s - 40;
  const vx1 = view.cx + cssW / 2 / view.s + 40;
  const vy0 = view.cy - cssH / 2 / view.s - 40;
  const vy1 = view.cy + cssH / 2 / view.s + 40;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#070a0e';
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * (cssW / 2 - view.cx * view.s + sx), dpr * (cssH / 2 - view.cy * view.s + sy));

  // Wall zone (closed-in area) and arena floor
  ctx.fillStyle = '#2a0f17';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#0e141b';
  ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);

  // Dot grid (only the visible part)
  ctx.fillStyle = '#1a2531';
  const g = 32;
  const gx0 = Math.max(b.x0, vx0);
  const gx1 = Math.min(b.x1, vx1);
  const gy0 = Math.max(b.y0, vy0);
  const gy1 = Math.min(b.y1, vy1);
  for (let x = Math.ceil((gx0 - g / 2) / g) * g + g / 2; x < gx1; x += g) {
    for (let y = Math.ceil((gy0 - g / 2) / g) * g + g / 2; y < gy1; y += g) {
      ctx.fillRect(x - px, y - px, 2 * px, 2 * px);
    }
  }

  // Arena border
  const closing = playing && state.tick >= state.shrinkAt;
  ctx.strokeStyle = closing ? `rgba(255,77,109,${0.6 + 0.4 * Math.sin(now / 120)})` : '#2b3a4d';
  ctx.lineWidth = (closing ? 3 : 2) * px;
  ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);

  // Orbs
  const pulse = 0.85 + 0.15 * Math.sin(now / 200);
  for (const [x, y, v] of orbs.values()) {
    if (x < vx0 || x > vx1 || y < vy0 || y > vy1) continue;
    const gold = v >= 6;
    const tiny = v <= 1;
    ctx.fillStyle = gold ? '#ffd23f' : '#9effc8';
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = gold ? 14 : 8;
    ctx.beginPath();
    ctx.arc(x, y, cfg.orbR * (gold ? 1.5 : tiny ? 0.7 : 1) * pulse, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;

  // Power-ups
  for (const [, x, y, type] of state.powerups) {
    if (x < vx0 || x > vx1 || y < vy0 || y > vy1) continue;
    drawPowerup(ctx, x, y, type, now, px);
  }

  // Magnet aura (under the snakes)
  for (const { p, pts } of snakes) {
    if (!p.fx[0]) continue;
    ctx.strokeStyle = 'rgba(255,140,66,0.25)';
    ctx.lineWidth = 2 * px;
    ctx.setLineDash([8 * px, 8 * px]);
    ctx.lineDashOffset = -now / 40;
    ctx.beginPath();
    ctx.arc(pts[0][0], pts[0][1], 180, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Snakes (mine last, on top)
  const order = snakes.filter((s) => s !== mine).concat(mine ? [mine] : []);
  for (const { p, pts, angle } of order) {
    const isMe = p.id === myId;
    const label = isMe ? (state.phase === 'countdown' || state.tick < 50 ? 'YOU' : null) : p.name;
    drawSnake(ctx, pts, {
      color: p.color, skin: p.skin, R, fx: p.fx, px, angle,
      glow: p.boosting ? 26 : isMe ? 14 : 6,
      name: label,
      nameColor: isMe ? '#fff' : null,
    });
  }

  // Particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const q = particles[i];
    q.life -= q.decay * dt;
    if (q.life <= 0) { particles.splice(i, 1); continue; }
    ctx.globalAlpha = Math.max(0, q.life);
    if (q.ring) {
      ctx.strokeStyle = q.color;
      ctx.lineWidth = 3 * px;
      ctx.beginPath();
      ctx.arc(q.x, q.y, (1 - q.life) * 70 + 8, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.vx *= 0.93;
      q.vy *= 0.93;
      ctx.fillStyle = q.color;
      ctx.beginPath();
      ctx.arc(q.x, q.y, q.size * q.life + 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // Floating text popups (+2, KO!, MAGNET!)
  for (let i = popups.length - 1; i >= 0; i--) {
    const u = popups[i];
    const age = (now - u.born) / (u.big ? 1300 : 800);
    if (age >= 1) { popups.splice(i, 1); continue; }
    ctx.globalAlpha = 1 - age * age;
    ctx.font = `800 ${(u.big ? 22 : 14) * px * (u.big ? 1 + 0.3 * Math.max(0, 0.2 - age) * 5 : 1)}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.lineWidth = 3 * px;
    ctx.strokeStyle = 'rgba(7,10,14,0.8)';
    ctx.strokeText(u.text, u.x, u.y - age * 40);
    ctx.fillStyle = u.color;
    ctx.fillText(u.text, u.x, u.y - age * 40);
  }
  ctx.globalAlpha = 1;

  // Aim line from my head toward the pointer during the countdown
  if (state.phase === 'countdown' && myHead && inputMode === 'mouse' && mouse) {
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.setLineDash([6 * px, 6 * px]);
    ctx.lineWidth = 2 * px;
    ctx.beginPath();
    ctx.moveTo(myHead[0], myHead[1]);
    ctx.lineTo(...toWorld(mouse.x, mouse.y));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (focus) drawOffscreenArrows(snakes);
  drawMinimap(snakes, now);

  // When you're out, say whose snake the camera is following
  if (focus && focus !== mine) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '800 14px Inter, sans-serif';
    ctx.textAlign = 'center';
    const label = 'Watching ';
    const wl = ctx.measureText(label).width;
    const wn = ctx.measureText(focus.p.name).width;
    ctx.fillStyle = 'rgba(232,240,247,0.85)';
    ctx.fillText(label, cssW / 2 - wn / 2, cssH - 18);
    ctx.fillStyle = focus.p.color;
    ctx.fillText(focus.p.name, cssW / 2 + wl / 2, cssH - 18);
  }

  updateSteering(now, myHead);

  if (state.phase === 'countdown') {
    const n = $('countNum');
    const left = Math.max(1, Math.ceil((countdownEnd - now) / 1000));
    if (n && n.textContent !== String(left)) { n.textContent = left; sfx.tick(); }
  }
}
requestAnimationFrame(draw);
