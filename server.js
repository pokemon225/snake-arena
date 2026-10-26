const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));

// ---- Game constants (world units) ----
const TICK_MS = 50;
const DT = TICK_MS / 1000;
const SEG = 8; // spacing between body points
const RADIUS = 9; // snake thickness (radius)
const START_LENGTH = 14; // body points
const SPEED = 150; // units per second
const BOOST_SPEED = 270;
const TURN_RATE = 5.2; // radians per second
const MIN_BOOST_LENGTH = 10;
const BOOST_COST_TICKS = 3; // lose 1 point every N boosting ticks
const ORB_R = 5;
const MAX_PLAYERS = 8;
const MAX_ORBS = 500;
const COUNTDOWN_MS = 3000;
const ROUND_OVER_MS = 4000;
const SHRINK_SPEED = 30; // units per second, per side
const MIN_ARENA_W = 420;
const MIN_ARENA_H = 280;
const RECONNECT_GRACE_MS = 30000;
const GRID = 40; // spatial hash cell size

const ARENAS = { small: [1600, 1080], medium: [2400, 1600], large: [3200, 2140] };
const WINS_OPTIONS = [1, 3, 5];
const SHRINK_OPTIONS = [30, 60, 90];
const COLORS = ['#39ff88', '#ff4d6d', '#4dd2ff', '#ffd23f', '#c77dff', '#ff8c42', '#f15bb5', '#f0f0f0'];
const SKINS = ['solid', 'stripes', 'dots', 'neon'];
const BOT_NAMES = ['Bot Ada', 'Bot Rex', 'Bot Kiwi', 'Bot Zap', 'Bot Nova', 'Bot Pip', 'Bot Juno', 'Bot Fang'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

// Power-ups: durations in ticks
const POWER = {
  magnet: { ticks: Math.round(8000 / TICK_MS) },
  ghost: { ticks: Math.round(4000 / TICK_MS) },
  shield: { ticks: 0 }, // lasts until it saves you once
};
const POWER_TYPES = Object.keys(POWER);
const POWER_EVERY_TICKS = Math.round(6000 / TICK_MS);
const MAGNET_RANGE = 180;
const INVULN_TICKS = Math.round(1000 / TICK_MS);

const CONFIG = { tickMs: TICK_MS, seg: SEG, radius: RADIUS, orbR: ORB_R, speed: SPEED, boostSpeed: BOOST_SPEED, turnRate: TURN_RATE, minBoost: MIN_BOOST_LENGTH, maxPlayers: MAX_PLAYERS, colors: COLORS, skins: SKINS, arenas: Object.keys(ARENAS), winsOptions: WINS_OPTIONS, shrinkOptions: SHRINK_OPTIONS };

const rooms = new Map();
const newId = () => crypto.randomBytes(6).toString('hex');

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  const s = String(name || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 12);
  return s || 'Snake';
}

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function dist2(ax, ay, bx, by) {
  return (ax - bx) ** 2 + (ay - by) ** 2;
}

function inBounds(b, x, y, margin = 0) {
  return x >= b.x0 + margin && x <= b.x1 - margin && y >= b.y0 + margin && y <= b.y1 - margin;
}

const humans = (room) => [...room.players.values()].filter((p) => !p.isBot);
const alivePlayers = (room) => [...room.players.values()].filter((p) => p.alive);

function createRoom() {
  const room = {
    code: makeCode(),
    players: new Map(), // token -> player
    hostToken: null,
    phase: 'lobby', // lobby | countdown | playing | roundover | matchover
    phaseEndsAt: 0,
    settings: { winsToMatch: 3, arena: 'medium', shrinkAfter: 60 },
    w: ARENAS.medium[0],
    h: ARENAS.medium[1],
    round: 0,
    tick: 0,
    simTime: 0,
    orbs: new Map(), // id -> {x, y, v}
    nextOrbId: 1,
    orbAdds: new Map(), // orbs created or moved since the last broadcast
    orbNew: new Set(), // ids created since the last broadcast (clients haven't seen them yet)
    orbDels: [], // orb ids removed since the last broadcast
    orbsReset: false,
    powerups: [],
    bounds: { x0: 0, y0: 0, x1: ARENAS.medium[0], y1: ARENAS.medium[1] },
    startedWith: 0,
    lastResult: null,
    events: [],
    timer: null,
  };
  rooms.set(room.code, room);
  return room;
}

function newPlayer(room, { name, isBot = false, skill = 'normal' }) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  return {
    token: isBot ? `bot-${newId()}` : newId(), // secret, identifies a human across reconnects
    id: newId(), // public id shared with everyone
    socketId: null,
    connected: true,
    disconnectedAt: 0,
    isBot,
    skill: isBot ? skill : null,
    name: cleanName(name),
    color: COLORS.find((c) => !used.has(c)) || COLORS[room.players.size % COLORS.length],
    skin: isBot ? SKINS[Math.floor(Math.random() * SKINS.length)] : 'solid',
    ready: isBot,
    wins: 0,
    stats: { kills: 0, maxLen: 0, aliveTicks: 0, eaten: 0, powerups: 0 },
    body: [],
    angle: 0,
    target: 0,
    boost: false,
    boosting: false,
    boostTicks: 0,
    grow: 0,
    alive: false,
    inRound: false,
    magnet: 0,
    ghost: 0,
    shield: false,
    invuln: 0,
  };
}

function hostPlayer(room) {
  return room.players.get(room.hostToken);
}

function pickHost(room) {
  const h = hostPlayer(room);
  if (h && h.connected) return;
  const next = humans(room).find((p) => p.connected) || humans(room)[0];
  room.hostToken = next ? next.token : null;
}

