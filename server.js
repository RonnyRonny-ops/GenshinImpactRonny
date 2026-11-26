// RonnyHarbinger · Genshin Guess — real-time guessing game server
// Modes: "music" (guess the OST title), "charm" (guess the character from their theme music), "burst" (guess the character from a burst image)
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.get('/healthz', (_req, res) => res.send('ok'));
app.get('/qr.svg', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 300);
  if (!/^https?:\/\//.test(text)) return res.status(400).end();
  try { res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })); }
  catch { res.status(500).end(); }
});

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 40 * 1024 * 1024, pingTimeout: 30000 });

// ---------------- helpers ----------------
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const now = () => Date.now();
const rand = (n) => Math.floor(Math.random() * n);
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const clampInt = (v, lo, hi, d) => { v = parseInt(v, 10); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 18);
const cleanLabel = (s) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

function newCode() {
  let c;
  do { c = Array.from({ length: 6 }, () => CODE_CHARS[rand(CODE_CHARS.length)]).join(''); } while (rooms.has(c));
  return c;
}

const PREP_MS = { music: 3500, charm: 3500, burst: 2500 };
const KINDS = ['music', 'charm', 'burst'];
const isAudio = (k) => k === 'music' || k === 'charm';
const REVEAL_MS = 7000;
const MAX_PLAYERS_CAP = 100;

/** rooms: code -> room */
const rooms = new Map();

function sanitizeSettings(s = {}, prev = {}) {
  const mode = ['music', 'charm', 'burst', 'mixed'].includes(s.mode) ? s.mode : (prev.mode || 'music');
  return {
    mode,
    rounds: clampInt(s.rounds, 3, 30, prev.rounds || 10),
    musicTime: clampInt(s.musicTime, 8, 30, prev.musicTime || 15),
    burstTime: clampInt(s.burstTime, 6, 30, prev.burstTime || 12),
    maxPlayers: clampInt(s.maxPlayers, 2, MAX_PLAYERS_CAP, prev.maxPlayers || 50),
    autoNext: s.autoNext === undefined ? (prev.autoNext ?? true) : !!s.autoNext,
  };
}

function sanitizeLibrary(lib = {}) {
  const music = Array.isArray(lib.music) ? lib.music : [];
  const burst = Array.isArray(lib.burst) ? lib.burst : [];
  const m = [];
  const seen = new Set();
  for (const t of music.slice(0, 600)) {
    if (!t || !YT_ID.test(t.id)) continue;
    const cat = t.cat === 'char' ? 'char' : 'ost';
    if (seen.has(cat + t.id)) continue;
    const title = cleanLabel(t.title);
    if (!title) continue;
    seen.add(cat + t.id); m.push({ id: t.id, title, cat });
  }
  const b = [];
  for (const it of burst.slice(0, 300)) {
    if (!it) continue;
    const name = cleanLabel(it.name);
    const img = String(it.img || '');
    const okImg = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(img) && img.length < 1_500_000
      || /^https:\/\/[^\s"'<>]+$/.test(img) && img.length < 2000;
    if (!name || !okImg) continue;
    b.push({ name, img });
  }
  return { music: m, burst: b };
}

function publicPlayers(room) {
  return [...room.players.values()].map((p) => ({ id: p.id, name: p.name, score: p.score, connected: p.connected, streak: p.streak }));
}
function leaderboard(room) {
  return publicPlayers(room).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
function itemsOf(room, kind) {
  if (kind === 'burst') return room.library.burst;
  return room.library.music.filter((t) => (kind === 'charm' ? t.cat === 'char' : t.cat !== 'char'));
}
const labelOf = (kind, item) => (kind === 'burst' ? item.name : item.title);
function distinctLabels(room, kind) {
  return [...new Set(itemsOf(room, kind).map((t) => labelOf(kind, t)))];
}
function kindsAvailable(room) {
  return KINDS.filter((k) => itemsOf(room, k).length >= 1 && distinctLabels(room, k).length >= 2);
}
function counts(room) {
  return { music: itemsOf(room, 'music').length, charm: itemsOf(room, 'charm').length, burst: room.library.burst.length };
}
function modeKinds(room) {
  const av = kindsAvailable(room);
  const m = room.settings.mode;
  if (m === 'mixed') return av;
  return av.includes(m) ? [m] : [];
}

function roomState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    players: publicPlayers(room),
    settings: room.settings,
    state: room.state,
    roundNo: room.roundNo,
    total: room.settings.rounds,
    counts: counts(room),
    playable: modeKinds(room).length > 0,
  };
}
function broadcastState(room) { io.to(room.code).emit('room:state', roomState(room)); }

