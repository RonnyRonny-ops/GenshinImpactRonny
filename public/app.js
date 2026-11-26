/* RonnyHarbinger · Genshin Guess — client */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  // ---------- identity ----------
  let playerId = store.get('gg.pid', null);
  if (!playerId) { playerId = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now()); store.set('gg.pid', playerId); }

  // ---------- socket & clock ----------
  const socket = io({ transports: ['websocket', 'polling'] });
  let clockOffset = 0; // serverTime - localTime
  async function syncClock() {
    let best = null;
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const st = await new Promise((res) => socket.timeout(3000).emit('time:ping', (err, v) => res(err ? null : v)));
      const t1 = Date.now();
      if (st == null) continue;
      const rtt = t1 - t0;
      if (!best || rtt < best.rtt) best = { rtt, off: st + rtt / 2 - t1 };
    }
    if (best) clockOffset = best.off;
  }
  const serverNow = () => Date.now() + clockOffset;

  // ---------- state ----------
  let room = null;          // last room:state
  let myCode = null;
  let isHost = false;
  let current = null;       // current round
  let myChoice = null;
  let raf = 0;
  let lastLeaderboard = [];

  // ---------- UI helpers ----------
  function show(view) {
    for (const v of ['home', 'lobby', 'game', 'end']) $('#view-' + v).classList.toggle('hidden', v !== view);
    window.scrollTo({ top: 0 });
  }
  let toastTimer = 0;
  function toast(msg, ms = 2600) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const joinUrl = (code) => `${location.origin}${location.pathname}?room=${code}`;

  // ---------- connection ----------
  socket.on('connect', async () => {
    $('#conn').classList.add('on');
    await syncClock();
    if (myCode) rejoin(myCode); // reconnect after a drop
  });
  socket.on('disconnect', () => $('#conn').classList.remove('on'));
  socket.on('toast', (m) => toast(String(m)));
  socket.on('kicked', () => { myCode = null; store.set('gg.room', null); stopAll(); show('home'); toast('Bạn đã bị mời ra khỏi phòng.'); });

  function rejoin(code) {
    socket.emit('room:join', { code, playerId, name: $('#home-name').value || store.get('gg.name', '') }, (res) => {
      if (!res || !res.ok) { myCode = null; store.set('gg.room', null); show('home'); if (res) $('#home-err').textContent = res.error; return; }
      enterRoom(res);
    });
  }

  function enterRoom(res) {
    myCode = res.code; isHost = !!res.isHost || (room && room.hostId === playerId);
    store.set('gg.room', { code: res.code, at: Date.now() });
    history.replaceState(null, '', '?room=' + res.code);
    renderQR(res.code);
    if (!current) show('lobby');
  }

  // ---------- home ----------
  $('#home-name').value = store.get('gg.name', '');
  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) $('#home-code').value = urlRoom.toUpperCase();
  $('#home-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

  function needName() {
    const n = $('#home-name').value.trim();
    if (!n) { $('#home-err').textContent = 'Nhập tên của bạn trước nha.'; $('#home-name').focus(); return null; }
    store.set('gg.name', n); return n;
  }
  $('#btn-join').addEventListener('click', () => {
    $('#home-err').textContent = '';
    const name = needName(); if (!name) return;
    const code = $('#home-code').value.trim();
    if (code.length !== 6) { $('#home-err').textContent = 'Mã phòng gồm 6 ký tự.'; return; }
    unlockAudio();
    socket.emit('room:join', { code, name, playerId }, (res) => {
      if (!res || !res.ok) { $('#home-err').textContent = res ? res.error : 'Không kết nối được máy chủ.'; return; }
      enterRoom(res);
    });
  });
  $('#home-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
  $('#btn-create').addEventListener('click', async () => {
    $('#home-err').textContent = '';
    const name = needName(); if (!name) return;
    unlockAudio();
    const lib = await loadLibrary();
    socket.emit('room:create', { name, playerId, settings: store.get('gg.settings', {}), library: lib }, (res) => {
      if (!res || !res.ok) { $('#home-err').textContent = res ? res.error : 'Không kết nối được máy chủ.'; return; }
      isHost = true; enterRoom({ ...res, isHost: true });
      const c = lib.music.length + lib.burst.length;
      if (!c) toast('Thư viện đang trống, bấm "Sửa thư viện" để thêm nhạc / chiêu nộ nha.', 4200);
    });
  });
  $('#btn-library-home').addEventListener('click', () => openLibrary());

  // ---------- lobby ----------
  socket.on('room:state', (st) => {
    room = st;
    isHost = st.hostId === playerId;
    document.body.classList.toggle('is-host', isHost);
    $('#lobby-code').textContent = st.code; $('#side-code').textContent = st.code;
    $('#side-url').textContent = location.host + '/?room=' + st.code;
    renderPlayers(st);
    renderSettings(st);
    if (st.state === 'lobby') { current = null; stopAll(); show('lobby'); }
    if (st.state !== 'lobby') renderBoard(lastLeaderboard.length ? mergeBoard(st.players) : st.players.slice().sort((a, b) => b.score - a.score));
  });

  function mergeBoard(players) {
    return players.slice().sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  function renderPlayers(st) {
    const ul = $('#lobby-players'); ul.textContent = '';
    $('#lobby-count').textContent = st.players.length;
    for (const p of st.players) {
      const li = el('li', p.connected ? '' : 'off');
      li.append(el('span', 'nm', p.name));
      if (p.id === st.hostId) li.append(el('span', 'host-tag', 'HOST'));
      if (p.id === playerId) li.append(el('span', 'pill', 'bạn'));
      if (isHost && p.id !== st.hostId) {
        const k = el('button', 'kick', '✕'); k.title = 'Mời ra'; k.setAttribute('aria-label', 'Mời ' + p.name + ' ra khỏi phòng');
        k.addEventListener('click', () => socket.emit('host:kick', p.id)); li.append(k);
      }
      ul.append(li);
    }
    $('#lobby-wait').classList.toggle('hidden', isHost);
  }

  function renderSettings(st) {
    const s = st.settings;
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#host-panel')) { /* don't clobber while typing */ }
    else {
      $('#set-mode').value = s.mode; $('#set-rounds').value = s.rounds; $('#set-music').value = s.musicTime;
      $('#set-burst').value = s.burstTime; $('#set-max').value = s.maxPlayers; $('#set-auto').checked = s.autoNext;
    }
    $('#lib-counts').textContent = `Thư viện: ${st.counts.music} bài nhạc · ${st.counts.burst} ảnh chiêu nộ`;
    $('#btn-start').disabled = !st.playable;
    $('#lobby-err').textContent = st.playable ? '' : 'Chế độ này chưa có đủ nội dung (cần ít nhất 2 đáp án khác nhau).';
  }

  function sendSettings() {
    const s = { mode: $('#set-mode').value, rounds: $('#set-rounds').value, musicTime: $('#set-music').value, burstTime: $('#set-burst').value, maxPlayers: $('#set-max').value, autoNext: $('#set-auto').checked };
    store.set('gg.settings', s);
    socket.emit('host:settings', s);
  }
  for (const id of ['#set-mode', '#set-rounds', '#set-music', '#set-burst', '#set-max', '#set-auto']) $(id).addEventListener('change', sendSettings);
  $('#btn-start').addEventListener('click', () => { unlockAudio(); socket.emit('host:start', (res) => { if (res && !res.ok) $('#lobby-err').textContent = res.error; }); });
  $('#btn-copy-link').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(joinUrl(myCode)); toast('Đã copy link mời!'); } catch { toast(joinUrl(myCode), 5000); }
  });
  $('#btn-library-lobby').addEventListener('click', () => openLibrary());
  $('#btn-next').addEventListener('click', () => socket.emit('host:next'));
  $('#btn-lobby').addEventListener('click', () => socket.emit('host:lobby'));
  $('#btn-again').addEventListener('click', () => socket.emit('host:start', (res) => { if (res && !res.ok) toast(res.error); }));
  $('#btn-end-lobby').addEventListener('click', () => socket.emit('host:lobby'));

  function renderQR(code) {
    const box = $('#side-qr'); box.textContent = '';
    const img = el('img'); img.alt = 'Mã QR vào phòng ' + code; img.src = '/qr.svg?text=' + encodeURIComponent(joinUrl(code));
    box.append(img);
  }

  function renderBoard(list, gains) {
    lastLeaderboard = list;
    const ol = $('#leaderboard'); ol.textContent = '';
    for (const p of list) {
      const li = el('li', p.id === playerId ? 'me' : '');
      li.append(el('span', 'nm', p.name));
      if (gains && gains.has(p.id)) li.append(el('span', 'gain', '+' + gains.get(p.id)));
      li.append(el('span', 'sc', p.score));
      ol.append(li);
    }
  }

  // ---------- YouTube ----------
  let yt = null, ytReady = false, ytApiFailed = false;
  let media = { want: false, ready: false, startSec: 0, videoId: null, errored: false, started: false };
  let volume = store.get('gg.vol', 70);
  $('#volume').value = volume;
  $('#volume').addEventListener('input', (e) => { volume = +e.target.value; store.set('gg.vol', volume); if (yt && ytReady && !yt.isMuted()) yt.setVolume(volume); });

  window.onYouTubeIframeAPIReady = () => {
    yt = new YT.Player('yt-player', {
      width: '100%', height: '100%',
      playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1, iv_load_policy: 3, fs: 0 },
      events: { onReady: () => { ytReady = true; }, onStateChange: onYtState, onError: onYtError },
    });
  };
  (function loadYT() {
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.async = true;
    s.onerror = () => { ytApiFailed = true; };
    document.head.append(s);
    setTimeout(() => { if (!ytReady) ytApiFailed = true; }, 15000);
  })();

  function onYtState(e) {
    if (!media.videoId) return;
    if (e.data === YT.PlayerState.PLAYING && !media.ready) {
      // first frames: find duration, jump to the clip start and wait for the synced start
      const d = yt.getDuration() || 0;
      media.startSec = d > 20 ? Math.floor(d * media.startFrac) : 0;
      media.ready = true;
      if (!media.want) { yt.pauseVideo(); yt.seekTo(media.startSec, true); }
      else startMediaNow();
    }
  }
  function onYtError() {
    media.errored = true;
    if (isHost && current && current.kind === 'music') socket.emit('media:error');
    $('#game-status').textContent = 'Không phát được bài này trên máy bạn.';
  }
  function prepareMusic(p) {
    media = { want: false, ready: false, startSec: 0, startFrac: p.startFrac, videoId: p.videoId, errored: false, started: false };
    if (!ytReady) return;
    yt.mute();
    yt.loadVideoById({ videoId: p.videoId });
  }
  function startMediaNow() {
    if (!ytReady || !media.ready) return;
    const elapsed = Math.max(0, (serverNow() - current.playAt) / 1000);
    yt.seekTo(media.startSec + elapsed, true);
    yt.unMute(); yt.setVolume(volume); yt.playVideo();
    media.started = true;
    setTimeout(() => {
      if (!current || current.kind !== 'music' || current.revealed) return;
      const st = yt.getPlayerState && yt.getPlayerState();
      if (st !== YT.PlayerState.PLAYING) $('#btn-unmute').classList.remove('hidden');
    }, 1800);
  }
  $('#btn-unmute').addEventListener('click', () => { $('#btn-unmute').classList.add('hidden'); if (ytReady) { yt.unMute(); yt.setVolume(volume); yt.playVideo(); } });
  function stopMedia() { media.videoId = null; if (ytReady) { try { yt.stopVideo(); } catch {} } }
  function unlockAudio() { try { const A = window.AudioContext || window.webkitAudioContext; if (A) { const c = new A(); c.resume().then(() => c.close()); } } catch {} }

  // ---------- rounds ----------
  socket.on('round', (r) => {
    clockOffset = clockOffset || (r.serverNow - Date.now());
    current = { ...r, revealed: false };
    myChoice = r.answered ? -1 : null;
    show('game');
    $('#round-label').textContent = `Vòng ${r.no}/${r.total}`;
    $('#round-kind').textContent = r.kind === 'music' ? 'ĐOÁN NHẠC' : 'ĐOÁN CHIÊU NỘ';
    $('#question').textContent = r.kind === 'music' ? 'Bài nhạc này tên là gì?' : 'Đây là chiêu nộ của nhân vật nào?';
    $('#answered').textContent = '';
    $('#game-status').textContent = r.answered ? 'Bạn đã trả lời vòng này.' : '';
    $('#reveal-label').classList.add('hidden');
    $('#btn-unmute').classList.add('hidden');
    $('#yt-wrap').classList.remove('reveal'); $('#yt-cover').classList.remove('hidden');
    const stage = $('#stage');
    stage.classList.toggle('kind-burst', r.kind === 'burst');
    $('#music-viz').classList.toggle('hidden', r.kind !== 'music');
    $('#music-viz').classList.remove('on');
    $('#burst-box').classList.toggle('hidden', r.kind !== 'burst');
    if (r.kind === 'music') {
      stopMedia(); prepareMusic(r.payload);
      if (ytApiFailed) $('#game-status').textContent = 'Trình duyệt chặn YouTube nên không phát được nhạc.';
    } else {
      stopMedia();
      const img = $('#burst-img');
      img.style.visibility = 'hidden';
      img.style.transformOrigin = `${(r.payload.zoomX * 100).toFixed(1)}% ${(r.payload.zoomY * 100).toFixed(1)}%`;
      img.src = r.payload.img;
    }
    renderOptions(r.options);
    cancelAnimationFrame(raf); raf = requestAnimationFrame(tick);
  });

  function renderOptions(opts) {
    const box = $('#options'); box.textContent = '';
    opts.forEach((o, i) => {
      const b = el('button', 'opt', o); b.dataset.key = 'ABCD'[i];
      b.disabled = true;
      b.addEventListener('click', () => choose(i));
      box.append(b);
    });
  }
  function setOptionsEnabled(on) { $$('#options .opt').forEach((b) => { b.disabled = !on || myChoice !== null; }); }

  function choose(i) {
    if (!current || current.revealed || myChoice !== null) return;
    if (serverNow() < current.playAt) return;
    myChoice = i;
    $$('#options .opt').forEach((b, k) => { b.disabled = true; b.classList.toggle('chosen', k === i); b.classList.toggle('dim', k !== i); });
    $('#game-status').textContent = 'Đã chọn! Chờ kết quả…';
    socket.emit('answer', i, (res) => { if (res && !res.ok && res.error === 'late') $('#game-status').textContent = 'Hết giờ mất rồi!'; });
  }
  document.addEventListener('keydown', (e) => {
    if ($('#view-game').classList.contains('hidden') || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    const k = { '1': 0, '2': 1, '3': 2, '4': 3, a: 0, b: 1, c: 2, d: 3 }[e.key.toLowerCase()];
    if (k !== undefined && k < $$('#options .opt').length) choose(k);
  });

  function tick() {
    if (!current) return;
    const t = serverNow();
    const total = current.endsAt - current.playAt;
    const cd = $('#countdown');
    if (t < current.playAt) {
      cd.classList.remove('hidden'); cd.textContent = Math.ceil((current.playAt - t) / 1000);
      $('#timebar-fill').style.transform = 'scaleX(1)';
      setOptionsEnabled(false);
    } else {
      cd.classList.add('hidden');
      if (!current.revealed) {
        const p = Math.min(1, (t - current.playAt) / total);
        const fill = $('#timebar-fill');
        fill.style.transform = `scaleX(${1 - p})`;
        fill.style.background = p > 0.75 ? 'linear-gradient(90deg,#ff8a96,#ffd678)' : '';
        setOptionsEnabled(myChoice === null && p < 1);
        if (current.kind === 'music') {
          $('#music-viz').classList.add('on');
          if (!media.want) { media.want = true; startMediaNow(); }
        } else {
          const img = $('#burst-img');
          img.style.visibility = 'visible';
          const q = Math.min(1, p / 0.8);               // fully clear at 80% of the time
          const ease = 1 - Math.pow(1 - q, 2);
          img.style.transform = `scale(${(3.2 - 2.2 * ease).toFixed(3)})`;
          img.style.filter = `blur(${(16 * (1 - ease)).toFixed(1)}px) saturate(${(0.6 + 0.4 * ease).toFixed(2)})`;
        }
      }
    }
    raf = requestAnimationFrame(tick);
  }

  socket.on('answer:count', ({ answered, total }) => { $('#answered').textContent = `${answered}/${total} đã trả lời`; });

  socket.on('reveal', (r) => {
    if (!current) current = { kind: r.kind };
    current.revealed = true;
    $('#countdown').classList.add('hidden');
    $('#timebar-fill').style.transform = 'scaleX(0)';
    $$('#options .opt').forEach((b, k) => {
      b.disabled = true; b.classList.remove('dim');
      if (k === r.answerIndex) b.classList.add('right');
      else if (k === myChoice) b.classList.add('wrong');
      else b.classList.add('dim');
    });
    const lab = $('#reveal-label'); lab.textContent = r.label; lab.classList.remove('hidden');
    if (r.kind === 'burst') {
      const img = $('#burst-img'); img.style.visibility = 'visible'; img.style.transform = 'scale(1)'; img.style.filter = 'none';
    } else {
      $('#music-viz').classList.add('hidden');
      $('#yt-wrap').classList.add('reveal'); $('#yt-cover').classList.add('hidden');
      if (!media.started && ytReady && media.ready) { media.want = true; try { yt.unMute(); yt.setVolume(volume); yt.playVideo(); } catch {} }
    }
    const mine = r.results.find((x) => x.id === playerId);
    let msg = mine ? (mine.correct ? `Chính xác! +${mine.points} điểm` : (mine.choice === null ? 'Bạn chưa trả lời kịp.' : 'Sai mất rồi!')) : '';
    const firstRight = r.results.find((x) => x.correct);
    if (firstRight) msg += ` · Nhanh nhất: ${firstRight.name} (${(firstRight.ms / 1000).toFixed(1)}s)`;
    const right = r.results.filter((x) => x.correct).length;
    msg += ` · ${right}/${r.results.length} người đúng`;
    $('#game-status').textContent = msg;
    const gains = new Map(r.results.filter((x) => x.points > 0).map((x) => [x.id, x.points]));
    renderBoard(r.leaderboard, gains);
    if (r.nextAt) {
      const local = r.nextAt - clockOffset;
      const upd = () => { const s = Math.max(0, Math.ceil((local - Date.now()) / 1000)); if (current && current.revealed && !$('#view-game').classList.contains('hidden')) { $('#answered').textContent = r.last ? `Tổng kết sau ${s}s` : `Vòng tiếp sau ${s}s`; if (s > 0) setTimeout(upd, 250); } };
      upd();
    } else $('#answered').textContent = isHost ? 'Bấm "Tiếp" để sang vòng mới' : 'Chờ chủ phòng…';
  });

  socket.on('end', ({ leaderboard }) => {
    current = null; cancelAnimationFrame(raf); stopMedia();
    show('end');
    const pod = $('#podium'); pod.textContent = '';
    const top = [leaderboard[1], leaderboard[0], leaderboard[2]];
    top.forEach((p, i) => {
      const rank = [2, 1, 3][i];
      const d = el('div', 'pod p' + rank);
      if (p) { d.append(el('div', 'rank', String(rank)), el('div', 'nm', p.name), el('div', 'sc', p.score + ' điểm')); }
      else d.style.visibility = 'hidden';
      pod.append(d);
    });
    const ol = $('#final-board'); ol.textContent = '';
    leaderboard.forEach((p) => { const li = el('li', p.id === playerId ? 'me' : ''); li.append(el('span', 'nm', p.name), el('span', 'sc', p.score)); ol.append(li); });
  });

  function stopAll() { current = null; cancelAnimationFrame(raf); stopMedia(); }

  // =====================================================================
  // LIBRARY (stored in IndexedDB on the host's browser)
  // =====================================================================
  const DB_NAME = 'ronny-genshin-guess';
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function idbGet(k) { try { const db = await idb(); return await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); } catch { return undefined; } }
  async function idbSet(k, v) { try { const db = await idb(); await new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); return true; } catch { return false; } }

  let library = { music: [], burst: [] };
  async function loadLibrary() {
    const v = await idbGet('library');
    if (v && Array.isArray(v.music) && Array.isArray(v.burst)) library = v;
    return library;
  }
  let saveTimer = 0;
  function saveLibrary() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const ok = await idbSet('library', library);
      $('#lib-sync').textContent = ok ? 'Đã lưu trên trình duyệt này' : 'Không lưu được (trình duyệt chặn bộ nhớ)';
    }, 300);
    updateCounts();
  }
  function updateCounts() {
    $('#tab-music-count').textContent = library.music.length;
    $('#tab-burst-count').textContent = library.burst.length;
  }

  async function openLibrary() {
    await loadLibrary();
    $('#library').classList.remove('hidden');
    renderMusicList(); renderBurstGrid(); updateCounts();
    $('#lib-sync').textContent = '';
  }
  async function closeLibrary() {
    $('#library').classList.add('hidden');
    clearTimeout(saveTimer); await idbSet('library', library);
    if (isHost && myCode) {
      socket.emit('host:library', library, (res) => {
        if (res && res.ok) toast(`Đã cập nhật thư viện phòng: ${res.counts.music} nhạc · ${res.counts.burst} ảnh`);
        else if (res) toast(res.error);
      });
    }
  }
  $('#lib-close').addEventListener('click', closeLibrary);
  $('#lib-done').addEventListener('click', closeLibrary);
  $('#library').addEventListener('click', (e) => { if (e.target.id === 'library') closeLibrary(); });
  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
    $$('.tab-body').forEach((b) => b.classList.toggle('hidden', b.dataset.body !== t.dataset.tab));
  }));

  // ----- music -----
  function cleanTitle(t) {
    let s = String(t || '');
    s = s.replace(/\[[^\]]*\]|【[^】]*】/g, ' ')
      .replace(/\((?:[^)]*(?:official|ost|soundtrack|audio|video|lyric|hoyo|genshin|music|bgm)[^)]*)\)/gi, ' ')
      .replace(/genshin\s*impact\s*(ost|bgm|music|soundtrack)?\s*[-:|–—]?/gi, ' ')
      .replace(/\b(official|original|game|soundtrack|ost|bgm|hoyo-?mix|audio|video|full|ver\.?|version)\b/gi, ' ')
      .replace(/\s*[|｜]\s*.*$/, '')
      .replace(/^[\s\-–—:|]+|[\s\-–—:|]+$/g, '')
      .replace(/\s{2,}/g, ' ').trim();
    return s || String(t || '').trim();
  }
  function parseLinks(text) {
    const lists = new Set(), vids = new Set();
    for (const raw of text.split(/[\s,]+/)) {
      if (!raw) continue;
      try {
        const u = new URL(raw);
        const l = u.searchParams.get('list'); if (l) lists.add(l);
        const v = u.searchParams.get('v'); if (v && /^[\w-]{11}$/.test(v)) vids.add(v);
        if (/youtu\.be$/.test(u.hostname)) { const id = u.pathname.slice(1, 12); if (/^[\w-]{11}$/.test(id)) vids.add(id); }
        const m = u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{11})/); if (m) vids.add(m[1]);
      } catch { if (/^[\w-]{11}$/.test(raw)) vids.add(raw); else if (/^(PL|OL|UU|RD)[\w-]{10,}$/.test(raw)) lists.add(raw); }
    }
    return { lists: [...lists], vids: [...vids] };
  }
  // read playlist video ids with a hidden YouTube player (no API key needed)
  let probe = null;
  function playlistIds(listId) {
    return new Promise((resolve) => {
      if (!window.YT || !YT.Player) return resolve([]);
      let done = false;
      const finish = (ids) => { if (done) return; done = true; try { probe.destroy(); } catch {} probe = null; const box = $('#yt-probe'); box.textContent = ''; box.append(el('div')); box.firstChild.id = 'yt-probe-player'; resolve(ids || []); };
      const box = $('#yt-probe'); box.textContent = ''; const d = el('div'); d.id = 'yt-probe-player'; box.append(d);
      probe = new YT.Player('yt-probe-player', {
        width: 2, height: 2, playerVars: { listType: 'playlist', list: listId, autoplay: 0 },
        events: {
          onReady: () => { let n = 0; const poll = () => { const ids = probe && probe.getPlaylist && probe.getPlaylist(); if (ids && ids.length) finish(ids); else if (++n < 30) setTimeout(poll, 400); else finish([]); }; poll(); },
          onError: () => finish([]),
        },
      });
      setTimeout(() => finish([]), 20000);
    });
  }
  $('#music-import').addEventListener('click', async () => {
    const { lists, vids } = parseLinks($('#music-input').value);
    const msg = $('#music-msg');
    if (!lists.length && !vids.length) { msg.textContent = 'Không thấy link YouTube hợp lệ.'; return; }
    if (lists.length && (!window.YT || !YT.Player)) { msg.textContent = 'Chưa tải được YouTube, thử lại sau vài giây.'; return; }
    $('#music-import').disabled = true;
    const ids = new Set(vids);
    for (const l of lists) { msg.textContent = 'Đang đọc playlist…'; (await playlistIds(l)).forEach((x) => ids.add(x)); }
    const have = new Set(library.music.map((t) => t.id));
    const fresh = [...ids].filter((x) => !have.has(x));
    if (!fresh.length) { msg.textContent = ids.size ? 'Các bài này đã có trong thư viện.' : 'Không đọc được bài nào từ link này.'; $('#music-import').disabled = false; return; }
    msg.textContent = `Đang lấy tên ${fresh.length} bài…`;
    const items = [];
    for (let i = 0; i < fresh.length; i += 100) {
      const res = await new Promise((r) => socket.timeout(60000).emit('titles:lookup', fresh.slice(i, i + 100), (err, v) => r(err ? null : v)));
      if (res && res.items) items.push(...res.items);
    }
    let added = 0, blocked = 0;
    for (const it of items) { if (it.ok && it.title) { library.music.push({ id: it.id, title: cleanTitle(it.title), orig: it.title }); added++; } else blocked++; }
    msg.textContent = `Đã thêm ${added} bài${blocked ? ` · bỏ qua ${blocked} bài không cho phát nhúng` : ''}.`;
    $('#music-input').value = '';
    $('#music-import').disabled = false;
    saveLibrary(); renderMusicList();
  });
  $('#music-filter').addEventListener('input', renderMusicList);
  $('#music-clean').addEventListener('click', () => { library.music.forEach((t) => { t.title = cleanTitle(t.orig || t.title); }); saveLibrary(); renderMusicList(); });
  $('#music-clear').addEventListener('click', () => { if (library.music.length && confirmInline('#music-clear', 'Bấm lần nữa để xoá hết')) { library.music = []; saveLibrary(); renderMusicList(); } });
  function confirmInline(sel, text) {
    const b = $(sel);
    if (b.dataset.armed) { delete b.dataset.armed; b.textContent = b.dataset.label; return true; }
    b.dataset.label = b.textContent; b.dataset.armed = '1'; b.textContent = text;
    setTimeout(() => { if (b.dataset.armed) { delete b.dataset.armed; b.textContent = b.dataset.label; } }, 3000);
    return false;
  }
  function renderMusicList() {
    const ul = $('#music-list'); ul.textContent = '';
    const f = $('#music-filter').value.trim().toLowerCase();
    const list = library.music.filter((t) => !f || t.title.toLowerCase().includes(f));
    for (const t of list.slice(0, 400)) {
      const li = el('li');
      const im = el('img'); im.loading = 'lazy'; im.alt = ''; im.src = `https://i.ytimg.com/vi/${t.id}/mqdefault.jpg`;
      const inp = el('input'); inp.value = t.title; inp.maxLength = 80; inp.setAttribute('aria-label', 'Tên bài');
      inp.addEventListener('change', () => { t.title = inp.value.trim() || t.title; saveLibrary(); });
      const del = el('button', 'del', '✕'); del.setAttribute('aria-label', 'Xoá bài');
      del.addEventListener('click', () => { library.music = library.music.filter((x) => x !== t); saveLibrary(); li.remove(); });
      li.append(im, inp, del); ul.append(li);
    }
    if (!library.music.length) ul.append(el('li', 'muted small', 'Chưa có bài nào. Dán link playlist YouTube OST Genshin ở trên nha.'));
    updateCounts();
  }

  // ----- burst images -----
  function compress(fileOrBlob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(fileOrBlob);
      const img = new Image();
      img.onload = () => {
        const max = 1100; const s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }
  $('#burst-add').addEventListener('click', async () => {
    const name = $('#burst-name').value.trim();
    const msg = $('#burst-msg');
    if (!name) { msg.textContent = 'Nhập tên nhân vật trước nha.'; $('#burst-name').focus(); return; }
    const files = [...$('#burst-files').files];
    const url = $('#burst-url').value.trim();
    if (!files.length && !url) { msg.textContent = 'Chọn ảnh từ máy hoặc dán link ảnh.'; return; }
    let n = 0;
    for (const f of files) { try { library.burst.push({ name, img: await compress(f) }); n++; } catch {} }
    if (url) {
      if (!/^https:\/\//.test(url)) msg.textContent = 'Link ảnh phải bắt đầu bằng https://';
      else { library.burst.push({ name, img: url }); n++; }
    }
    $('#burst-files').value = ''; $('#burst-url').value = '';
    msg.textContent = `Đã thêm ${n} ảnh cho ${name}.`;
    saveLibrary(); renderBurstGrid();
  });
  function renderBurstGrid() {
    const g = $('#burst-grid'); g.textContent = '';
    const names = [...new Set(library.burst.map((b) => b.name))];
    const dl = $('#burst-names'); dl.textContent = ''; names.forEach((n) => { const o = el('option'); o.value = n; dl.append(o); });
    library.burst.forEach((b) => {
      const c = el('div', 'bcard');
      const im = el('img'); im.loading = 'lazy'; im.alt = b.name; im.src = b.img;
      const foot = el('div', 'bfoot');
      const inp = el('input'); inp.value = b.name; inp.maxLength = 60; inp.setAttribute('aria-label', 'Tên nhân vật');
      inp.addEventListener('change', () => { b.name = inp.value.trim() || b.name; saveLibrary(); });
      const del = el('button', 'del', '✕'); del.setAttribute('aria-label', 'Xoá ảnh');
      del.addEventListener('click', () => { library.burst = library.burst.filter((x) => x !== b); saveLibrary(); c.remove(); updateCounts(); });
      foot.append(inp, del); c.append(im, foot); g.append(c);
    });
    if (!library.burst.length) g.append(el('p', 'muted small', 'Chưa có ảnh nào. Cần ít nhất 2 nhân vật khác nhau để chơi.'));
    updateCounts();
  }

  // ----- backup -----
  $('#lib-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ app: 'ronny-genshin-guess', v: 1, library })], { type: 'application/json' });
    const a = el('a'); a.href = URL.createObjectURL(blob); a.download = 'thu-vien-genshin-guess.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    $('#backup-msg').textContent = 'Đã xuất file.';
  });
  $('#lib-import').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      const lib = j.library || j;
      const m = Array.isArray(lib.music) ? lib.music.filter((t) => t && /^[\w-]{11}$/.test(t.id) && t.title) : [];
      const b = Array.isArray(lib.burst) ? lib.burst.filter((t) => t && t.name && typeof t.img === 'string' && (/^data:image\//.test(t.img) || /^https:\/\//.test(t.img))) : [];
      const have = new Set(library.music.map((t) => t.id));
      m.forEach((t) => { if (!have.has(t.id)) library.music.push({ id: t.id, title: String(t.title).slice(0, 80), orig: t.orig }); });
      b.forEach((t) => library.burst.push({ name: String(t.name).slice(0, 60), img: t.img }));
      saveLibrary(); renderMusicList(); renderBurstGrid();
      $('#backup-msg').textContent = `Đã nhập ${m.length} bài nhạc · ${b.length} ảnh.`;
    } catch { $('#backup-msg').textContent = 'File không đúng định dạng.'; }
    e.target.value = '';
  });

  // ---------- boot ----------
  loadLibrary().then(updateCounts);
  const saved = store.get('gg.room', null);
  const resumeCode = urlRoom || (saved && Date.now() - saved.at < 3 * 3600 * 1000 ? saved.code : null);
  if (resumeCode && store.get('gg.name', '')) {
    socket.once('connect', () => {
      socket.emit('room:join', { code: resumeCode, playerId, name: store.get('gg.name', '') }, (res) => {
        if (res && res.ok) enterRoom(res);
      });
    });
  }
})();