// ---- Orbs (tracked as deltas so we only send what changed) ----
function addOrb(room, x, y, v) {
  if (room.orbs.size >= MAX_ORBS) return;
  const id = room.nextOrbId++;
  const o = { x, y, v };
  room.orbs.set(id, o);
  room.orbAdds.set(id, o);
  room.orbNew.add(id);
}

// Orbs pulled by a magnet: resend their position
function moveOrb(room, id, o) {
  room.orbAdds.set(id, o);
}

function removeOrb(room, id) {
  room.orbs.delete(id);
  room.orbAdds.delete(id);
  // Only an orb created since the last broadcast is unknown to clients; every other removal must be sent
  if (room.orbNew.has(id)) room.orbNew.delete(id);
  else room.orbDels.push(id);
}

function resetOrbDeltas(room) {
  room.orbAdds = new Map();
  room.orbNew = new Set();
  room.orbDels = [];
}

function clearOrbs(room) {
  room.orbs = new Map();
  resetOrbDeltas(room);
  room.orbsReset = true;
}

function freeSpot(room, margin, clearance) {
  const b = room.bounds;
  for (let tries = 0; tries < 20; tries++) {
    const x = b.x0 + margin + Math.random() * (b.x1 - b.x0 - 2 * margin);
    const y = b.y0 + margin + Math.random() * (b.y1 - b.y0 - 2 * margin);
    let clear = true;
    for (const p of room.players.values()) {
      if (p.alive && p.body.some(([px, py]) => dist2(px, py, x, y) < clearance ** 2)) { clear = false; break; }
    }
    if (clear) return [x, y];
  }
  return null;
}

function topUpOrbs(room) {
  // Scale orb density with the arena that's still open
  const b = room.bounds;
  const area = ((b.x1 - b.x0) * (b.y1 - b.y0)) / (2400 * 1600);
  const target = Math.round((50 + 8 * room.startedWith) * Math.max(0.2, area));
  for (let i = room.orbs.size; i < target; i++) {
    const spot = freeSpot(room, 20, RADIUS + 12);
    if (spot) addOrb(room, spot[0], spot[1], Math.random() < 0.1 ? 6 : 2);
  }
}

// ---- Round setup ----
function spawnSnakes(room) {
  const list = [...room.players.values()];
  const offset = Math.random() * Math.PI * 2;
  const { w: W, h: H } = room;
  list.forEach((p, i) => {
    const a = offset + (i / list.length) * Math.PI * 2;
    const hx = W / 2 + Math.cos(a) * W * 0.3;
    const hy = H / 2 + Math.sin(a) * H * 0.3;
    const facing = Math.atan2(H / 2 - hy, W / 2 - hx);
    p.body = [];
    for (let k = 0; k < START_LENGTH; k++) {
      p.body.push([hx - Math.cos(facing) * SEG * k, hy - Math.sin(facing) * SEG * k]);
    }
    Object.assign(p, { angle: facing, target: facing, boost: false, boosting: false, boostTicks: 0, grow: 0, alive: true, inRound: true, magnet: 0, ghost: 0, shield: false, invuln: 0 });
  });
}

function startMatch(room) {
  room.round = 0;
  for (const p of room.players.values()) {
    p.wins = 0;
    p.stats = { kills: 0, maxLen: 0, aliveTicks: 0, eaten: 0, powerups: 0 };
  }
  startRound(room);
}

function startRound(room) {
  const [W, H] = ARENAS[room.settings.arena];
  room.w = W;
  room.h = H;
  room.round += 1;
  room.tick = 0;
  room.bounds = { x0: 0, y0: 0, x1: W, y1: H };
  room.startedWith = room.players.size;
  room.lastResult = null;
  room.events = [];
  room.powerups = [];
  clearOrbs(room);
  spawnSnakes(room);
  topUpOrbs(room);
  room.phase = 'countdown';
  room.phaseEndsAt = Date.now() + COUNTDOWN_MS;
  ensureLoop(room);
}

// ---- Simulation ----
function killSnake(room, p, cause, killer) {
  p.alive = false;
  const [hx, hy] = p.body[0] || [0, 0];
  p.body.forEach(([x, y], i) => {
    if (i % 3 !== 0 || !inBounds(room.bounds, x, y, ORB_R)) return;
    addOrb(room, x + (Math.random() - 0.5) * 6, y + (Math.random() - 0.5) * 6, 2);
  });
  const credited = killer && killer !== p ? killer : null;
  if (credited) credited.stats.kills += 1;
  room.events.push({ type: 'death', id: p.id, name: p.name, color: p.color, cause, x: Math.round(hx), y: Math.round(hy), killer: credited ? credited.name : null, killerId: credited ? credited.id : null });
}