function clearTimers(room) {
  for (const t of room.timers) clearTimeout(t);
  room.timers = [];
}
function later(room, ms, fn) { room.timers.push(setTimeout(fn, ms)); }

// ---------------- game flow ----------------
function startGame(room) {
  const kinds = modeKinds(room);
  if (!kinds.length) return 'Thư viện chưa đủ nội dung cho chế độ này (cần ít nhất 2 đáp án khác nhau).';
  clearTimers(room);
  for (const p of room.players.values()) { p.score = 0; p.streak = 0; }
  room.roundNo = 0;
  room.used = { music: new Set(), charm: new Set(), burst: new Set() };
  room.history = [];
  nextRound(room);
  return null;
}

function pickItem(room, kind) {
  const list = itemsOf(room, kind);
  let pool = list.map((_, i) => i).filter((i) => !room.used[kind].has(i) && !(room.failed && room.failed.has(kind + i)));
  if (!pool.length) { room.used[kind].clear(); pool = list.map((_, i) => i).filter((i) => !(room.failed && room.failed.has(kind + i))); }
  if (!pool.length) return null;
  const idx = pool[rand(pool.length)];
  room.used[kind].add(idx);
  return idx;
}

function nextRound(room, { reroll = false } = {}) {
  clearTimers(room);
  const kinds = modeKinds(room);
  if (!kinds.length) { room.state = 'lobby'; broadcastState(room); return; }
  if (!reroll) room.roundNo += 1;
  if (room.roundNo > room.settings.rounds) return endGame(room);

  let kind = kinds[rand(kinds.length)];
  let idx = pickItem(room, kind);
  if (idx === null) { kind = kinds.find((k) => k !== kind); idx = kind ? pickItem(room, kind) : null; }
  if (idx === null) return endGame(room);

  const item = itemsOf(room, kind)[idx];
  const correct = labelOf(kind, item);
  const others = shuffle(distinctLabels(room, kind).filter((l) => l !== correct)).slice(0, 3);
  const options = shuffle([correct, ...others]);
  const limitMs = (isAudio(kind) ? room.settings.musicTime : room.settings.burstTime) * 1000;
  const playAt = now() + PREP_MS[kind];
  room.round = {
    kind, idx, options, answerIndex: options.indexOf(correct), correct,
    payload: isAudio(kind) ? { videoId: item.id, startFrac: 0.15 + Math.random() * 0.5 } : { img: item.img, zoomX: 0.25 + Math.random() * 0.5, zoomY: 0.25 + Math.random() * 0.5 },
    playAt, endsAt: playAt + limitMs, limitMs, answers: new Map(), revealed: false,
  };
  room.state = 'play';
  broadcastState(room);
  io.to(room.code).emit('round', {
    no: room.roundNo, total: room.settings.rounds, kind, options,
    payload: room.round.payload, playAt, endsAt: room.round.endsAt, serverNow: now(),
  });
  later(room, PREP_MS[kind] + limitMs + 150, () => reveal(room));
}

function connectedCount(room) { return [...room.players.values()].filter((p) => p.connected).length; }

function reveal(room) {
  const r = room.round;
  if (!r || r.revealed) return;
  r.revealed = true;
  clearTimers(room);
  const results = [];
  for (const p of room.players.values()) {
    const a = r.answers.get(p.id);
    if (a && a.correct) { p.streak += 1; } else { p.streak = 0; }
    if (a && a.correct) p.score += a.points + Math.min(200, 50 * (p.streak - 1));
    results.push({ id: p.id, name: p.name, choice: a ? a.choice : null, correct: !!(a && a.correct), points: a && a.correct ? a.points + Math.min(200, 50 * (p.streak - 1)) : 0, ms: a ? a.ms : null });
  }
  results.sort((a, b) => (b.correct - a.correct) || ((a.ms ?? 1e9) - (b.ms ?? 1e9)));
  const item = itemsOf(room, r.kind)[r.idx];
  room.history.push({ kind: r.kind, label: r.correct });
  room.state = 'reveal';
  const last = room.roundNo >= room.settings.rounds;
  const nextAt = room.settings.autoNext ? now() + REVEAL_MS : null;
  io.to(room.code).emit('reveal', {
    no: room.roundNo, total: room.settings.rounds, kind: r.kind, answerIndex: r.answerIndex, label: r.correct,
    videoId: isAudio(r.kind) ? item.id : null, results, leaderboard: leaderboard(room), last, nextAt, serverNow: now(),
  });
  broadcastState(room);
  if (room.settings.autoNext) later(room, REVEAL_MS, () => (last ? endGame(room) : nextRound(room)));
}

