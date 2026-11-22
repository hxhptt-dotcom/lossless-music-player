(() => {
  'use strict';

  const qs = (sel) => document.querySelector(sel);
  const qsa = (sel) => Array.from(document.querySelectorAll(sel));

  const PROXY_BASE = (() => {
    try {
      if (window.AndroidMusic && typeof window.AndroidMusic.getProxyBase === 'function') {
        return window.AndroidMusic.getProxyBase() || '';
      }
    } catch (_) {}
    const p = new URLSearchParams(location.search).get('proxy');
    return p || '';
  })();

  const STORAGE = {
    FAVS: 'lm_android_favs_v1',
    HISTORY: 'lm_android_history_v1',
    QUALITY: 'lm_android_quality_v1',
    MODE: 'lm_android_mode_v1'
  };

  const state = {
    view: 'home',
    prevView: 'home',
    categories: ['全部', '流行', '华语', '粤语', '欧美', '治愈', '电子', '说唱', '怀旧', '轻音乐'],
    currentCat: '全部',
    charts: [],
    currentChartId: '3778678',
    playlists: [],
    homeNewTracks: [],
    chartTracks: [],
    searchTracks: [],
    detailTracks: [],
    detailInfo: null,
    mineTab: 'favorites',
    favorites: loadJSON(STORAGE.FAVS, []),
    history: loadJSON(STORAGE.HISTORY, []),
    prefQuality: localStorage.getItem(STORAGE.QUALITY) || 'flac',
    playMode: localStorage.getItem(STORAGE.MODE) || 'loop', // loop | single | shuffle
    queue: [],
    queueIdx: -1,
    currentTrack: null,
    currentResolved: null,
    lyrics: [],
    activeLrcIdx: -1,
    isPlaying: false,
    isSeeking: false,
    playToken: 0
  };

  const audio = qs('#audioEl');

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = qs('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function fmtSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`;
  }

  function trackKeyOf(t) {
    return t?.track_key || `netease:${t?.song_id || t?.id || t?.title || ''}`;
  }

  function isFav(t) {
    const k = trackKeyOf(t);
    return state.favorites.some((x) => trackKeyOf(x) === k);
  }

  function toggleFav(track) {
    if (!track) return;
    const k = trackKeyOf(track);
    const idx = state.favorites.findIndex((x) => trackKeyOf(x) === k);
    if (idx >= 0) {
      state.favorites.splice(idx, 1);
      showToast('已移出我喜欢');
    } else {
      state.favorites.unshift(track);
      showToast('已添加到我喜欢 ♥');
    }
    saveJSON(STORAGE.FAVS, state.favorites.slice(0, 200));
    syncFavoriteUI();
  }

  function pushHistory(track) {
    if (!track) return;
    const k = trackKeyOf(track);
    state.history = [track, ...state.history.filter((x) => trackKeyOf(x) !== k)].slice(0, 100);
    saveJSON(STORAGE.HISTORY, state.history);
    updateMineCounts();
  }

  async function apiGet(path, params = {}) {
    const sp = new URLSearchParams(params);
    const url = `${PROXY_BASE}${path}${sp.toString() ? '?' + sp.toString() : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /* ==================== NAVIGATION ==================== */
  function switchView(name, rememberPrev = false) {
    if (rememberPrev && state.view !== name) state.prevView = state.view;
    state.view = name;
    qsa('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));

    // Top tabs sync
    qsa('.top-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === name);
    });

    // Bottom nav sync
    qsa('.bnav-item').forEach((btn) => {
      const target = btn.dataset.nav;
      const active =
        (target === 'home' && name === 'home') ||
        (target === 'playlists' && (name === 'playlists' || name === 'charts' || name === 'detail')) ||
        (target === 'mine' && name === 'mine') ||
        (target === 'settings' && name === 'settings');
      btn.classList.toggle('active', active);
    });

    qs('#mainScroll').scrollTop = 0;

    if (name === 'mine') renderMineList();
    if (name === 'charts' && state.chartTracks.length === 0) loadChart(state.currentChartId);
  }

  /* ==================== DATA LOADING ==================== */
  async function initApp() {
    updateQualitySettingUI();
    updateMineCounts();
    if (!PROXY_BASE) {
      qs('#engineStatusText').textContent = '预览模式（未指定本地代理）';
    }

    try {
      const [discRes, newRes] = await Promise.all([
        apiGet('/api/discover', { category: state.currentCat }),
        apiGet('/api/playlist', { id: '3779629' }) // 新歌榜
      ]);

      if (discRes?.ok && discRes.data) {
        state.charts = discRes.data.charts || [];
        state.categories = discRes.data.categories || state.categories;
        state.playlists = discRes.data.playlists || [];
        renderHomePlaylists();
        renderPlaylistCats();
        renderAllPlaylists();
        renderChartTabs();
      }

      if (newRes?.ok && Array.isArray(newRes.data)) {
        state.homeNewTracks = newRes.data;
        renderHomeNewTracks();
        if (state.queue.length === 0 && state.homeNewTracks.length > 0) {
          state.queue = state.homeNewTracks.slice(0, 30);
          renderQueue();
        }
      }
    } catch (err) {
      showToast('曲库加载失败，请检查网络连接');
      qs('#homeNewTracks').innerHTML = '<div class="empty-state">网络开小差了，下拉或点击歌单重试</div>';
    }
  }

  async function loadPlaylistsByCategory(cat) {
    state.currentCat = cat;
    renderPlaylistCats();
    qs('#allPlaylistsGrid').innerHTML = '<div class="empty-state">加载歌单中…</div>';
    try {
      const res = await apiGet('/api/discover', { category: cat });
      state.playlists = res?.data?.playlists || [];
      renderAllPlaylists();
    } catch (_) {
      qs('#allPlaylistsGrid').innerHTML = '<div class="empty-state">加载失败，请重试</div>';
    }
  }

  async function loadChart(chartId) {
    state.currentChartId = String(chartId);
    renderChartTabs();
    qs('#chartTrackList').innerHTML = '<div class="empty-state">正在加载榜单曲目…</div>';
    try {
      const res = await apiGet('/api/playlist', { id: state.currentChartId });
      state.chartTracks = res?.data || [];
      renderTrackList(qs('#chartTrackList'), state.chartTracks, true);
    } catch (_) {
      qs('#chartTrackList').innerHTML = '<div class="empty-state">榜单加载失败</div>';
    }
  }

  async function openPlaylistDetail(pl) {
    state.detailInfo = pl;
    qs('#detailCover').src = pl.cover || '';
    qs('#detailTitle').textContent = pl.title || '精选歌单';
    qs('#detailMeta').textContent = '正在加载无损曲目…';
    qs('#detailTrackList').innerHTML = '<div class="empty-state">加载中…</div>';
    switchView('detail', true);
    try {
      const res = await apiGet('/api/playlist', { id: pl.id });
      state.detailTracks = res?.data || [];
      qs('#detailMeta').textContent = `${pl.meta || '精选歌单'} · 共 ${state.detailTracks.length} 首`;
      renderTrackList(qs('#detailTrackList'), state.detailTracks, true);
    } catch (_) {
      qs('#detailTrackList').innerHTML = '<div class="empty-state">歌单曲目加载失败</div>';
    }
  }

  async function doSearch(keyword) {
    const q = (keyword || '').trim();
    if (!q) return;
    qs('#searchInput').value = q;
    qs('#searchClearBtn').hidden = false;
    qs('#hotTagsWrap').style.display = 'none';
    qs('#searchTrackList').innerHTML = '<div class="empty-state">正在全网检索无损曲目…</div>';
    try {
      const res = await apiGet('/api/search', { q });
      state.searchTracks = res?.data || [];
      if (state.searchTracks.length === 0) {
        qs('#searchTrackList').innerHTML = '<div class="empty-state">未找到相关歌曲，换个关键词试试</div>';
      } else {
        renderTrackList(qs('#searchTrackList'), state.searchTracks, false);
      }
    } catch (_) {
      qs('#searchTrackList').innerHTML = '<div class="empty-state">搜索失败，请检查网络</div>';
    }
  }

  /* ==================== RENDERING ==================== */
  function renderHomePlaylists() {
    const el = qs('#homePlaylistStrip');
    const items = state.playlists.slice(0, 8);
    if (!items.length) {
      el.innerHTML = '<div class="empty-state">暂无歌单</div>';
      return;
    }
    el.innerHTML = items.map((p, idx) => `
      <div class="pl-mini-card" data-idx="${idx}">
        <img src="${esc(p.cover)}" alt="" loading="lazy" />
        <div class="pl-mini-grad"></div>
        <div class="pl-mini-title">${esc(p.title)}</div>
        <div class="pl-mini-play">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </div>
      </div>
    `).join('');

    el.querySelectorAll('.pl-mini-card').forEach((card) => {
      card.addEventListener('click', () => {
        const pl = items[Number(card.dataset.idx)];
        if (pl) openPlaylistDetail(pl);
      });
    });
  }

  function renderHomeNewTracks() {
    const el = qs('#homeNewTracks');
    const items = state.homeNewTracks.slice(0, 4);
    const activeKey = state.currentTrack ? trackKeyOf(state.currentTrack) : '';

    el.innerHTML = items.map((t, idx) => {
      const active = trackKeyOf(t) === activeKey;
      const loved = isFav(t);
      const bars = '<i></i>'.repeat(11);
      return `
        <div class="new-row ${active ? 'active' : ''}" data-idx="${idx}">
          <img class="new-cover" src="${esc(t.cover)}" alt="" loading="lazy" />
          <div class="new-mid">
            <div class="new-title">${esc(t.title)}</div>
            <div class="new-wave-line">
              <div class="mini-wave">${bars}</div>
              <span class="new-artist">${esc(t.artist)}</span>
            </div>
          </div>
          <button class="new-fav ${loved ? 'loved' : ''}" data-fav-idx="${idx}" aria-label="喜欢">${loved ? '♥' : '♡'}</button>
        </div>
      `;
    }).join('');

    el.querySelectorAll('.new-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.new-fav')) return;
        const idx = Number(row.dataset.idx);
        playFromList(state.homeNewTracks, idx);
      });
    });

    el.querySelectorAll('.new-fav').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFav(items[Number(btn.dataset.favIdx)]);
      });
    });
  }

  function renderPlaylistCats() {
    const el = qs('#playlistCatChips');
    el.innerHTML = state.categories.map((c) =>
      `<button class="chip ${c === state.currentCat ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`
    ).join('');
    el.querySelectorAll('.chip').forEach((b) => {
      b.addEventListener('click', () => loadPlaylistsByCategory(b.dataset.cat));
    });
  }

  function renderAllPlaylists() {
    const el = qs('#allPlaylistsGrid');
    if (!state.playlists.length) {
      el.innerHTML = '<div class="empty-state">暂无歌单</div>';
      return;
    }
    el.innerHTML = state.playlists.map((p, idx) => `
      <div class="pl-card" data-idx="${idx}">
        <div class="pl-card-img-wrap">
          <img src="${esc(p.cover)}" alt="" loading="lazy" />
          <span class="pl-card-meta">${esc(p.meta || '精选')}</span>
        </div>
        <div class="pl-card-name">${esc(p.title)}</div>
      </div>
    `).join('');
    el.querySelectorAll('.pl-card').forEach((c) => {
      c.addEventListener('click', () => openPlaylistDetail(state.playlists[Number(c.dataset.idx)]));
    });
  }

  function renderChartTabs() {
    const el = qs('#chartTabs');
    el.innerHTML = state.charts.map((c) =>
      `<button class="chip ${String(c.id) === String(state.currentChartId) ? 'active' : ''}" data-id="${esc(c.id)}">${esc(c.title)}</button>`
    ).join('');
    el.querySelectorAll('.chip').forEach((b) => {
      b.addEventListener('click', () => loadChart(b.dataset.id));
    });
  }

  function renderTrackList(container, list, showIndex) {
    if (!list || list.length === 0) {
      container.innerHTML = '<div class="empty-state">这里暂时空空如也</div>';
      return;
    }
    const activeKey = state.currentTrack ? trackKeyOf(state.currentTrack) : '';
    container.innerHTML = list.map((t, idx) => {
      const active = trackKeyOf(t) === activeKey;
      const loved = isFav(t);
      return `
        <div class="track-item ${active ? 'active' : ''}" data-idx="${idx}">
          ${showIndex ? `<span class="track-idx ${idx < 3 ? 'top3' : ''}">${idx + 1}</span>` : ''}
          <img class="track-thumb" src="${esc(t.cover)}" alt="" loading="lazy" />
          <div class="track-info">
            <div class="track-name">${esc(t.title)}</div>
            <div class="track-sub">
              <span class="sq-tag">SQ</span>
              <span>${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</span>
            </div>
          </div>
          <div class="track-btns">
            <button class="t-btn ${loved ? 'loved' : ''}" data-act="fav" data-idx="${idx}" aria-label="喜欢">${loved ? '♥' : '♡'}</button>
            <button class="t-btn" data-act="dl" data-idx="${idx}" aria-label="下载">⬇</button>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.track-item').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.t-btn')) return;
        playFromList(list, Number(row.dataset.idx));
      });
    });

    container.querySelectorAll('.t-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = list[Number(btn.dataset.idx)];
        if (btn.dataset.act === 'fav') toggleFav(t);
        if (btn.dataset.act === 'dl') downloadTrack(t);
      });
    });
  }

  function renderMineList() {
    updateMineCounts();
    const list = state.mineTab === 'favorites' ? state.favorites : state.history;
    renderTrackList(qs('#mineTrackList'), list, false);
  }

  function updateMineCounts() {
    qs('#favCount').textContent = state.favorites.length;
    qs('#hisCount').textContent = state.history.length;
  }

  function renderQueue() {
    qs('#queueCount').textContent = state.queue.length;
    const el = qs('#queueList');
    const activeKey = state.currentTrack ? trackKeyOf(state.currentTrack) : '';
    if (!state.queue.length) {
      el.innerHTML = '<div class="empty-state">播放队列为空</div>';
      return;
    }
    el.innerHTML = state.queue.map((t, i) => `
      <div class="track-item ${trackKeyOf(t) === activeKey ? 'active' : ''}" data-qidx="${i}">
        <span class="track-idx">${i + 1}</span>
        <div class="track-info">
          <div class="track-name">${esc(t.title)}</div>
          <div class="track-sub">${esc(t.artist)}</div>
        </div>
      </div>
    `).join('');
    el.querySelectorAll('.track-item').forEach((row) => {
      row.addEventListener('click', () => {
        playQueueIndex(Number(row.dataset.qidx));
        qs('#queueBackdrop').classList.remove('open');
      });
    });
  }

  function syncFavoriteUI() {
    updateMineCounts();
    if (state.currentTrack) {
      const loved = isFav(state.currentTrack);
      qs('#immFavBtn').textContent = loved ? '♥' : '♡';
      qs('#immFavBtn').classList.toggle('loved', loved);
    }
    renderHomeNewTracks();
    if (state.view === 'mine') renderMineList();
    if (state.view === 'charts') renderTrackList(qs('#chartTrackList'), state.chartTracks, true);
    if (state.view === 'search') renderTrackList(qs('#searchTrackList'), state.searchTracks, false);
    if (state.view === 'detail') renderTrackList(qs('#detailTrackList'), state.detailTracks, true);
  }

  function syncActiveTrackHighlights() {
    renderHomeNewTracks();
    renderQueue();
    if (state.view === 'charts') renderTrackList(qs('#chartTrackList'), state.chartTracks, true);
    if (state.view === 'search') renderTrackList(qs('#searchTrackList'), state.searchTracks, false);
    if (state.view === 'detail') renderTrackList(qs('#detailTrackList'), state.detailTracks, true);
    if (state.view === 'mine') renderMineList();
  }

  /* ==================== PLAYBACK ENGINE ==================== */
  function playFromList(list, index) {
    if (!list || !list.length) return;
    state.queue = list.slice();
    playQueueIndex(index);
  }

  async function playQueueIndex(index, qualityOverride = null) {
    if (!state.queue.length) return;
    const safeIdx = ((index % state.queue.length) + state.queue.length) % state.queue.length;
    state.queueIdx = safeIdx;
    const track = state.queue[safeIdx];
    state.currentTrack = track;
    state.currentResolved = null;
    const token = ++state.playToken;

    updateTrackMetadataUI(track);
    syncActiveTrackHighlights();
    pushHistory(track);

    const pref = qualityOverride || state.prefQuality;
    qs('#immFileMeta').textContent = '正在解析无损音源…';

    try {
      const songId = track.song_id || track.id;
      const res = await apiGet('/api/parse', { id: songId, pref });
      if (token !== state.playToken) return;

      const parsed = res?.data;
      const resolved = parsed?.resolved;
      if (!resolved || !resolved.url) throw new Error('无可用音频流');

      state.currentResolved = resolved;
      renderLyrics(parsed.lyric || '', parsed.tlyric || '');

      const isFlac = resolved.format === 'flac' || resolved.br >= 600;
      const qLabel = isFlac ? 'SQ 无损 FLAC' : `HQ ${resolved.br || 320}K`;
      const sizeStr = fmtSize(resolved.size);
      qs('#dockQuality').textContent = isFlac ? 'SQ' : `${resolved.br || 320}K`;
      qs('#immQualityBtn').textContent = `${qLabel} · 切换`;
      qs('#immFileMeta').textContent = sizeStr ? `${resolved.format.toUpperCase()} · ${sizeStr}` : resolved.format.toUpperCase();

      const streamUrl = `${PROXY_BASE}/stream?url=${encodeURIComponent(resolved.url)}`;
      audio.src = streamUrl;
      audio.load();
      await audio.play();
      setPlayingUI(true);
    } catch (err) {
      if (token !== state.playToken) return;
      setPlayingUI(false);
      qs('#immFileMeta').textContent = '音源解析失败';
      showToast(`播放失败: ${err.message || '请切换下一首'}`);
    }
  }

  function updateTrackMetadataUI(track) {
    qs('#dockTitle').textContent = `${track.title} - ${track.artist}`;
    qs('#immTitle').textContent = track.title;
    qs('#immArtist').textContent = track.artist;

    const cover = track.cover || '';
    const dockImg = qs('#dockCover');
    const immImg = qs('#immCover');
    if (cover) {
      dockImg.src = cover;
      dockImg.classList.add('loaded');
      qs('#dockCoverFallback').style.display = 'none';
      immImg.src = cover;
      qs('#immBg').style.backgroundImage = `url("${cover}")`;
    } else {
      dockImg.classList.remove('loaded');
      qs('#dockCoverFallback').style.display = 'grid';
      immImg.src = '';
      qs('#immBg').style.backgroundImage = 'none';
    }

    const loved = isFav(track);
    qs('#immFavBtn').textContent = loved ? '♥' : '♡';
    qs('#immFavBtn').classList.toggle('loved', loved);
  }

  function setPlayingUI(playing) {
    state.isPlaying = playing;
    qs('#appRoot').classList.toggle('is-playing', playing);
    qs('#heroVinyl').classList.toggle('spinning', playing);
    qs('#miniVinylDisc').classList.toggle('spinning', playing);
    qs('#immVinyl').classList.toggle('spinning', playing);
    qs('#immTonearm').classList.toggle('playing', playing);

    try {
      if (window.AndroidMusic && typeof window.AndroidMusic.updateNowPlaying === 'function' && state.currentTrack) {
        window.AndroidMusic.updateNowPlaying(state.currentTrack.title, state.currentTrack.artist, playing);
      }
    } catch (_) {}
  }

  function togglePlayPause() {
    if (!state.currentTrack) {
      if (state.homeNewTracks.length > 0) {
        playFromList(state.homeNewTracks, 0);
      } else {
        showToast('曲库还在加载中，请稍候');
      }
      return;
    }
    if (audio.paused) {
      audio.play().then(() => setPlayingUI(true)).catch(() => showToast('请再点一次播放'));
    } else {
      audio.pause();
      setPlayingUI(false);
    }
  }

  function playNext(manual = true) {
    if (!state.queue.length) return;
    if (!manual && state.playMode === 'single') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    if (state.playMode === 'shuffle' && state.queue.length > 1) {
      let r = state.queueIdx;
      while (r === state.queueIdx) r = Math.floor(Math.random() * state.queue.length);
      playQueueIndex(r);
      return;
    }
    playQueueIndex(state.queueIdx + 1);
  }

  function playPrev() {
    if (!state.queue.length) return;
    playQueueIndex(state.queueIdx - 1);
  }

  /* ==================== LYRICS ==================== */
  function parseLrc(raw) {
    const out = [];
    const lines = String(raw || '').split(/\r?\n/);
    const timeRe = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
    for (const line of lines) {
      const times = [];
      let m;
      while ((m = timeRe.exec(line)) !== null) {
        const min = Number(m[1]);
        const sec = Number(m[2]);
        const ms = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
        times.push(min * 60 + sec + ms / 1000);
      }
      const text = line.replace(timeRe, '').trim();
      if (!text || !times.length) continue;
      for (const t of times) out.push({ time: t, text });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  function renderLyrics(rawLrc, rawTrans) {
    const base = parseLrc(rawLrc);
    const trans = parseLrc(rawTrans);
    const transMap = new Map();
    for (const tr of trans) transMap.set(Math.round(tr.time * 2), tr.text);

    state.lyrics = base.map((item) => ({
      time: item.time,
      text: item.text,
      trans: transMap.get(Math.round(item.time * 2)) || ''
    }));
    state.activeLrcIdx = -1;

    const listEl = qs('#immLyricsList');
    if (!state.lyrics.length) {
      listEl.innerHTML = '<p class="lrc-empty">纯音乐或暂无滚动歌词</p>';
      return;
    }
    listEl.innerHTML = state.lyrics.map((l, i) => `
      <div class="lrc-line" data-lrc-idx="${i}">
        ${esc(l.text)}
        ${l.trans ? `<span class="lrc-trans">${esc(l.trans)}</span>` : ''}
      </div>
    `).join('');

    listEl.querySelectorAll('.lrc-line').forEach((el) => {
      el.addEventListener('click', () => {
        const item = state.lyrics[Number(el.dataset.lrcIdx)];
        if (item && Number.isFinite(audio.duration)) {
          audio.currentTime = item.time;
        }
      });
    });
  }

  function syncLyricHighlight(curTime) {
    if (!state.lyrics.length) return;
    let idx = -1;
    for (let i = 0; i < state.lyrics.length; i++) {
      if (state.lyrics[i].time <= curTime + 0.15) idx = i;
      else break;
    }
    if (idx === state.activeLrcIdx) return;
    state.activeLrcIdx = idx;

    const nodes = qsa('#immLyricsList .lrc-line');
    nodes.forEach((n, i) => n.classList.toggle('active', i === idx));
    if (idx >= 0 && nodes[idx]) {
      const box = qs('#immLyricsBox');
      const targetTop = nodes[idx].offsetTop - box.clientHeight * 0.42;
      box.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    }
  }

  /* ==================== DOWNLOAD & QUALITY ==================== */
  async function downloadTrack(track) {
    const t = track || state.currentTrack;
    if (!t) {
      showToast('请先选择一首歌曲');
      return;
    }
    showToast(`正在获取《${t.title}》无损下载链接…`);
    try {
      const br = state.prefQuality === 'flac' ? 999 : Number(state.prefQuality) || 320;
      const res = await apiGet('/api/resolve', { id: t.song_id || t.id, br });
      const resolved = res?.data;
      if (!resolved || !resolved.url) throw new Error('解析失败');

      const ext = resolved.format === 'flac' ? 'flac' : 'mp3';
      const fileName = `${t.title} - ${t.artist}.${ext}`;
      if (window.AndroidMusic && typeof window.AndroidMusic.downloadAudio === 'function') {
        window.AndroidMusic.downloadAudio(resolved.url, fileName, t.title);
      } else {
        window.open(resolved.url, '_blank');
        showToast(`已触发下载：${fileName}`);
      }
    } catch (_) {
      showToast('下载链接获取失败，请稍后重试');
    }
  }

  function updateQualitySettingUI() {
    qsa('#settingQualityGroup .q-opt').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.q === state.prefQuality);
    });
  }

  function cycleCurrentQuality() {
    const order = ['flac', '320', '192', '128'];
    const next = order[(order.indexOf(state.prefQuality) + 1) % order.length];
    state.prefQuality = next;
    localStorage.setItem(STORAGE.QUALITY, next);
    updateQualitySettingUI();
    showToast(`已切换音质偏好：${next === 'flac' ? 'SQ 无损 FLAC' : next + 'K'}`);
    if (state.currentTrack && state.queueIdx >= 0) {
      playQueueIndex(state.queueIdx, next);
    }
  }

  /* ==================== AUDIO EVENTS ==================== */
  audio.addEventListener('timeupdate', () => {
    const cur = audio.currentTime || 0;
    const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
    qs('#dockTime').textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
    qs('#immCurTime').textContent = fmtTime(cur);
    qs('#immDurTime').textContent = fmtTime(dur);

    const pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;
    qs('#dockProgressFill').style.width = `${pct}%`;
    qs('#dockProgressThumb').style.left = `${pct}%`;
    if (!state.isSeeking) {
      qs('#immRange').value = Math.round(pct * 10);
    }
    syncLyricHighlight(cur);
  });

  audio.addEventListener('ended', () => playNext(false));
  audio.addEventListener('play', () => setPlayingUI(true));
  audio.addEventListener('pause', () => setPlayingUI(false));

  /* ==================== INTERACTIONS ==================== */
  // Top nav
  qs('#brandHomeBtn').addEventListener('click', () => switchView('home'));
  qsa('.top-tab').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  qs('#openSearchBtn').addEventListener('click', () => {
    switchView('search', true);
    setTimeout(() => qs('#searchInput').focus(), 100);
  });

  // Hero controls
  qs('#heroPlayBtn').addEventListener('click', togglePlayPause);
  qs('#heroPrevBtn').addEventListener('click', playPrev);
  qs('#heroNextBtn').addEventListener('click', () => playNext(true));

  // 6 Quick tiles
  qsa('.q-tile').forEach((tile) => {
    tile.addEventListener('click', () => {
      const act = tile.dataset.action;
      if (act === 'favorites') {
        state.mineTab = 'favorites';
        qsa('.seg-tab').forEach((t) => t.classList.toggle('active', t.dataset.mine === 'favorites'));
        switchView('mine');
      } else if (act === 'hot') {
        switchView('charts');
        loadChart('3778678');
      } else if (act === 'playlists') {
        switchView('playlists');
      } else if (act === 'roam') {
        if (state.homeNewTracks.length) {
          const rnd = Math.floor(Math.random() * state.homeNewTracks.length);
          playFromList(state.homeNewTracks, rnd);
          showToast('随心漫游 · 为你随机播放无损好歌');
        }
      } else if (act === 'history') {
        state.mineTab = 'history';
        qsa('.seg-tab').forEach((t) => t.classList.toggle('active', t.dataset.mine === 'history'));
        switchView('mine');
      } else if (act === 'download') {
        downloadTrack(state.currentTrack);
      }
    });
  });

  // Home links & Hot Hits card
  qs('#homeMorePlaylists').addEventListener('click', () => switchView('playlists'));
  qs('#homeMoreNew').addEventListener('click', () => {
    switchView('charts');
    loadChart('3779629');
  });
  qs('#hotHitsCard').addEventListener('click', () => {
    switchView('charts');
    loadChart('3778678');
  });

  // Search
  qs('#searchGoBtn').addEventListener('click', () => doSearch(qs('#searchInput').value));
  qs('#searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch(qs('#searchInput').value);
  });
  qs('#searchInput').addEventListener('input', () => {
    const val = qs('#searchInput').value;
    qs('#searchClearBtn').hidden = !val;
    if (!val) qs('#hotTagsWrap').style.display = 'block';
  });
  qs('#searchClearBtn').addEventListener('click', () => {
    qs('#searchInput').value = '';
    qs('#searchClearBtn').hidden = true;
    qs('#hotTagsWrap').style.display = 'block';
    qs('#searchTrackList').innerHTML = '';
  });
  qsa('.hot-tag').forEach((tag) => tag.addEventListener('click', () => doSearch(tag.dataset.q)));

  // Detail & Charts & Mine play all
  qs('#detailBackBtn').addEventListener('click', () => switchView(state.prevView || 'home'));
  qs('#detailPlayAllBtn').addEventListener('click', () => playFromList(state.detailTracks, 0));
  qs('#playAllChartBtn').addEventListener('click', () => playFromList(state.chartTracks, 0));
  qs('#minePlayAllBtn').addEventListener('click', () => {
    const list = state.mineTab === 'favorites' ? state.favorites : state.history;
    playFromList(list, 0);
  });
  qsa('.seg-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.mineTab = tab.dataset.mine;
      qsa('.seg-tab').forEach((t) => t.classList.toggle('active', t === tab));
      renderMineList();
    });
  });

  // Settings
  qsa('#settingQualityGroup .q-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.prefQuality = btn.dataset.q;
      localStorage.setItem(STORAGE.QUALITY, state.prefQuality);
      updateQualitySettingUI();
      showToast(`默认音质已设为 ${btn.textContent}`);
    });
  });
  qs('#clearHistoryBtn').addEventListener('click', () => {
    state.history = [];
    saveJSON(STORAGE.HISTORY, []);
    updateMineCounts();
    showToast('已清空最近播放记录');
  });

  // Dock controls
  qs('#dockPlayBtn').addEventListener('click', togglePlayPause);
  qs('#dockPrevBtn').addEventListener('click', playPrev);
  qs('#dockNextBtn').addEventListener('click', () => playNext(true));
  qs('#dockOpenImmersive').addEventListener('click', () => qs('#immersiveOverlay').classList.add('open'));
  qs('#dockTitleOpen').addEventListener('click', () => qs('#immersiveOverlay').classList.add('open'));
  qs('#dockQueueBtn').addEventListener('click', () => {
    renderQueue();
    qs('#queueBackdrop').classList.add('open');
  });

  qs('#dockProgressTrack').addEventListener('click', (e) => {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * audio.duration;
  });

  // Bottom nav
  qsa('.bnav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.nav));
  });
  qs('#centerVinylBtn').addEventListener('click', () => {
    qs('#immersiveOverlay').classList.toggle('open');
  });

  // Immersive controls
  qs('#immCloseBtn').addEventListener('click', () => qs('#immersiveOverlay').classList.remove('open'));
  qs('#immPlayBtn').addEventListener('click', togglePlayPause);
  qs('#immPrevBtn').addEventListener('click', playPrev);
  qs('#immNextBtn').addEventListener('click', () => playNext(true));
  qs('#immFavBtn').addEventListener('click', () => toggleFav(state.currentTrack));
  qs('#immDownloadBtn').addEventListener('click', () => downloadTrack(state.currentTrack));
  qs('#immQualityBtn').addEventListener('click', cycleCurrentQuality);

  const modeIcons = {
    loop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    single: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><path d="M12 10v5"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>'
  };
  const modeLabels = { loop: '列表循环', single: '单曲循环', shuffle: '随机播放' };
  qs('#immModeBtn').innerHTML = modeIcons[state.playMode] || modeIcons.loop;
  qs('#immModeBtn').addEventListener('click', () => {
    const modes = ['loop', 'single', 'shuffle'];
    state.playMode = modes[(modes.indexOf(state.playMode) + 1) % modes.length];
    localStorage.setItem(STORAGE.MODE, state.playMode);
    qs('#immModeBtn').innerHTML = modeIcons[state.playMode];
    showToast(`播放模式：${modeLabels[state.playMode]}`);
  });

  qs('#immRange').addEventListener('input', () => { state.isSeeking = true; });
  qs('#immRange').addEventListener('change', (e) => {
    state.isSeeking = false;
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = (Number(e.target.value) / 1000) * audio.duration;
    }
  });

  // Queue drawer
  qs('#queueCloseBtn').addEventListener('click', () => qs('#queueBackdrop').classList.remove('open'));
  qs('#queueBackdrop').addEventListener('click', (e) => {
    if (e.target === qs('#queueBackdrop')) qs('#queueBackdrop').classList.remove('open');
  });

  // Android Hardware Back Handler
  window.__handleAndroidBack = () => {
    if (qs('#queueBackdrop').classList.contains('open')) {
      qs('#queueBackdrop').classList.remove('open');
      return true;
    }
    if (qs('#immersiveOverlay').classList.contains('open')) {
      qs('#immersiveOverlay').classList.remove('open');
      return true;
    }
    if (state.view === 'detail' || state.view === 'search') {
      switchView(state.prevView || 'home');
      return true;
    }
    if (state.view !== 'home') {
      switchView('home');
      return true;
    }
    return false;
  };

  initApp();
})();