// Follow-the-leader: every point stays exactly SEG behind the one in front
function moveSnake(p, dist) {
  const head = p.body[0];
  head[0] += Math.cos(p.angle) * dist;
  head[1] += Math.sin(p.angle) * dist;
  for (let i = 1; i < p.body.length; i++) {
    const a = p.body[i - 1];
    const b = p.body[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const d = Math.hypot(dx, dy);
    if (d > SEG) {
      b[0] = a[0] + (dx / d) * SEG;
      b[1] = a[1] + (dy / d) * SEG;
    }
  }
  if (p.grow > 0) {
    const tail = p.body[p.body.length - 1];
    p.body.push([tail[0], tail[1]]);
    p.grow -= 1;
  }
}

function shrinkArena(room) {
  const b = room.bounds;
  const s = SHRINK_SPEED * DT;
  if (b.x1 - b.x0 > MIN_ARENA_W) { b.x0 += s; b.x1 -= s; }
  if (b.y1 - b.y0 > MIN_ARENA_H) { b.y0 += s; b.y1 -= s; }
  for (const [id, o] of room.orbs) if (!inBounds(b, o.x, o.y)) removeOrb(room, id);
  room.powerups = room.powerups.filter((u) => inBounds(b, u.x, u.y, 10));
  for (const p of room.players.values()) {
    if (!p.alive) continue;
    const cut = p.body.findIndex(([x, y]) => !inBounds(b, x, y));
    if (cut > 0) p.body.length = Math.max(1, cut); // the wall chops off your tail
  }
}

// Spatial hash of every body point, rebuilt each tick (used by collisions and bots)
function buildGrid(room) {
  const grid = new Map();
  for (const p of room.players.values()) {
    if (!p.alive) continue;
    p.body.forEach(([x, y], i) => {
      const k = Math.floor(x / GRID) * 4096 + Math.floor(y / GRID);
      let cell = grid.get(k);
      if (!cell) grid.set(k, (cell = []));
      cell.push(x, y, p, i);
    });
  }
  return grid;
}

// Calls fn(x, y, owner, index) for every body point near (x, y)
function nearby(grid, x, y, fn) {
  const cx = Math.floor(x / GRID);
  const cy = Math.floor(y / GRID);
  for (let i = cx - 1; i <= cx + 1; i++) {
    for (let j = cy - 1; j <= cy + 1; j++) {
      const cell = grid.get(i * 4096 + j);
      if (!cell) continue;
      for (let n = 0; n < cell.length; n += 4) {
        if (fn(cell[n], cell[n + 1], cell[n + 2], cell[n + 3]) === true) return true;
      }
    }
  }
  return false;
}

const intangible = (p) => p.ghost > 0 || p.invuln > 0;

// ---- Bots (also used as autopilot for players who are reconnecting) ----
// Easy: a simple reactive steerer. Normal/Hard: a planner that simulates possible paths.

function easyDanger(room, grid, self, x, y, heads) {
  if (!inBounds(room.bounds, x, y, 18)) return true;
  const r2 = (RADIUS * 2 + 6) ** 2;
  // Where rival heads are now and are about to be
  for (const [qx, qy, qa] of heads) {
    for (const k of [0, 25, 50]) {
      if (dist2(x, y, qx + Math.cos(qa) * k, qy + Math.sin(qa) * k) < 34 ** 2) return true;
    }
  }
  return nearby(grid, x, y, (px, py, owner) => owner !== self && owner.ghost <= 0 && dist2(x, y, px, py) < r2);
}

function botThinkEasy(room, grid, p) {
  const [hx, hy] = p.body[0];
  const rivals = alivePlayers(room).filter((q) => q !== p && q.ghost <= 0);
  const heads = rivals.map((q) => [q.body[0][0], q.body[0][1], q.angle]);
  let tx = null;
  let ty = null;

  // Hunting: a bigger bot tries to cut across a nearby rival's path
  if (p.huntUntil > room.tick && p.prey && p.prey.alive) {
    const q = p.prey;
    tx = q.body[0][0] + Math.cos(q.angle) * 90;
    ty = q.body[0][1] + Math.sin(q.angle) * 90;
  } else {
    p.prey = null;
    if (p.body.length > 40 && Math.random() < 0.02) {
      const prey = rivals.find((q) => q.body.length < p.body.length * 0.9 && dist2(hx, hy, q.body[0][0], q.body[0][1]) < 320 ** 2);
      if (prey) { p.prey = prey; p.huntUntil = room.tick + 60; }
    }
  }

  if (tx === null) {
    let best = 520 ** 2;
    for (const o of room.orbs.values()) {
      const d = dist2(hx, hy, o.x, o.y) / o.v; // prefer big orbs
      if (d < best) { best = d; tx = o.x; ty = o.y; }
    }
    for (const u of room.powerups) {
      const d = dist2(hx, hy, u.x, u.y) / 6;
      if (d < best) { best = d; tx = u.x; ty = u.y; }
    }
  }
  if (tx === null) { tx = (room.bounds.x0 + room.bounds.x1) / 2; ty = (room.bounds.y0 + room.bounds.y1) / 2; }
  const want = Math.atan2(ty - hy, tx - hx);

  let bestA = p.angle;
  let bestScore = -Infinity;
  let safeAhead = true;
  for (let k = -7; k <= 7; k++) {
    const a = p.angle + k * 0.28;
    let score = Math.cos(wrapAngle(want - a)) * 3 - Math.abs(k) * 0.04;
    for (const d of [18, 40, 70, 110, 160]) {
      if (easyDanger(room, grid, p, hx + Math.cos(a) * d, hy + Math.sin(a) * d, heads)) {
        score -= (200 - d) * 2;
        if (k === 0) safeAhead = false;
        break;
      }
    }
    if (score > bestScore) { bestScore = score; bestA = a; }
  }
  p.target = wrapAngle(bestA);
  // Boost when hunting, or now and then when the way ahead is clear and there's length to spare
  if (p.prey && safeAhead && p.body.length > 25) p.boost = true;
  else if (!p.boost) p.boost = safeAhead && p.body.length > 30 && Math.random() < 0.01;
  else p.boost = safeAhead && Math.random() < 0.93;
}

// ---- Planner bots (Normal / Hard) ----
const SKILLS = {
  easy: null,
  normal: { every: 2, horizon: 12, attack: 0.04, foodRush: false },
  hard: { every: 1, horizon: 20, attack: 0.15, foodRush: true },
};
const BOT_SKILLS = Object.keys(SKILLS);
const OCC = 20; // cell size of the coarse free-space grid
const SPACE_CAP = 320; // cells counted by the free-space flood fill
const REL_ANGLES = [0, -0.15, 0.15, -0.3, 0.3, -0.5, 0.5, -0.75, 0.75, -1, 1, -1.3, 1.3, -1.7, 1.7, -2.2, 2.2, -2.8, 2.8];

// Shared per-tick view of the world that every planner bot reads
function botWorld(room, grid) {
  const cols = Math.ceil(room.w / OCC) + 1;
  const rows = Math.ceil(room.h / OCC) + 1;
  const occ = new Uint8Array(cols * rows); // 1 = blocked by a snake body
  const snakes = [];
  for (const q of room.players.values()) {
    if (!q.alive) continue;
    const speed = q.boosting ? BOOST_SPEED : SPEED;
    snakes.push({ p: q, x: q.body[0][0], y: q.body[0][1], dx: Math.cos(q.angle), dy: Math.sin(q.angle), speed, len: q.body.length });
    if (intangible(q)) continue;
    for (const [x, y] of q.body) {
      const c = Math.floor(x / OCC);
      const r = Math.floor(y / OCC);
      if (c >= 0 && r >= 0 && c < cols && r < rows) occ[r * cols + c] = 1;
    }
  }
  const orbGrid = new Map();
  for (const o of room.orbs.values()) {
    const k = Math.floor(o.x / GRID) * 4096 + Math.floor(o.y / GRID);
    let cell = orbGrid.get(k);
    if (!cell) orbGrid.set(k, (cell = []));
    cell.push(o);
  }
  return { grid, occ, cols, rows, snakes, orbGrid };
}

// Where the walls will be `ticks` ticks from now (they stop at the minimum arena size)
function futureBounds(room, ticks) {
  const b = room.bounds;
  const over = Math.max(0, room.tick + ticks - Math.max(room.tick, shrinkAtTicks(room)));
  const s = SHRINK_SPEED * DT * over;
  const sx = Math.min(s, Math.max(0, (b.x1 - b.x0 - MIN_ARENA_W) / 2));
  const sy = Math.min(s, Math.max(0, (b.y1 - b.y0 - MIN_ARENA_H) / 2));
  return { x0: b.x0 + sx, y0: b.y0 + sy, x1: b.x1 - sx, y1: b.y1 - sy };
}

// Simulates steering toward `target` for `steps` ticks under the real turn-rate limit.
// Returns how many ticks it stays safe (steps + 1 = safe the whole way), where it ends up and food collected.
function simulate(room, world, p, target, speed, steps) {
  let [x, y] = p.body[0];
  let a = p.angle;
  let food = 0;
  const maxTurn = TURN_RATE * DT;
  const bodyR2 = (RADIUS * 2) ** 2;
  const eatR2 = (RADIUS + ORB_R + 4) ** 2;
  const eaten = new Set();
  for (let s = 1; s <= steps; s++) {
    a = wrapAngle(a + Math.max(-maxTurn, Math.min(maxTurn, wrapAngle(target - a))));
    x += Math.cos(a) * speed * DT;
    y += Math.sin(a) * speed * DT;
    const t = s * DT;
    if (!inBounds(futureBounds(room, s), x, y, RADIUS + 3)) return { ttc: s, x, y, a, food };
    const ghostNow = p.ghost > s || p.invuln > s;
    if (!ghostNow) {
      // Snake bodies as they are now
      const hit = nearby(world.grid, x, y, (bx, by, owner, i) => owner !== p && i > 0 && !intangible(owner) && dist2(x, y, bx, by) < bodyR2);
      if (hit) return { ttc: s, x, y, a, food };
      // Rival heads: dangerous if they reach this spot before (or about when) we do
      for (const e of world.snakes) {
        if (e.p === p || intangible(e.p)) continue;
        const rx = x - e.x;
        const ry = y - e.y;
        const along = rx * e.dx + ry * e.dy;
        if (along < -RADIUS * 2) continue;
        const perp = Math.abs(rx * e.dy - ry * e.dx);
        if (perp > RADIUS * 2.6) continue;
        if (Math.max(0, along) / e.speed <= t + 0.2) return { ttc: s, x, y, a, food };
      }
    }
    // Orbs picked up along the way
    const cell = world.orbGrid.get(Math.floor(x / GRID) * 4096 + Math.floor(y / GRID));
    if (cell) for (const o of cell) if (!eaten.has(o) && dist2(x, y, o.x, o.y) < eatR2) { eaten.add(o); food += o.v; }
  }
  return { ttc: steps + 1, x, y, a, food };
}

// Free space reachable from (x, y): a capped flood fill over the coarse grid. Small = we're boxed in.
function freeSpace(room, world, x, y, ticksAhead) {
  const { occ, cols } = world;
  const fb = futureBounds(room, ticksAhead + 40);
  const c0 = Math.floor(fb.x0 / OCC) + 1;
  const c1 = Math.floor(fb.x1 / OCC) - 1;
  const r0 = Math.floor(fb.y0 / OCC) + 1;
  const r1 = Math.floor(fb.y1 / OCC) - 1;
  const sc = Math.floor(x / OCC);
  const sr = Math.floor(y / OCC);
  if (sc < c0 || sc > c1 || sr < r0 || sr > r1) return 0;
  const seen = new Set([sr * cols + sc]);
  const queue = [sr * cols + sc];
  for (let qi = 0; qi < queue.length && seen.size < SPACE_CAP; qi++) {
    const k = queue[qi];
    const c = k % cols;
    const r = (k - c) / cols;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < c0 || nc > c1 || nr < r0 || nr > r1) continue;
      const nk = nr * cols + nc;
      if (seen.has(nk) || occ[nk]) continue;
      seen.add(nk);
      queue.push(nk);
    }
  }
  return Math.min(1, seen.size / SPACE_CAP);
}