function endGame(room) {
  clearTimers(room);
  room.state = 'end';
  room.round = null;
  io.to(room.code).emit('end', { leaderboard: leaderboard(room), history: room.history || [] });
  broadcastState(room);
}

function backToLobby(room) {
  clearTimers(room);
  room.state = 'lobby'; room.round = null; room.roundNo = 0;
  broadcastState(room);
}

// ---------------- titles lookup (YouTube oEmbed, no API key) ----------------
async function lookupTitles(ids) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < ids.length) {
      const id = ids[i++];
      try {
        const ctl = new AbortController();
        const tm = setTimeout(() => ctl.abort(), 8000);
        const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`, { signal: ctl.signal });
        clearTimeout(tm);
        if (r.ok) { const j = await r.json(); out.push({ id, title: cleanLabel(j.title), ok: true }); }
        else out.push({ id, ok: false, status: r.status });
      } catch (e) { out.push({ id, ok: false, status: 0 }); }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  const order = new Map(ids.map((x, k) => [x, k]));
  return out.sort((a, b) => order.get(a.id) - order.get(b.id));
}

// ---------------- sockets ----------------
io.on('connection', (socket) => {
  let room = null;
  let me = null; // player object

  const isHost = () => room && me && room.hostId === me.id;
  const fail = (cb, msg) => typeof cb === 'function' && cb({ ok: false, error: msg });

  socket.on('time:ping', (cb) => typeof cb === 'function' && cb(now()));

  socket.on('titles:lookup', async (ids, cb) => {
    if (typeof cb !== 'function' || !Array.isArray(ids)) return;
    const clean = [...new Set(ids.filter((x) => YT_ID.test(x)))].slice(0, 300);
    cb({ ok: true, items: await lookupTitles(clean) });
  });

  function attach(r, p) {
    room = r; me = p;
    p.connected = true; p.socketId = socket.id;
    socket.join(r.code);
    r.emptySince = null;
  }

  socket.on('room:create', (data = {}, cb) => {
    const name = cleanName(data.name);
    if (!name) return fail(cb, 'Nhập tên của bạn trước nha.');
    const pid = String(data.playerId || '').slice(0, 40) || Math.random().toString(36).slice(2);
    const code = newCode();
    const r = {
      code, hostId: pid, players: new Map(), settings: sanitizeSettings(data.settings),
      library: sanitizeLibrary(data.library), state: 'lobby', roundNo: 0, round: null, timers: [],
      used: { music: new Set(), charm: new Set(), burst: new Set() }, history: [], failed: new Set(), createdAt: now(), emptySince: null,
    };
    rooms.set(code, r);
    const p = { id: pid, name, score: 0, streak: 0, connected: true, socketId: socket.id };
    r.players.set(pid, p);
    attach(r, p);
    cb && cb({ ok: true, code, playerId: pid });
    broadcastState(r);
  });

  socket.on('room:join', (data = {}, cb) => {
    const code = String(data.code || '').toUpperCase().trim();
    const r = rooms.get(code);
    if (!r) return fail(cb, 'Không tìm thấy phòng này. Kiểm tra lại mã phòng nha.');
    const pid = String(data.playerId || '').slice(0, 40) || Math.random().toString(36).slice(2);
    let p = r.players.get(pid);
    if (!p) {
      const name = cleanName(data.name);
      if (!name) return fail(cb, 'Nhập tên của bạn trước nha.');
      if (r.players.size >= r.settings.maxPlayers) return fail(cb, 'Phòng đã đủ người rồi.');
      const taken = [...r.players.values()].some((x) => x.name.toLowerCase() === name.toLowerCase());
      if (taken) return fail(cb, 'Tên này đã có người dùng trong phòng, chọn tên khác nha.');
      p = { id: pid, name, score: 0, streak: 0, connected: true, socketId: socket.id };
      r.players.set(pid, p);
    } else if (p.socketId && p.socketId !== socket.id) {
      const old = io.sockets.sockets.get(p.socketId);
      if (old) old.disconnect(true);
    }
    attach(r, p);
    cb && cb({ ok: true, code, playerId: pid, isHost: r.hostId === pid });
    broadcastState(r);
    // late joiner: send current round / reveal
    if (r.state === 'play' && r.round) {
      socket.emit('round', { no: r.roundNo, total: r.settings.rounds, kind: r.round.kind, options: r.round.options, payload: r.round.payload, playAt: r.round.playAt, endsAt: r.round.endsAt, serverNow: now(), late: true, answered: r.round.answers.has(pid) });
    } else if (r.state === 'end') {
      socket.emit('end', { leaderboard: leaderboard(r), history: r.history || [] });
    }
  });

  socket.on('room:leave', () => {
    if (!room || !me) return;
    if (!isHost()) { room.players.delete(me.id); broadcastState(room); }
    socket.leave(room.code); room = null; me = null;
  });

  socket.on('host:settings', (s) => { if (!isHost() || room.state === 'play') return; room.settings = sanitizeSettings(s, room.settings); broadcastState(room); });
  socket.on('host:library', (lib, cb) => {
    if (!isHost()) return fail(cb, 'Chỉ chủ phòng mới đổi được thư viện.');
    if (room.state === 'play' || room.state === 'reveal') return fail(cb, 'Đợi hết ván rồi đổi thư viện nha.');
    room.library = sanitizeLibrary(lib); room.failed = new Set();
    broadcastState(room); cb && cb({ ok: true, counts: counts(room) });
  });
  socket.on('host:start', (cb) => {
    if (!isHost()) return fail(cb, 'Chỉ chủ phòng mới bắt đầu được.');
    const err = startGame(room);
    if (err) return fail(cb, err);
    cb && cb({ ok: true });
  });
  socket.on('host:next', () => {
    if (!isHost()) return;
    if (room.state === 'play') reveal(room);
    else if (room.state === 'reveal') (room.roundNo >= room.settings.rounds ? endGame(room) : nextRound(room));
  });
  socket.on('host:lobby', () => { if (isHost()) backToLobby(room); });
  socket.on('host:kick', (id) => {
    if (!isHost() || id === room.hostId) return;
    const p = room.players.get(id);
    if (!p) return;
    room.players.delete(id);
    const s = p.socketId && io.sockets.sockets.get(p.socketId);
    if (s) { s.emit('kicked'); s.leave(room.code); }
    broadcastState(room);
  });

  socket.on('media:error', () => {
    // only the host's player decides a clip can't be played (avoids trolling)
    if (!isHost() || room.state !== 'play' || !room.round || !isAudio(room.round.kind)) return;
    if (now() > room.round.playAt + 4000) return;
    room.failed.add(room.round.kind + room.round.idx);
    io.to(room.code).emit('toast', 'Bài này không phát được trên YouTube, đổi bài khác…');
    nextRound(room, { reroll: true });
  });

  socket.on('answer', (choice, cb) => {
    if (!room || !me || room.state !== 'play' || !room.round) return fail(cb, 'closed');
    const r = room.round;
    const t = now();
    if (t < r.playAt) return fail(cb, 'early');
    if (t > r.endsAt + 400) return fail(cb, 'late');
    if (r.answers.has(me.id)) return fail(cb, 'dup');
    choice = parseInt(choice, 10);
    if (!(choice >= 0 && choice < r.options.length)) return fail(cb, 'bad');
    const ms = Math.min(r.limitMs, t - r.playAt);
    const correct = choice === r.answerIndex;
    const points = correct ? Math.round(400 + 600 * (1 - ms / r.limitMs)) : 0;
    r.answers.set(me.id, { choice, correct, points, ms });
    cb && cb({ ok: true });
    io.to(room.code).emit('answer:count', { answered: r.answers.size, total: connectedCount(room) });
    const allIn = [...room.players.values()].filter((p) => p.connected).every((p) => r.answers.has(p.id));
    if (allIn) later(room, 600, () => reveal(room));
  });

  socket.on('disconnect', () => {
    if (!room || !me) return;
    if (me.socketId === socket.id) me.connected = false;
    if (connectedCount(room) === 0) room.emptySince = now();
    broadcastState(room);
  });
});

// cleanup idle rooms
setInterval(() => {
  const t = now();
  for (const [code, r] of rooms) {
    if (r.emptySince && t - r.emptySince > 15 * 60 * 1000) { clearTimers(r); rooms.delete(code); }
  }
}, 60 * 1000);

server.listen(PORT, () => console.log(`Genshin Guess running on http://localhost:${PORT}`));