// Can we get in front of a rival's head before it arrives? Returns the best cut-off point.
function findIntercept(world, p, hx, hy) {
  if (p.body.length < 30) return null; // need length to spare: a cut-off costs boost
  let best = null;
  for (const e of world.snakes) {
    if (e.p === p || intangible(e.p) || e.len < 15) continue;
    if (dist2(hx, hy, e.x, e.y) > 480 ** 2) continue;
    for (const lead of [55, 90, 140]) {
      const px = e.x + e.dx * lead;
      const py = e.y + e.dy * lead;
      const turn = Math.abs(wrapAngle(Math.atan2(py - hy, px - hx) - p.angle)) / TURN_RATE;
      const ours = Math.hypot(px - hx, py - hy) / BOOST_SPEED + turn;
      const theirs = lead / e.speed;
      if (ours + 0.2 < theirs) {
        const value = e.len / (ours + 0.3);
        if (!best || value > best.value) best = { x: px, y: py, value, prey: e.p };
        break;
      }
    }
  }
  return best;
}

// Where is the best food? Big orbs, clusters, power-ups; skip things a rival will reach first.
function findFood(room, world, p, hx, hy) {
  let best = null;
  const range = p.magnet > 0 ? 700 : 550;
  const rivalCloser = (x, y, d) => world.snakes.some((e) => e.p !== p && dist2(e.x, e.y, x, y) < (d * 0.6) ** 2);
  for (const o of room.orbs.values()) {
    const d = Math.hypot(o.x - hx, o.y - hy);
    if (d > range) continue;
    const value = o.v / (d + 60);
    if (best && value <= best.value) continue;
    if (rivalCloser(o.x, o.y, d)) continue;
    best = { x: o.x, y: o.y, value };
  }
  for (const u of room.powerups) {
    const d = Math.hypot(u.x - hx, u.y - hy);
    const value = 10 / (d + 60);
    if (d < range && (!best || value > best.value) && !rivalCloser(u.x, u.y, d)) best = { x: u.x, y: u.y, value };
  }
  return best;
}

function botThinkPlanner(room, world, p, skill) {
  const [hx, hy] = p.body[0];
  const cfg = SKILLS[skill];
  const steps = cfg.horizon;

  // 1. Pick a goal: cut off a rival if we can, otherwise food, otherwise the arena centre
  if (p.attackUntil > room.tick && p.attack && !p.attack.prey.alive) p.attack = null;
  if (!(p.attackUntil > room.tick && p.attack) && Math.random() < cfg.attack) {
    const cut = findIntercept(world, p, hx, hy);
    p.attack = cut;
    if (cut) p.attackUntil = room.tick + 30;
  }
  if (p.attack && p.attackUntil > room.tick) {
    // Refresh the cut-off point as the prey moves
    const e = world.snakes.find((s) => s.p === p.attack.prey);
    if (e) { p.attack.x = e.x + e.dx * 90; p.attack.y = e.y + e.dy * 90; }
  }
  const attacking = p.attack && p.attackUntil > room.tick;
  const food = attacking ? null : findFood(room, world, p, hx, hy);
  const cx = (room.bounds.x0 + room.bounds.x1) / 2;
  const cy = (room.bounds.y0 + room.bounds.y1) / 2;
  const goal = attacking ? p.attack : food || { x: cx, y: cy };
  const goalW = attacking ? 45 : food ? 25 : 8;
  const d0 = Math.hypot(goal.x - hx, goal.y - hy);
  const closingSoon = room.tick + 200 >= shrinkAtTicks(room);
  const span = Math.max(room.bounds.x1 - room.bounds.x0, room.bounds.y1 - room.bounds.y0);

  // 2. Score every candidate path
  const evaluate = (rel, speed) => {
    const target = p.angle + rel;
    const r = simulate(room, world, p, target, speed, steps);
    if (r.ttc <= steps) {
      // Every path is risky: survive longest, and among equals prefer the one with more room around it
      const room2 = r.ttc > 2 ? freeSpace(room, world, r.x, r.y, r.ttc) : 0;
      return { rel, speed, r, score: -1000 + r.ttc * 25 + room2 * 20 - Math.abs(rel) * 2 };
    }
    const space = freeSpace(room, world, r.x, r.y, steps);
    let score = space * 60;
    if (space < 0.35) score -= (0.35 - space) * 400; // about to be boxed in
    score += r.food * 4;
    const progress = (d0 - Math.hypot(goal.x - r.x, goal.y - r.y)) / (speed * steps * DT);
    score += progress * goalW;
    if (closingSoon) score -= (Math.hypot(r.x - cx, r.y - cy) / span) * 30;
    score -= Math.abs(rel) * 3;
    return { rel, speed, r, score };
  };

  let best = null;
  for (const rel of REL_ANGLES) {
    const o = evaluate(rel, SPEED);
    if (!best || o.score > best.score) best = o;
  }

  // 3. Boost on purpose: to finish a cut-off, to escape, or (Hard) to grab nearby gold first
  const canBoost = p.body.length > MIN_BOOST_LENGTH + 6;
  let boost = false;
  if (canBoost) {
    const inDanger = best.r.ttc <= steps;
    const wantRush = (attacking && d0 < 220) || inDanger // boost only for the final approach of a cut-off
      || (cfg.foodRush && food && p.body.length > 35 && d0 < 160 && food.value > 6 / (d0 + 60));
    if (wantRush) {
      let bestB = null;
      for (const rel of REL_ANGLES) {
        const o = evaluate(rel, BOOST_SPEED);
        if (!bestB || o.score > bestB.score) bestB = o;
      }
      // Escape: take the boost path if it survives longer; attack/rush: only if it's at least as safe
      if (inDanger ? bestB.r.ttc > best.r.ttc : bestB.r.ttc > steps && bestB.score >= best.score - 5) {
        best = bestB;
        boost = true;
      }
    }
  }

  p.target = wrapAngle(p.angle + best.rel);
  p.boost = boost;
}

function botThink(room, world, p) {
  const skill = p.isBot ? p.skill : 'normal'; // autopilot for disconnected players plays at Normal
  if (skill === 'easy') botThinkEasy(room, world.grid, p);
  else botThinkPlanner(room, world, p, skill);
}

function spawnPowerup(room) {
  const max = 2 + Math.floor(room.startedWith / 3);
  if (room.powerups.length >= max) return;
  const spot = freeSpot(room, 60, 80);
  if (!spot) return;
  room.powerups.push({ id: newId(), x: spot[0], y: spot[1], type: POWER_TYPES[Math.floor(Math.random() * POWER_TYPES.length)] });
}

function step(room) {
  room.tick += 1;
  const alive = alivePlayers(room);

  // 0. Bots (and disconnected players' autopilot) decide where to go.
  //    Easy/Normal think 10x per second, Hard 20x; thinking is staggered across bots.
  let world = null;
  alive.forEach((p, i) => {
    if (!p.isBot && p.connected) return;
    const skill = p.isBot ? p.skill : 'normal';
    const every = SKILLS[skill] ? SKILLS[skill].every : 2;
    if ((room.tick + i) % every !== 0) return;
    world = world || botWorld(room, buildGrid(room));
    botThink(room, world, p);
  });

  // 1. Steer toward the target angle (limited turn rate) and move
  for (const p of alive) {
    const diff = wrapAngle(p.target - p.angle);
    const maxTurn = TURN_RATE * DT;
    p.angle = wrapAngle(p.angle + Math.max(-maxTurn, Math.min(maxTurn, diff)));

    p.boosting = p.boost && p.body.length > MIN_BOOST_LENGTH;
    moveSnake(p, (p.boosting ? BOOST_SPEED : SPEED) * DT);

    // Boosting burns length and leaves a trail of small orbs
    if (p.boosting) {
      p.boostTicks += 1;
      if (p.boostTicks % BOOST_COST_TICKS === 0) {
        const [tx, ty] = p.body.pop();
        if (p.boostTicks % (BOOST_COST_TICKS * 2) === 0) addOrb(room, tx, ty, 1);
      }
    }
    if (p.magnet > 0) p.magnet -= 1;
    if (p.ghost > 0) p.ghost -= 1;
    if (p.invuln > 0) p.invuln -= 1;
    p.stats.aliveTicks += 1;
    p.stats.maxLen = Math.max(p.stats.maxLen, p.body.length);
  }

  // 2. Collisions (evaluated simultaneously, after everyone moved)
  const grid = buildGrid(room);
  const hitR2 = (RADIUS * 1.6) ** 2;
  const deaths = [];
  for (const p of alive) {
    const [hx, hy] = p.body[0];
    if (!inBounds(room.bounds, hx, hy, RADIUS * 0.5)) { deaths.push([p, 'wall', null]); continue; }
    if (intangible(p)) continue;
    let hit = null;
    for (const q of alive) {
      if (q === p || intangible(q)) continue;
      if (dist2(hx, hy, q.body[0][0], q.body[0][1]) < (RADIUS * 1.8) ** 2) { hit = [p, 'headon', null]; break; }
    }
    if (!hit) {
      nearby(grid, hx, hy, (x, y, owner, i) => {
        if (owner === p || i === 0 || intangible(owner) || dist2(hx, hy, x, y) >= hitR2) return false;
        hit = [p, 'snake', owner];
        return true;
      });
    }
    if (hit) deaths.push(hit);
  }
  for (const [p, cause, killer] of deaths) {
    if (cause !== 'wall' && p.shield) {
      // The shield absorbs one crash and gives a moment to escape
      p.shield = false;
      p.invuln = INVULN_TICKS;
      room.events.push({ type: 'shield', id: p.id, x: Math.round(p.body[0][0]), y: Math.round(p.body[0][1]) });
      continue;
    }
    killSnake(room, p, cause, killer);
  }

  // 3. Magnets pull nearby orbs in
  for (const p of alive) {
    if (!p.alive || p.magnet <= 0) continue;
    const [hx, hy] = p.body[0];
    for (const [id, o] of room.orbs) {
      const d = Math.sqrt(dist2(hx, hy, o.x, o.y));
      if (d > MAGNET_RANGE || d < 1) continue;
      const pull = Math.min(d, 12);
      o.x += ((hx - o.x) / d) * pull;
      o.y += ((hy - o.y) / d) * pull;
      moveOrb(room, id, o);
    }
  }

  // 4. Eat orbs and pick up power-ups
  const eatR2 = (RADIUS + ORB_R + 4) ** 2;
  for (const [id, o] of room.orbs) {
    for (const p of alive) {
      if (!p.alive || dist2(p.body[0][0], p.body[0][1], o.x, o.y) >= eatR2) continue;
      p.grow += o.v;
      p.stats.eaten += 1;
      removeOrb(room, id);
      break;
    }
  }
  room.powerups = room.powerups.filter((u) => {
    for (const p of alive) {
      if (!p.alive || dist2(p.body[0][0], p.body[0][1], u.x, u.y) >= (RADIUS + 14) ** 2) continue;
      if (u.type === 'shield') p.shield = true;
      else p[u.type] = POWER[u.type].ticks;
      p.stats.powerups += 1;
      room.events.push({ type: 'power', id: p.id, power: u.type, x: Math.round(u.x), y: Math.round(u.y) });
      return false;
    }
    return true;
  });
  topUpOrbs(room);
  if (room.tick % POWER_EVERY_TICKS === 0) spawnPowerup(room);

  // 5. Sudden death: walls close in
  if (room.tick >= shrinkAtTicks(room)) shrinkArena(room);

  checkRoundEnd(room);
}

const shrinkAtTicks = (room) => Math.round((room.settings.shrinkAfter * 1000) / TICK_MS);

function checkRoundEnd(room) {
  if (room.phase !== 'playing') return;
  const alive = alivePlayers(room);
  const practice = room.startedWith < 2;
  if (practice ? alive.length > 0 : alive.length > 1) return;

  let winner = null;
  if (!practice && alive.length === 1) {
    winner = alive[0];
    winner.wins += 1;
  }
  room.lastResult = {
    practice,
    winner: winner ? { id: winner.id, name: winner.name, color: winner.color } : null,
  };
  if (winner && winner.wins >= room.settings.winsToMatch) {
    room.phase = 'matchover';
    room.lastResult.match = true;
  } else {
    room.phase = 'roundover';
    room.phaseEndsAt = Date.now() + ROUND_OVER_MS;
  }
}

function loop(room) {
  const now = Date.now();
  if (room.phase === 'countdown' && now >= room.phaseEndsAt) {
    room.phase = 'playing';
    room.simTime = now;
  } else if (room.phase === 'playing') {
    // Fixed timestep tied to the real clock, so timers firing late don't slow the game down
    let steps = 0;
    while (room.phase === 'playing' && now - room.simTime >= TICK_MS && steps < 4) {
      step(room);
      room.simTime += TICK_MS;
      steps += 1;
    }
    if (now - room.simTime > TICK_MS * 4) room.simTime = now; // don't spiral after a long stall
  } else if (room.phase === 'roundover' && now >= room.phaseEndsAt) {
    startRound(room);
  }
  broadcast(room, 'tick');
  if (room.phase === 'matchover' || room.phase === 'lobby') stopLoop(room);
}

function ensureLoop(room) {
  if (!room.timer) room.timer = setInterval(() => loop(room), TICK_MS);
}

function stopLoop(room) {
  clearInterval(room.timer);
  room.timer = null;
}

// ---- Networking ----
const orbRow = (id, o) => [id, Math.round(o.x), Math.round(o.y), o.v];

// mode: 'tick' = orb deltas, 'full' = every orb, 'meta' = no orb data
function snapshot(room, mode) {
  const b = room.bounds;
  const s = {
    code: room.code,
    hostId: hostPlayer(room) ? hostPlayer(room).id : null,
    phase: room.phase,
    countdown: room.phase === 'countdown' ? Math.max(0, room.phaseEndsAt - Date.now()) : 0,
    round: room.round,
    tick: room.tick,
    settings: room.settings,
    shrinkAt: shrinkAtTicks(room),
    w: room.w,
    h: room.h,
    bounds: { x0: Math.round(b.x0), y0: Math.round(b.y0), x1: Math.round(b.x1), y1: Math.round(b.y1) },
    powerups: room.powerups.map((u) => [u.id, Math.round(u.x), Math.round(u.y), u.type]),
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      skin: p.skin,
      bot: p.isBot,
      skill: p.skill,
      connected: p.connected,
      ready: p.ready,
      wins: p.wins,
      stats: p.stats,
      alive: p.alive,
      inRound: p.inRound,
      angle: Math.round(p.angle * 1000) / 1000,
      boosting: p.boosting,
      length: p.alive ? p.body.length : 0,
      fx: [Math.ceil(p.magnet * DT), Math.ceil(p.ghost * DT), p.shield ? 1 : 0, p.invuln > 0 ? 1 : 0],
      // Every other body point (plus the tail), flat [x0,y0,x1,y1,...] in whole units, to keep packets small.
      // Collisions use the full-detail body on the server.
      body: p.alive ? p.body.flatMap(([x, y], i) => (i % 2 === 0 || i === p.body.length - 1 ? [Math.round(x), Math.round(y)] : [])) : [],
    })),
    result: room.lastResult,
    events: mode === 'tick' ? room.events : [],
  };
  if (mode === 'full') s.orbFull = [...room.orbs].map(([id, o]) => orbRow(id, o));
  if (mode === 'tick') {
    if (room.orbsReset) s.orbFull = [...room.orbs].map(([id, o]) => orbRow(id, o));
    else {
      s.orbAdd = [...room.orbAdds].map(([id, o]) => orbRow(id, o));
      s.orbDel = room.orbDels;
    }
  }
  return s;
}

function broadcast(room, mode = 'meta') {
  io.to(room.code).emit('state', snapshot(room, mode));
  if (mode === 'tick') {
    room.events = [];
    resetOrbDeltas(room);
    room.orbsReset = false;
  }
}

function removePlayer(room, p) {
  if (p.alive && (room.phase === 'playing' || room.phase === 'countdown')) killSnake(room, p, 'left');
  room.players.delete(p.token);
  if (humans(room).length === 0) {
    stopLoop(room);
    rooms.delete(room.code);
    return;
  }
  pickHost(room);
  if (room.phase === 'playing') checkRoundEnd(room);
  if (room.phase === 'countdown') room.startedWith = room.players.size;
  broadcast(room);
}

function attach(socket, room, p) {
  p.socketId = socket.id;
  p.connected = true;
  p.disconnectedAt = 0;
  socket.data.room = room.code;
  socket.data.token = p.token;
  socket.join(room.code);
  pickHost(room);
  socket.emit('joined', { code: room.code, id: p.id, token: p.token, config: CONFIG });
  socket.emit('state', snapshot(room, 'full'));
  broadcast(room);
}

function detach(socket) {
  const room = rooms.get(socket.data.room);
  socket.data.room = null;
  if (!room) return null;
  socket.leave(room.code);
  const p = room.players.get(socket.data.token);
  return p && p.socketId === socket.id ? { room, p } : null;
}

function joinRoom(socket, room, name) {
  if (room.players.size >= MAX_PLAYERS) return socket.emit('errorMsg', 'That room is full (8 players max).');
  const prev = detach(socket);
  if (prev) removePlayer(prev.room, prev.p);
  const p = newPlayer(room, { name });
  room.players.set(p.token, p);
  if (!room.hostToken) room.hostToken = p.token;
  attach(socket, room, p);
}

function ctxOf(socket) {
  const room = rooms.get(socket.data.room);
  const p = room && room.players.get(socket.data.token);
  return p && p.socketId === socket.id ? { room, p } : {};
}

function hostCtx(socket) {
  const { room, p } = ctxOf(socket);
  return room && room.hostToken === p.token ? { room, p } : {};
}

const inLobby = (room) => room.phase === 'lobby' || room.phase === 'matchover';

io.on('connection', (socket) => {
  socket.on('create', ({ name } = {}) => {
    const room = createRoom();
    joinRoom(socket, room, name);
  });

  socket.on('join', ({ name, code } = {}) => {
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) return socket.emit('errorMsg', 'No room with that code. Check the code or create a new room.');
    joinRoom(socket, room, name);
  });

  // Coming back after a refresh / dropped connection: reclaim the same seat
  socket.on('rejoin', ({ code, token } = {}) => {
    const room = rooms.get(String(code || '').toUpperCase());
    const p = room && room.players.get(String(token || ''));
    if (!p || p.isBot) return socket.emit('rejoinFailed');
    const old = io.sockets.sockets.get(p.socketId);
    if (old && old.id !== socket.id) { old.data.room = null; old.disconnect(true); }
    attach(socket, room, p);
  });

  socket.on('ping2', (t, cb) => { if (typeof cb === 'function') cb(t); });

  socket.on('start', () => {
    const { room } = hostCtx(socket);
    if (!room || !inLobby(room)) return;
    startMatch(room);
  });

  socket.on('toLobby', () => {
    const { room } = hostCtx(socket);
    if (!room || room.phase !== 'matchover') return;
    room.phase = 'lobby';
    room.round = 0;
    for (const p of room.players.values()) {
      Object.assign(p, { wins: 0, alive: false, inRound: false, ready: p.isBot });
    }
    broadcast(room);
  });

  socket.on('settings', (s = {}) => {
    const { room } = hostCtx(socket);
    if (!room || !inLobby(room)) return;
    if (WINS_OPTIONS.includes(s.winsToMatch)) room.settings.winsToMatch = s.winsToMatch;
    if (ARENAS[s.arena]) room.settings.arena = s.arena;
    if (SHRINK_OPTIONS.includes(s.shrinkAfter)) room.settings.shrinkAfter = s.shrinkAfter;
    broadcast(room);
  });

  socket.on('addBot', (skill) => {
    const { room } = hostCtx(socket);
    if (!room || !inLobby(room) || room.players.size >= MAX_PLAYERS) return;
    const taken = new Set([...room.players.values()].map((p) => p.name));
    // New bots copy the last skill the host picked, so "Add bot" x3 after choosing Hard gives three Hard bots
    const s = BOT_SKILLS.includes(skill) ? skill : room.botSkill || 'normal';
    const bot = newPlayer(room, { name: BOT_NAMES.find((n) => !taken.has(n)) || 'Bot', isBot: true, skill: s });
    room.players.set(bot.token, bot);
    broadcast(room);
  });

  socket.on('removeBot', (id) => {
    const { room } = hostCtx(socket);
    if (!room || !inLobby(room)) return;
    const bot = [...room.players.values()].find((p) => p.isBot && p.id === id);
    if (bot) { room.players.delete(bot.token); broadcast(room); }
  });

  socket.on('botSkill', ({ id, skill } = {}) => {
    const { room } = hostCtx(socket);
    if (!room || !inLobby(room) || !BOT_SKILLS.includes(skill)) return;
    const bot = [...room.players.values()].find((p) => p.isBot && p.id === id);
    if (!bot) return;
    bot.skill = skill;
    room.botSkill = skill;
    broadcast(room);
  });

  socket.on('ready', (on) => {
    const { room, p } = ctxOf(socket);
    if (!room || !inLobby(room)) return;
    p.ready = !!on;
    broadcast(room);
  });

  socket.on('look', ({ color, skin } = {}) => {
    const { room, p } = ctxOf(socket);
    if (!room || !inLobby(room)) return;
    const taken = [...room.players.values()].some((q) => q !== p && q.color === color);
    if (COLORS.includes(color) && !taken) p.color = color;
    if (SKINS.includes(skin)) p.skin = skin;
    broadcast(room);
  });

  // Steering: the client sends the angle (radians) it wants the head to point at
  socket.on('steer', (angle) => {
    const { p } = ctxOf(socket);
    if (!p || !p.alive || typeof angle !== 'number' || !Number.isFinite(angle)) return;
    p.target = wrapAngle(angle);
  });

  socket.on('boost', (on) => {
    const { p } = ctxOf(socket);
    if (p) p.boost = !!on;
  });

  socket.on('leave', () => {
    const prev = detach(socket);
    if (prev) removePlayer(prev.room, prev.p);
  });

  socket.on('disconnect', () => {
    const prev = detach(socket);
    if (!prev) return;
    // Keep the seat for a while; autopilot steers the snake meanwhile
    prev.p.connected = false;
    prev.p.disconnectedAt = Date.now();
    prev.p.boost = false;
    pickHost(prev.room);
    broadcast(prev.room);
  });
});

// Drop players who didn't come back in time
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const p of [...room.players.values()]) {
      if (!p.isBot && !p.connected && now - p.disconnectedAt > RECONNECT_GRACE_MS && rooms.has(room.code)) {
        removePlayer(room, p);
      }
    }
  }
}, 2000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Snake Arena running at http://localhost:${PORT}`));
