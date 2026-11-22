(() => {
  const api = window.musicApp;
  const $ = (id) => document.getElementById(id);

  // ---------------- App State ----------------
  const state = {
    proxyBase: '',
    siteBase: 'https://dl.74520.xyz',
    engine: 'public', // 'public' (免登录默认) | 'site74520' (扩展源)
    settings: {},
    auth: {
      authenticated: false,
      user: null,
      quota: { used: 0, limit: 100, remaining: 100 }
    },
    currentView: 'home',
    previousView: 'home',
    discover: {
      loaded: false,
      source: 'all',
      category: '全部',
      categories: ['全部', '流行', '华语', '粤语', '欧美', '治愈', '电子', '说唱', '怀旧', '轻音乐'],
      charts: [],
      playlists: [],
      activeChartKey: '',
      chartTracks: [],
      homeTracks: [],
      hotTracks: []
    },
    collection: { title: '', desc: '', tag: '', cover: '', items: [] },
    favorites: [],
    favKeys: new Set(),
    history: [],
    downloads: [],
    activeDownloads: new Map(),
    localTracks: [],
    libraryTab: 'favorites',

    // Playback state
    queue: [],
    queueIndex: -1,
    currentTrack: null,
    currentParsed: null,
    currentQualities: [],
    currentQualityItem: null,
    preferredQuality: 'flac',
    playMode: 'sequence',
    isPlaying: false,
    lyrics: [],
    activeLyricIdx: -1
  };

  const audio = $('audioEngine');
  let audioCtx = null;
  let analyser = null;
  let visualizerRaf = 0;

  // ---------------- Utilities ----------------
  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  }

  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type === 'error' ? 'toast-error' : type === 'success' ? 'toast-success' : ''}`;
    el.textContent = msg;
    $('toastStack').appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 220);
    }, 2800);
  }

  function localProxyUrl(filePath) {
    return `${state.proxyBase}/local?path=${encodeURIComponent(filePath)}`;
  }

  function streamProxyUrl(url) {
    return `${state.proxyBase}/stream?url=${encodeURIComponent(url)}`;
  }

  function isUsing74520() {
    return false;
  }

  function computeTrackKey(t) {
    if (!t) return '';
    if (t.track_key) return String(t.track_key);
    if (t.isLocal && t.filePath) return `local:${t.filePath}`;
    let plat = String(t.platform || '').toLowerCase();
    if (plat === 'qq') plat = 'qqmusic';
    if (plat === '163' || plat === 'netease') plat = 'neteasemusic';
    const sid = String(t.song_id || t.id || '').trim();
    if (plat && sid) return `${plat}:${sid}`;
    return t.url ? `${plat || 'music'}:${t.url}` : '';
  }

  function classifyQuality(item) {
    const q = String((item && item.quality) || '').toLowerCase();
    const f = String((item && item.format) || '').toLowerCase();
    if (f === 'flac' || q.includes('flac') || q.includes('lossless') || q.includes('hires') || q.includes('jymaster') || f === 'wav') return 'flac';
    if (q.includes('320') || q.includes('exhigh')) return '320';
    if (q.includes('192') || q === 'higher') return '192';
    return '128';
  }

  function qualityLabel(item) {
    if (item && item.label && /kbps/i.test(item.label)) {
      const m = item.label.match(/(\d+)kbps/i);
      const tier = classifyQuality(item);
      if (tier === 'flac' && m) return `SQ 无损 ${m[1]}K`;
    }
    const tier = classifyQuality(item);
    if (tier === 'flac') return 'SQ 无损';
    if (tier === '320') return '320K HQ';
    if (tier === '192') return '192K 高品';
    return '128K 标准';
  }

  function normalizeQualities(payload) {
    const raw = Array.isArray(payload && payload.audio_qualities) ? payload.audio_qualities : [];
    const valid = raw.filter((x) => x && (x.url || x.lazy));
    if (valid.length) return valid;
    if (payload && payload.audio_url) {
      const u = payload.audio_url;
      const ext = (payload.format || (u.includes('.flac') ? 'flac' : 'mp3')).toLowerCase();
      return [{ quality: payload.quality || ext, label: ext === 'flac' ? '无损 FLAC' : ext.toUpperCase(), format: ext, url: u, download_token: payload.audio_download_token || '' }];
    }
    return [];
  }

  function pickPreferredQuality(qualities, pref) {
    if (!qualities.length) return null;
    // Prefer already-resolved matching tier first
    const order = pref === 'flac' ? ['flac', '320', '192', '128']
      : pref === '320' ? ['320', 'flac', '192', '128']
      : pref === '192' ? ['192', '320', '128', 'flac']
      : ['128', '192', '320', 'flac'];
    for (const tier of order) {
      const ready = qualities.find((q) => classifyQuality(q) === tier && q.url && !q.lazy);
      if (ready) return ready;
    }
    for (const tier of order) {
      const hit = qualities.find((q) => classifyQuality(q) === tier);
      if (hit) return hit;
    }
    return qualities[0];
  }

  function deterministicWaveHeights(seedStr) {
    let h = 2166136261;
    const s = String(seedStr || 'music');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const bars = [];
    for (let i = 0; i < 24; i++) {
      h ^= h << 13;
      h ^= h >>> 17;
      h ^= h << 5;
      bars.push(24 + (Math.abs(h) % 72));
    }
    return bars;
  }

  // ---------------- Lyrics Parser ----------------
  function parseTimedLines(raw) {
    if (!raw) return [];
    const out = [];
    const lines = String(raw).split(/\r?\n/);
    const re = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
    for (const line of lines) {
      const times = [];
      let m;
      while ((m = re.exec(line)) !== null) {
        const min = parseInt(m[1], 10);
        const sec = parseInt(m[2], 10);
        const ms = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) : 0;
        times.push(min * 60 + sec + ms / 1000);
      }
      const text = line.replace(re, '').trim();
      if (!text || text === '//') continue;
      for (const t of times) out.push({ time: t, text });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  function parseLyrics(lrc, tlrc) {
    const main = parseTimedLines(lrc);
    const trans = parseTimedLines(tlrc);
    const merged = [];
    for (const item of main) {
      const prev = merged[merged.length - 1];
      if (prev && Math.abs(prev.time - item.time) < 0.06) {
        if (!prev.text.includes(item.text)) prev.text += ' ' + item.text;
      } else {
        merged.push({ time: item.time, text: item.text, trans: '' });
      }
    }
    if (trans.length && merged.length) {
      for (const line of merged) {
        let best = null, diff = 0.45;
        for (const t of trans) {
          const d = Math.abs(t.time - line.time);
          if (d < diff) { diff = d; best = t; }
        }
        if (best) line.trans = best.text;
      }
    }
    return merged;
  }

  // ---------------- Navigation ----------------
  function switchView(viewName) {
    if (viewName !== 'collection') state.previousView = viewName;
    state.currentView = viewName;

    document.querySelectorAll('.view-section').forEach((s) => {
      s.classList.toggle('active', s.id === `view-${viewName}`);
    });
    document.querySelectorAll('.nav-pill').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === viewName);
    });
    $('mainScroll').scrollTop = 0;

    if (viewName === 'playlists' && !state.discover.loaded) {
      loadDiscoverHome();
    } else if (viewName === 'charts') {
      ensureChartsLoaded();
    } else if (viewName === 'library') {
      renderLibraryView();
    } else if (viewName === 'local') {
      renderLocalTracks();
    }
  }

  // ---------------- Local Persistent Library ----------------
  function updateEnginePillUI() {}

  // ---------------- Library Sync (Local Persistent for Public / Cloud for 74520) ----------------
  function loadLocalSavedLibrary() {
    state.favorites = Array.isArray(state.settings.localFavorites) ? state.settings.localFavorites : [];
    state.favKeys = new Set(state.favorites.map((t) => computeTrackKey(t)));
    state.history = Array.isArray(state.settings.localHistory) ? state.settings.localHistory : [];
    $('favCountBadge').textContent = String(state.favorites.length);
    if (state.currentView === 'library') renderLibraryView();
    updateDockLikeState();
  }

  async function loadUserLibrary() {
    if (!isUsing74520()) {
      loadLocalSavedLibrary();
      return;
    }
    const [favR, histR, qR] = await Promise.all([
      api.apiRequest({ path: '/api/user/favorites' }),
      api.apiRequest({ path: '/api/user/play-history' }),
      api.apiRequest({ path: '/api/user/quota' })
    ]);
    if (favR.ok && favR.data && favR.data.data) {
      const items = favR.data.data.items || favR.data.data || [];
      state.favorites = Array.isArray(items) ? items : [];
      state.favKeys = new Set(state.favorites.map((t) => computeTrackKey(t)));
    }
    if (histR.ok && histR.data && histR.data.data) {
      const items = histR.data.data.items || histR.data.data || [];
      state.history = Array.isArray(items) ? items : [];
    }
    if (qR.ok && qR.data && qR.data.data) {
      state.auth.quota = qR.data.data;
      updateEnginePillUI();
    }
    $('favCountBadge').textContent = String(state.favorites.length);
    if (state.currentView === 'library') renderLibraryView();
    updateDockLikeState();
  }

  // ---------------- Discover / Playlists / Charts / Search ----------------
  async function loadDiscoverHome() {
    if (isUsing74520()) {
      const params = new URLSearchParams({
        source: state.discover.source,
        category: state.discover.category,
        limit: '15'
      });
      const res = await api.apiRequest({ path: `/api/music/discover/home?${params.toString()}` });
      if (res.ok && res.data && res.data.data) {
        const d = res.data.data;
        state.discover.loaded = true;
        state.discover.charts = Array.isArray(d.charts) ? d.charts : [];
        state.discover.playlists = Array.isArray(d.playlists) ? d.playlists : [];
        if (Array.isArray(d.categories) && d.categories.length) state.discover.categories = d.categories;
        renderHomePlaylists();
        renderAllPlaylistsView();
        if (state.discover.charts.length) {
          const c = state.discover.charts[0];
          state.discover.activeChartKey = state.discover.activeChartKey || c.key;
          loadHomeChartTracks(c);
        }
        return;
      }
    }

    // Default: Public No-Login Lossless Engine
    const res = await api.publicDiscover({ category: state.discover.category, limit: 15 });
    if (!res.ok || !res.data) {
      $('homePlaylistsGrid').innerHTML = '<div class="empty-card">网络波动，请稍后刷新或直接搜索你想听的歌曲</div>';
      return;
    }
    const d = res.data;
    state.discover.loaded = true;
    state.discover.charts = d.charts || [];
    state.discover.playlists = d.playlists || [];
    if (Array.isArray(d.categories) && d.categories.length) state.discover.categories = d.categories;
    renderHomePlaylists();
    renderAllPlaylistsView();

    // Load 新歌榜 for left list & 热歌榜 for right Hot Hits card in parallel
    const newChart = state.discover.charts[0];
    const hotChart = state.discover.charts[1] || state.discover.charts[0];
    if (newChart) {
      state.discover.activeChartKey = state.discover.activeChartKey || newChart.key;
      loadHomeChartTracks(newChart);
    }
    if (hotChart && hotChart !== newChart) {
      api.publicPlaylist({ id: hotChart.id, limit: 15 }).then((r) => {
        if (r.ok && Array.isArray(r.data) && r.data.length) {
          state.discover.hotTracks = r.data;
          renderHotHitsList(r.data.slice(0, 5), hotChart.title || '官方热歌榜');
        }
      }).catch(() => {});
    }
  }

  async function loadHomeChartTracks(chart) {
    if (!chart || !chart.key) return;
    let items = [];
    if (isUsing74520()) {
      const res = await api.apiRequest({ path: `/api/music/discover/chart/${encodeURIComponent(chart.key)}?limit=24` });
      if (res.ok && res.data && res.data.data) items = res.data.data.items || [];
    } else {
      const res = await api.publicPlaylist({ id: chart.id || chart.key, limit: 30 });
      if (res.ok && Array.isArray(res.data)) items = res.data;
    }
    if (!items.length) return;
    state.discover.homeTracks = items;
    $('homeTracksHeading').textContent = chart.title || '新歌推荐';
    renderTrackList($('homeTracksList'), items.slice(0, 10));
    if (!state.discover.hotTracks.length) {
      renderHotHitsList(items.slice(0, 5), chart.title || '热歌风向标');
    }
  }

  function renderHomePlaylists() {
    const grid = $('homePlaylistsGrid');
    const list = state.discover.playlists.slice(0, 5);
    if (!list.length) {
      grid.innerHTML = '<div class="empty-card">暂无推荐歌单</div>';
      return;
    }
    grid.innerHTML = list.map((p, idx) => `
      <div class="pl-card" data-pl-idx="${idx}">
        <div class="pl-cover-box">
          ${p.cover ? `<img src="${esc(p.cover)}" loading="lazy" alt="" />` : ''}
          <div class="pl-play-dot">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </div>
        <div class="pl-title">${esc(p.title || '精选歌单')}</div>
        <div class="pl-meta">${esc(p.platform_label || p.platform || '官方歌单')}</div>
      </div>
    `).join('');

    grid.querySelectorAll('.pl-card').forEach((el) => {
      el.onclick = () => {
        const pl = list[Number(el.dataset.plIdx)];
        if (pl) openCuratedPlaylist(pl);
      };
    });
  }

  function renderAllPlaylistsView() {
    const catBar = $('playlistCategories');
    catBar.innerHTML = state.discover.categories.map((cat) => `
      <button class="f-pill ${cat === state.discover.category ? 'active' : ''}" data-cat="${esc(cat)}">${esc(cat)}</button>
    `).join('');
    catBar.querySelectorAll('.f-pill').forEach((b) => {
      b.onclick = () => {
        state.discover.category = b.dataset.cat;
        loadDiscoverHome();
      };
    });

    const grid = $('allPlaylistsGrid');
    const list = state.discover.playlists;
    if (!list.length) {
      grid.innerHTML = '<div class="empty-card">正在加载精选歌单...</div>';
      return;
    }
    grid.innerHTML = list.map((p, idx) => `
      <div class="pl-card" data-allpl-idx="${idx}">
        <div class="pl-cover-box">
          ${p.cover ? `<img src="${esc(p.cover)}" loading="lazy" alt="" />` : ''}
          <div class="pl-play-dot">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </div>
        <div class="pl-title">${esc(p.title)}</div>
        <div class="pl-meta">${esc(p.platform_label || p.platform || '')}</div>
      </div>
    `).join('');

    grid.querySelectorAll('.pl-card').forEach((el) => {
      el.onclick = () => {
        const pl = list[Number(el.dataset.allplIdx)];
        if (pl) openCuratedPlaylist(pl);
      };
    });
  }

  function renderHotHitsList(tracks, subtitle) {
    $('hotHitsSubtitle').textContent = subtitle || '全网高热度无损单曲';
    const ul = $('hotHitsList');
    if (!tracks.length) {
      ul.innerHTML = '<li class="hh-empty">暂无曲目</li>';
      return;
    }
    ul.innerHTML = tracks.map((t, idx) => `
      <li class="hh-item" data-hh-idx="${idx}">
        <span class="hh-rank">${idx + 1}</span>
        <div class="hh-track-meta">
          <strong>${esc(t.title)}</strong>
          <span>${esc(t.artist || t.author || '')}</span>
        </div>
      </li>
    `).join('');
    ul.querySelectorAll('.hh-item').forEach((el) => {
      el.onclick = () => {
        const idx = Number(el.dataset.hhIdx);
        if (tracks[idx]) playFromList(tracks, idx);
      };
    });
  }

  async function openCuratedPlaylist(pl) {
    showCollection(pl.title || '加载中...', '正在拉取歌单无损曲目...', pl.platform_label || '精选歌单', pl.cover || '', []);
    const pid = pl.playlist_id || pl.id || '';

    if (isUsing74520() && pl.engine !== 'public') {
      const plat = pl.platform || 'neteasemusic';
      const res = await api.apiRequest({
        path: `/api/music/discover/playlist?platform=${encodeURIComponent(plat)}&playlist_id=${encodeURIComponent(pid)}&limit=100`
      });
      if (!res.ok || !res.data || !res.data.data) {
        toast((res.data && res.data.detail) || '歌单加载失败', 'error');
        return;
      }
      const d = res.data.data;
      showCollection(d.title || pl.title, `共 ${(d.items || []).length} 首无损曲目`, pl.platform_label || '官方歌单', d.cover || pl.cover || '', d.items || []);
      return;
    }

    const res = await api.publicPlaylist({ id: pid, limit: 80 });
    if (!res.ok || !Array.isArray(res.data)) {
      toast(res.error || '歌单加载失败', 'error');
      return;
    }
    showCollection(pl.title || '精选歌单', `共 ${res.data.length} 首曲目 · 默认优先 SQ 无损 FLAC`, pl.platform_label || '免登无损歌单', pl.cover || '', res.data);
  }

  async function ensureChartsLoaded() {
    if (!state.discover.loaded) await loadDiscoverHome();
    const charts = state.discover.charts;
    const bar = $('chartTabsBar');
    if (!charts.length) {
      bar.innerHTML = '';
      $('chartTracksList').innerHTML = '<div class="empty-card">暂无可用榜单</div>';
      return;
    }
    if (!state.discover.activeChartKey) state.discover.activeChartKey = charts[0].key;
    bar.innerHTML = charts.map((c) => `
      <button class="f-pill ${c.key === state.discover.activeChartKey ? 'active' : ''}" data-chart-key="${esc(c.key)}">${esc(c.title)}</button>
    `).join('');
    bar.querySelectorAll('.f-pill').forEach((b) => {
      b.onclick = () => {
        state.discover.activeChartKey = b.dataset.chartKey;
        ensureChartsLoaded();
      };
    });

    $('chartTracksList').innerHTML = '<div class="empty-card">正在拉取官方榜单曲目...</div>';
    if (isUsing74520()) {
      const res = await api.apiRequest({ path: `/api/music/discover/chart/${encodeURIComponent(state.discover.activeChartKey)}?limit=60` });
      if (res.ok && res.data && res.data.data) {
        state.discover.chartTracks = res.data.data.items || [];
        renderTrackList($('chartTracksList'), state.discover.chartTracks);
        return;
      }
    }

    const res = await api.publicPlaylist({ id: state.discover.activeChartKey, limit: 60 });
    if (!res.ok || !Array.isArray(res.data)) {
      $('chartTracksList').innerHTML = '<div class="empty-card">榜单拉取失败，请稍后重试</div>';
      return;
    }
    state.discover.chartTracks = res.data;
    renderTrackList($('chartTracksList'), state.discover.chartTracks);
  }

  async function runSearch(raw) {
    const q = String(raw || '').trim();
    if (!q) return;

    // Detect pasted playlist URL
    if (/^https?:\/\//i.test(q) && /playlist|toplist|album|music\.163|y\.qq\.com|kugou/i.test(q)) {
      const m163 = q.match(/id=(\d+)/);
      if (!isUsing74520() && m163) {
        showCollection('正在解析网易云歌单...', q, '免登歌单解析', '', []);
        const r = await api.publicPlaylist({ id: m163[1], limit: 80 });
        if (!r.ok || !Array.isArray(r.data)) {
          toast(r.error || '歌单解析失败', 'error');
          return;
        }
        showCollection(`导入歌单 #${m163[1]}`, `共 ${r.data.length} 首无损曲目`, '免登歌单', r.data[0]?.cover || '', r.data);
        return;
      }
      if (isUsing74520()) {
        showCollection('正在解析歌单链接...', q, '歌单解析', '', []);
        const res = await api.apiRequest({ path: `/api/music/playlist?url=${encodeURIComponent(q)}` });
        if (!res.ok || !res.data || !res.data.data) {
          toast((res.data && res.data.detail) || '歌单解析失败', 'error');
          return;
        }
        const d = res.data.data;
        showCollection(d.title || '解析歌单', `共 ${(d.items || []).length} 首歌曲`, '歌单导入', d.cover || '', d.items || []);
        return;
      }
      toast('QQ/酷狗歌单链接需在右上角切到 74520 扩展源，网易云歌单可直接免登解析', 'info');
      return;
    }

    // Default: Public No-Login Lossless Search
    showCollection(`搜索：${q}`, '正在检索无损曲库...', 'SQ 无损曲库', '', []);
    const res = await api.publicSearch({ query: q, count: 25 });
    if (!res.ok || !Array.isArray(res.data)) {
      toast(res.error || '搜索失败，请重试', 'error');
      return;
    }
    const items = res.data;
    showCollection(`“${q}” 的搜索结果`, `共找到 ${items.length} 首歌曲 · 优先 SQ 无损 FLAC`, 'SQ 无损曲库', items[0]?.cover || '', items);
  }

  function showCollection(title, desc, tag, cover, items) {
    state.collection = { title, desc, tag, cover, items: items || [] };
    $('collectionTag').textContent = tag || '歌单';
    $('collectionTitle').textContent = title || '歌曲列表';
    $('collectionDesc').textContent = desc || '';
    const img = $('collectionCover');
    if (cover) {
      img.src = cover;
      img.classList.remove('hidden');
    } else {
      img.classList.add('hidden');
    }
    renderTrackList($('collectionTracksList'), state.collection.items);
    switchView('collection');
  }

  // ---------------- Track List Renderer (Waveform Style) ----------------
  function renderTrackList(container, items, opts = {}) {
    if (!container) return;
    if (!items || !items.length) {
      container.innerHTML = `<div class="empty-card">${esc(opts.emptyText || '暂无歌曲')}</div>`;
      return;
    }

    const curKey = computeTrackKey(state.currentTrack);
    container.innerHTML = items.map((t, idx) => {
      const key = computeTrackKey(t);
      const isPlayingRow = Boolean(curKey && key === curKey);
      const isLiked = state.favKeys.has(key);
      const bars = deterministicWaveHeights(key || t.title || idx);
      const platMap = { qqmusic: 'QQ', neteasemusic: '网易云', netease: 'SQ 无损', kugou: '酷狗', local: '本地' };
      const platLabel = platMap[String(t.platform || '').toLowerCase()] || (t.format ? t.format.toUpperCase() : 'SQ 无损');
      const dur = t.duration_text || (t.duration ? formatTime(t.duration > 1000 ? t.duration / 1000 : t.duration) : (t.size ? formatSize(t.size) : 'FLAC'));

      return `
        <div class="track-row ${isPlayingRow ? 'is-playing' : ''}" data-idx="${idx}" data-track-key="${esc(key)}">
          <div class="tr-cover">
            ${t.cover ? `<img src="${esc(t.cover)}" loading="lazy" alt="" onerror="this.style.display='none'" />` : `<span class="tr-cover-note">${esc((t.format || 'SQ').slice(0, 4))}</span>`}
          </div>
          <div class="tr-main">
            <div class="tr-title-line">
              <span class="tr-title">${esc(t.title || '未命名歌曲')}</span>
              <span class="tr-tag ${t.isLocal || t.engine === 'public' || /flac|wav/i.test(t.format || '') ? 'tag-sq' : ''}">${esc(platLabel)}</span>
            </div>
            <div class="tr-artist">${esc(t.artist || t.author || '未知歌手')}${t.album ? ' · ' + esc(t.album) : ''}</div>
          </div>
          <div class="tr-wave" aria-hidden="true">
            <div class="tr-eq"><i></i><i></i><i></i></div>
            ${bars.map((h) => `<span style="height:${h}%"></span>`).join('')}
          </div>
          <div class="tr-dur">${esc(dur)}</div>
          <div class="tr-actions">
            ${t.isLocal || t.filePath ? `
              <button class="row-icon-btn btn-folder" title="打开文件所在位置">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
              </button>
              ${opts.removableLocal ? `
                <button class="row-icon-btn btn-remove-local" title="从列表移除">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>` : ''}
            ` : `
              <button class="row-icon-btn btn-like ${isLiked ? 'liked' : ''}" title="${isLiked ? '取消喜欢' : '喜欢'}">
                <svg viewBox="0 0 24 24" fill="${isLiked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 20.5s-7-4.5-9-8.5A5.4 5.4 0 0 1 12 6.5 5.4 5.4 0 0 1 21 12c-2 4-9 8.5-9 8.5z"/></svg>
              </button>
              <button class="row-icon-btn btn-dl" title="无损下载到本地">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 4v11m0 0l-4-4m4 4l4-4M4 19h16"/></svg>
              </button>
            `}
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.track-row').forEach((row) => {
      const idx = Number(row.dataset.idx);
      const track = items[idx];

      row.onclick = (e) => {
        if (e.target.closest('button')) return;
        playFromList(items, idx);
      };

      const likeBtn = row.querySelector('.btn-like');
      if (likeBtn) {
        likeBtn.onclick = (e) => {
          e.stopPropagation();
          toggleFavorite(track);
        };
      }

      const dlBtn = row.querySelector('.btn-dl');
      if (dlBtn) {
        dlBtn.onclick = (e) => {
          e.stopPropagation();
          openDownloadPicker(track);
        };
      }

      const folderBtn = row.querySelector('.btn-folder');
      if (folderBtn) {
        folderBtn.onclick = (e) => {
          e.stopPropagation();
          api.showInFolder(track.filePath);
        };
      }

      const rmBtn = row.querySelector('.btn-remove-local');
      if (rmBtn) {
        rmBtn.onclick = async (e) => {
          e.stopPropagation();
          state.localTracks = await api.removeLocalTrack(track.filePath);
          renderLocalTracks();
        };
      }
    });
  }

  function highlightActiveRows() {
    const curKey = computeTrackKey(state.currentTrack);
    document.querySelectorAll('.track-row').forEach((r) => {
      r.classList.toggle('is-playing', Boolean(curKey && r.dataset.trackKey === curKey));
    });
  }

  // ---------------- Core Lossless Audio Playback ----------------
  async function playFromList(list, index) {
    const valid = Array.isArray(list) ? list.filter(Boolean) : [];
    if (!valid.length) return;
    state.queue = valid.map((x) => ({ ...x }));
    state.queueIndex = Math.max(0, Math.min(state.queue.length - 1, index));
    updateQueueUI();
    await loadAndPlayTrack(state.queue[state.queueIndex]);
  }

  async function resolveQualityItem(chosen, payload, forPlay) {
    if (!chosen) return null;
    if (chosen.url && !chosen.lazy && (forPlay || chosen.engine === 'public' || chosen.download_token)) return chosen;

    if (chosen.engine === 'public' || (payload && payload.engine === 'public')) {
      const res = await api.publicResolve({ songId: chosen.song_id, br: chosen.br || 999 });
      if (!res.ok || !res.data || !res.data.url) {
        throw new Error((res && res.error) || '所选音质暂不可用，请尝试其他音质');
      }
      const r = res.data;
      chosen.url = r.url;
      chosen.format = r.format || chosen.format;
      chosen.lazy = false;
      if (r.br > 0) chosen.label = `${chosen.format === 'flac' ? 'SQ 无损 FLAC' : chosen.br + 'K'} · ${r.br}kbps`;
      return chosen;
    }

    // 74520 extended engine resolve
    const res = await api.apiRequest({
      path: '/api/music/resolve',
      method: 'POST',
      body: {
        platform: chosen.platform || (payload && payload.platform) || '',
        song_id: chosen.song_id || '',
        media_mid: chosen.media_mid || '',
        quality: chosen.quality || '',
        format: chosen.format || 'flac',
        title: (payload && payload.title) || 'audio',
        author: (payload && (payload.author || payload.artist)) || '',
        for_play: Boolean(forPlay)
      }
    });
    if (!res.ok || !res.data || !res.data.data) {
      throw new Error((res.data && (res.data.detail || res.data.msg)) || '音质链接解析失败');
    }
    const r = res.data.data;
    chosen.url = r.url || chosen.url || '';
    chosen.format = r.format || chosen.format;
    chosen.download_token = r.download_token || chosen.download_token || '';
    chosen.lazy = false;
    if (r.quota) {
      state.auth.quota = r.quota;
      updateEnginePillUI();
    }
    return chosen;
  }

  function buildPlayableStreamUrl(chosen) {
    if (chosen.download_token) {
      return streamProxyUrl(`/api/download?token=${encodeURIComponent(chosen.download_token)}&inline=true`);
    }
    let raw = chosen.url || '';
    if (raw.includes('isure.stream.qqmusic.qq.com')) {
      raw = raw.replace('isure.stream.qqmusic.qq.com', 'ws.stream.qqmusic.qq.com');
    }
    return streamProxyUrl(raw);
  }

  async function parseOnlineTrack(track) {
    if (track.engine === 'public' || !isUsing74520()) {
      const res = await api.publicParse({ track, preferredQuality: state.preferredQuality });
      if (!res.ok || !res.data) throw new Error(res.error || '无损音频解析失败');
      return res.data;
    }
    const res = await api.apiRequest({
      path: '/api/parse',
      method: 'POST',
      body: { text: track.url }
    });
    if (!res.ok || !res.data) {
      throw new Error((res.data && (res.data.detail || res.data.msg)) || '歌曲解析失败');
    }
    return res.data.data || res.data;
  }

  async function loadAndPlayTrack(track, preserveTime = 0) {
    if (!track) return;
    state.currentTrack = track;
    state.currentParsed = null;
    state.currentQualities = [];
    state.currentQualityItem = null;
    state.lyrics = [];
    state.activeLyricIdx = -1;

    updateTrackVisuals(track, '解析无损...');
    highlightActiveRows();
    updateQueueUI();

    // Case 1: Local or Downloaded File
    if (track.filePath) {
      const ext = (track.format || 'FLAC').toUpperCase();
      updateTrackVisuals(track, ext === 'FLAC' || ext === 'WAV' ? `本地 ${ext}` : ext);
      renderLyricsView();
      audio.src = localProxyUrl(track.filePath);
      audio.currentTime = preserveTime || 0;
      try {
        await audio.play();
        ensureAudioVisualizer();
      } catch (err) {
        toast('本地文件播放失败：' + err.message, 'error');
      }
      return;
    }

    // Case 2: Online Lossless Track (Public No-Login or 74520 Extended)
    try {
      const payload = await parseOnlineTrack(track);
      state.currentParsed = payload;

      if (payload.cover && !track.cover) track.cover = payload.cover;
      if (payload.title && !track.title) track.title = payload.title;
      if (payload.author && !track.artist) track.artist = payload.author;

      state.lyrics = parseLyrics(payload.lyric || '', payload.tlyric || '');
      renderLyricsView();

      const qualities = normalizeQualities(payload);
      state.currentQualities = qualities;
      if (!qualities.length) throw new Error('该歌曲暂无可用音源');

      let chosen = pickPreferredQuality(qualities, state.preferredQuality);
      try {
        chosen = await resolveQualityItem(chosen, payload, true);
      } catch {
        const alt = qualities.find((q) => q !== chosen && q.url);
        if (alt) chosen = alt;
        else throw new Error('所有音质解析失败');
      }

      state.currentQualityItem = chosen;
      updateTrackVisuals(track, qualityLabel(chosen));

      audio.src = buildPlayableStreamUrl(chosen);
      if (preserveTime > 0) {
        audio.addEventListener('loadedmetadata', () => {
          audio.currentTime = Math.min(preserveTime, audio.duration || preserveTime);
        }, { once: true });
      }
      await audio.play();
      ensureAudioVisualizer();
      recordPlayHistory(track);
    } catch (err) {
      updateTrackVisuals(track, '播放失败');
      toast(err.message || '播放失败', 'error');
    }
  }

  async function recordPlayHistory(track) {
    if (!track || track.filePath) return;
    if (isUsing74520()) {
      try {
        await api.apiRequest({
          path: '/api/user/play-history',
          method: 'POST',
          body: {
            track_key: computeTrackKey(track),
            title: track.title || '',
            artist: track.artist || track.author || '',
            album: track.album || '',
            platform: track.platform || 'music',
            song_id: track.song_id || track.id || '',
            url: track.url || '',
            cover: track.cover || ''
          }
        });
      } catch {}
    } else {
      const key = computeTrackKey(track);
      const clean = { ...track, track_key: key };
      state.history = [clean, ...state.history.filter((x) => computeTrackKey(x) !== key)].slice(0, 100);
      state.settings.localHistory = state.history;
      api.saveSettings({ localHistory: state.history });
    }
  }

  function updateTrackVisuals(track, badgeText) {
    const title = track.title || '未命名歌曲';
    const artist = track.artist || track.author || '未知歌手';
    const cover = track.cover || '';

    $('dockTitle').textContent = title;
    $('dockArtist').textContent = artist;
    $('qualitySwitchBtn').textContent = badgeText || 'SQ 无损';
    $('immTitle').textContent = title;
    $('immArtist').textContent = artist;
    $('immQualityTag').textContent = badgeText || 'SQ 无损';

    const setImg = (imgEl, fbEl) => {
      if (cover) {
        imgEl.src = cover;
        imgEl.classList.remove('hidden');
        fbEl.classList.add('hidden');
      } else {
        imgEl.classList.add('hidden');
        fbEl.classList.remove('hidden');
      }
    };

    setImg($('dockCover'), $('dockCoverFallback'));
    setImg($('heroVinylCover'), $('heroVinylFallback'));
    setImg($('immCover'), $('immCoverFallback'));

    $('immBackdrop').style.backgroundImage = cover ? `url("${cover}")` : '';
    updateDockLikeState();
  }

  function syncPlayButtons() {
    const playing = !audio.paused && !audio.ended;
    state.isPlaying = playing;
    document.querySelectorAll('.icon-play').forEach((el) => el.classList.toggle('hidden', playing));
    document.querySelectorAll('.icon-pause').forEach((el) => el.classList.toggle('hidden', !playing));
    $('heroVinylDisc').classList.toggle('spinning', playing);
    $('immVinyl').classList.toggle('spinning', playing);
    $('immTonearm').classList.toggle('playing', playing);
  }

  function stepTrack(delta) {
    if (!state.queue.length) return;
    let nextIdx = state.queueIndex;
    if (state.playMode === 'shuffle' && state.queue.length > 1) {
      do {
        nextIdx = Math.floor(Math.random() * state.queue.length);
      } while (nextIdx === state.queueIndex);
    } else {
      nextIdx = (state.queueIndex + delta + state.queue.length) % state.queue.length;
    }
    state.queueIndex = nextIdx;
    loadAndPlayTrack(state.queue[nextIdx]);
  }

  // ---------------- Favorites (Local Persistent by Default / Cloud in 74520) ----------------
  async function toggleFavorite(track) {
    if (!track || track.filePath) {
      toast('本地文件无需收藏', 'info');
      return;
    }
    const key = computeTrackKey(track);

    if (isUsing74520()) {
      const res = await api.apiRequest({
        path: '/api/user/favorites/toggle',
        method: 'POST',
        body: {
          track_key: key,
          title: track.title || '未命名',
          artist: track.artist || track.author || '',
          album: track.album || '',
          platform: track.platform || 'music',
          song_id: track.song_id || track.id || '',
          url: track.url || '',
          cover: track.cover || ''
        }
      });
      if (!res.ok || !res.data || !res.data.data) {
        toast((res.data && res.data.detail) || '收藏操作失败', 'error');
        return;
      }
      const d = res.data.data;
      if (d.liked) {
        state.favKeys.add(d.track_key || key);
        state.favorites = [d.track || track, ...state.favorites.filter((x) => computeTrackKey(x) !== (d.track_key || key))];
        toast(`已添加到「我喜欢」：${track.title}`, 'success');
      } else {
        state.favKeys.delete(d.track_key || key);
        state.favorites = state.favorites.filter((x) => computeTrackKey(x) !== (d.track_key || key));
        toast(`已取消喜欢：${track.title}`, 'info');
      }
    } else {
      if (state.favKeys.has(key)) {
        state.favKeys.delete(key);
        state.favorites = state.favorites.filter((x) => computeTrackKey(x) !== key);
        toast(`已取消喜欢：${track.title}`, 'info');
      } else {
        state.favKeys.add(key);
        state.favorites = [{ ...track, track_key: key }, ...state.favorites.filter((x) => computeTrackKey(x) !== key)];
        toast(`已添加到「我喜欢」：${track.title}`, 'success');
      }
      state.settings.localFavorites = state.favorites;
      api.saveSettings({ localFavorites: state.favorites });
    }

    $('favCountBadge').textContent = String(state.favorites.length);
    updateDockLikeState();
    document.querySelectorAll('.track-row').forEach((row) => {
      const btn = row.querySelector('.btn-like');
      if (!btn) return;
      const liked = state.favKeys.has(row.dataset.trackKey);
      btn.classList.toggle('liked', liked);
      const svg = btn.querySelector('svg');
      if (svg) svg.setAttribute('fill', liked ? 'currentColor' : 'none');
    });
    if (state.currentView === 'library' && state.libraryTab === 'favorites') {
      renderLibraryView();
    }
  }

  function updateDockLikeState() {
    const key = computeTrackKey(state.currentTrack);
    const liked = Boolean(key && state.favKeys.has(key));
    const btn = $('dockLikeBtn');
    btn.classList.toggle('liked', liked);
    const svg = btn.querySelector('svg');
    if (svg) svg.setAttribute('fill', liked ? 'currentColor' : 'none');
  }

  // ---------------- Quality Switch & Lossless Download ----------------
  function openPlayQualityModal() {
    if (!state.currentQualities.length) {
      toast('当前曲目暂无可切换的在线音质', 'info');
      return;
    }
    $('qualityModalTitle').textContent = '切换播放音质';
    $('qualityModalSub').textContent = `${state.currentTrack?.title || ''} · 切换后自动保留播放进度`;
    const box = $('qualityOptions');
    box.innerHTML = state.currentQualities.map((q, idx) => `
      <button class="q-opt-btn" data-q-idx="${idx}">
        <div class="q-opt-left">
          <strong>${esc(q.label || qualityLabel(q))} (${esc((q.format || '').toUpperCase())})</strong>
          <span>${esc(q.size || q.bitrate || '在线无损流')}</span>
        </div>
        <span class="tr-tag ${classifyQuality(q) === 'flac' ? 'tag-sq' : ''}">${classifyQuality(q) === 'flac' ? 'SQ 无损' : qualityLabel(q)}</span>
      </button>
    `).join('');

    box.querySelectorAll('.q-opt-btn').forEach((btn) => {
      btn.onclick = async () => {
        const chosen = state.currentQualities[Number(btn.dataset.qIdx)];
        $('qualityModal').classList.add('hidden');
        if (!chosen) return;
        const curT = audio.currentTime || 0;
        state.preferredQuality = classifyQuality(chosen);
        api.saveSettings({ preferredQuality: state.preferredQuality });
        try {
          const resolved = await resolveQualityItem(chosen, state.currentParsed, true);
          state.currentQualityItem = resolved;
          updateTrackVisuals(state.currentTrack, qualityLabel(resolved));
          audio.src = buildPlayableStreamUrl(resolved);
          audio.addEventListener('loadedmetadata', () => {
            audio.currentTime = Math.min(curT, audio.duration || curT);
          }, { once: true });
          await audio.play();
          toast(`已切换至 ${qualityLabel(resolved)}`, 'success');
        } catch (err) {
          toast(err.message || '切换音质失败', 'error');
        }
      };
    });
    $('qualityModal').classList.remove('hidden');
  }

  async function openDownloadPicker(track) {
    if (!track || track.filePath) return;
    toast(`正在获取「${track.title}」的无损音质列表...`, 'info');
    try {
      const payload = await parseOnlineTrack(track);
      const qualities = normalizeQualities(payload);
      if (!qualities.length) throw new Error('暂无可下载音质');

      $('qualityModalTitle').textContent = '选择无损下载音质';
      $('qualityModalSub').textContent = `${payload.title || track.title} - ${payload.author || track.artist || ''} · 保存到：${state.settings.downloadDir || ''}`;
      const box = $('qualityOptions');
      box.innerHTML = qualities.map((q, idx) => `
        <button class="q-opt-btn" data-dl-idx="${idx}">
          <div class="q-opt-left">
            <strong>${esc(q.label || qualityLabel(q))} (${esc((q.format || 'flac').toUpperCase())})</strong>
            <span>${esc(q.size || '高速无损下载')}</span>
          </div>
          <span class="btn-pink btn-sm">下载</span>
        </button>
      `).join('');

      box.querySelectorAll('.q-opt-btn').forEach((btn) => {
        btn.onclick = async () => {
          const chosen = qualities[Number(btn.dataset.dlIdx)];
          $('qualityModal').classList.add('hidden');
          await startTrackDownload(track, payload, chosen);
        };
      });
      $('qualityModal').classList.remove('hidden');
    } catch (err) {
      toast(err.message || '获取下载链接失败', 'error');
    }
  }

  async function startTrackDownload(track, payload, chosen) {
    const dlId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    try {
      const resolved = await resolveQualityItem({ ...chosen }, payload, false);
      const url = resolved.download_token
        ? `/api/download?token=${encodeURIComponent(resolved.download_token)}`
        : resolved.url;
      if (!url) throw new Error('未能获取有效下载地址');

      state.activeDownloads.set(dlId, { title: payload.title || track.title, percent: 0 });
      renderActiveDownloads();
      toast(`开始下载：${payload.title || track.title}`, 'info');

      const record = await api.downloadTrack({
        id: dlId,
        url,
        title: payload.title || track.title,
        artist: payload.author || track.artist || '',
        format: resolved.format || 'flac',
        cover: payload.cover || track.cover || '',
        qualityLabel: qualityLabel(resolved)
      });

      state.activeDownloads.delete(dlId);
      state.downloads = [record, ...state.downloads.filter((d) => d.filePath !== record.filePath)];
      $('dlCountBadge').textContent = String(state.downloads.length);
      renderActiveDownloads();
      if (state.currentView === 'library' && state.libraryTab === 'downloads') renderLibraryView();
      toast(`无损下载完成：${record.title}.${record.format.toLowerCase()}`, 'success');
    } catch (err) {
      state.activeDownloads.delete(dlId);
      renderActiveDownloads();
      toast(err.message || '下载失败', 'error');
    }
  }

  function renderActiveDownloads() {
    const area = $('activeDownloadsArea');
    if (!state.activeDownloads.size) {
      area.classList.add('hidden');
      area.innerHTML = '';
      return;
    }
    area.classList.remove('hidden');
    area.innerHTML = Array.from(state.activeDownloads.entries()).map(([, d]) => `
      <div class="dl-progress-card">
        <div class="dl-progress-head">
          <span>正在下载：${esc(d.title)}</span>
          <span>${d.percent >= 0 ? d.percent + '%' : '下载中...'}</span>
        </div>
        <div class="dl-bar"><div class="dl-bar-fill" style="width:${Math.max(6, d.percent)}%"></div></div>
      </div>
    `).join('');
  }

  // ---------------- Library & Local Views ----------------
  function renderLibraryView() {
    document.querySelectorAll('#librarySubTabs .f-pill').forEach((b) => {
      b.classList.toggle('active', b.dataset.lib === state.libraryTab);
    });
    const isDl = state.libraryTab === 'downloads';
    $('downloadsToolbar').classList.toggle('hidden', !isDl);
    $('downloadDirText').textContent = state.settings.downloadDir || '';
    $('favCountBadge').textContent = String(state.favorites.length);
    $('dlCountBadge').textContent = String(state.downloads.length);

    if (state.libraryTab === 'favorites') {
      renderTrackList($('libraryTracksList'), state.favorites, {
        emptyText: '还没有红心收藏歌曲，点任意歌曲右侧爱心即可珍藏到这里'
      });
    } else if (state.libraryTab === 'history') {
      renderTrackList($('libraryTracksList'), state.history, {
        emptyText: '暂无播放历史，先点一首歌听起来吧'
      });
    } else {
      renderActiveDownloads();
      renderTrackList($('libraryTracksList'), state.downloads, {
        emptyText: '还没有下载到本地的无损歌曲，点歌曲右侧下载图标即可保存到本地'
      });
    }
  }

  function renderLocalTracks() {
    renderTrackList($('localTracksList'), state.localTracks, {
      emptyText: '点击上方「+ 导入音频文件」或「扫描文件夹」，即可直接离线畅听本地 FLAC / WAV / MP3',
      removableLocal: true
    });
  }

  // ---------------- Queue Drawer ----------------
  function updateQueueUI() {
    $('queueCount').textContent = String(state.queue.length);
    $('drawerQueueTotal').textContent = `${state.queue.length} 首`;
    const list = $('drawerQueueList');
    if (!state.queue.length) {
      list.innerHTML = '<div class="empty-card">播放队列为空</div>';
      return;
    }
    list.innerHTML = state.queue.map((t, idx) => `
      <div class="q-item ${idx === state.queueIndex ? 'active' : ''}" data-qidx="${idx}">
        <div class="q-item-info">
          <strong>${esc(t.title)}</strong>
          <span>${esc(t.artist || t.author || '未知歌手')}</span>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('.q-item').forEach((el) => {
      el.onclick = () => {
        state.queueIndex = Number(el.dataset.qidx);
        loadAndPlayTrack(state.queue[state.queueIndex]);
      };
    });
  }

  // ---------------- Lyrics & Web Audio Visualizer ----------------
  function renderLyricsView() {
    const box = $('immLyrics');
    if (!state.lyrics.length) {
      box.innerHTML = '<div class="lyric-empty">当前歌曲暂无滚动歌词</div>';
      return;
    }
    box.innerHTML = state.lyrics.map((l, idx) => `
      <div class="lyric-line" data-lidx="${idx}">
        <div>${esc(l.text)}</div>
        ${l.trans ? `<div class="lyric-trans">${esc(l.trans)}</div>` : ''}
      </div>
    `).join('');
    box.querySelectorAll('.lyric-line').forEach((el) => {
      el.onclick = () => {
        const line = state.lyrics[Number(el.dataset.lidx)];
        if (line && Number.isFinite(line.time)) audio.currentTime = line.time;
      };
    });
  }

  function syncActiveLyric(curTime) {
    if (!state.lyrics.length) return;
    let idx = -1;
    for (let i = 0; i < state.lyrics.length; i++) {
      if (curTime + 0.15 >= state.lyrics[i].time) idx = i;
      else break;
    }
    if (idx === state.activeLyricIdx) return;
    state.activeLyricIdx = idx;
    const nodes = $('immLyrics').querySelectorAll('.lyric-line');
    nodes.forEach((n, i) => n.classList.toggle('active', i === idx));
    if (idx >= 0 && nodes[idx]) {
      nodes[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function ensureAudioVisualizer() {
    try {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AC();
        const src = audioCtx.createMediaElementSource(audio);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        src.connect(analyser);
        analyser.connect(audioCtx.destination);
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      if (!visualizerRaf) drawVisualizer();
    } catch {}
  }

  function drawVisualizer() {
    visualizerRaf = requestAnimationFrame(drawVisualizer);
    const canvas = $('immVisualizer');
    if (!analyser || !canvas || $('immersiveOverlay').classList.contains('hidden')) return;
    const ctx = canvas.getContext('2d');
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const bars = 36;
    const gap = 4;
    const barW = (canvas.width - gap * (bars - 1)) / bars;
    for (let i = 0; i < bars; i++) {
      const val = data[i + 2] || 0;
      const h = Math.max(4, (val / 255) * (canvas.height - 4));
      const grad = ctx.createLinearGradient(0, canvas.height - h, 0, canvas.height);
      grad.addColorStop(0, '#ff477e');
      grad.addColorStop(1, '#ffe34f');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.roundRect(i * (barW + gap), (canvas.height - h) / 2, barW, h, 4);
      ctx.fill();
    }
  }

  // ---------------- Hero Custom Background ----------------
  function applyHeroBackground(imgPath) {
    const hero = $('heroCollage');
    const bg = $('heroBgPhoto');
    const resetBtn = $('resetHeroBgBtn');
    if (imgPath) {
      bg.style.backgroundImage = `url("${localProxyUrl(imgPath)}")`;
      hero.classList.add('has-custom-bg');
      resetBtn.classList.remove('hidden');
    } else {
      bg.style.backgroundImage = '';
      hero.classList.remove('has-custom-bg');
      resetBtn.classList.add('hidden');
    }
  }

  // ---------------- Wire All Events ----------------
  function bindEvents() {
    $('winMinBtn').onclick = () => api.windowControl('minimize');
    $('winMaxBtn').onclick = () => api.windowControl('maximize');
    $('winCloseBtn').onclick = () => api.windowControl('close');

    $('brandHomeBtn').onclick = () => switchView('home');
    document.querySelectorAll('.nav-pill').forEach((b) => {
      b.onclick = () => switchView(b.dataset.view);
    });
    document.querySelectorAll('[data-goto]').forEach((b) => {
      b.onclick = () => switchView(b.dataset.goto);
    });
    $('collectionBackBtn').onclick = () => switchView(state.previousView || 'home');

    $('searchBtn').onclick = () => runSearch($('searchInput').value);
    $('searchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runSearch($('searchInput').value);
    });

    $('heroPlayAllBtn').onclick = () => {
      if (state.discover.homeTracks.length) playFromList(state.discover.homeTracks, 0);
      else if (state.localTracks.length) playFromList(state.localTracks, 0);
      else toast('正在加载推荐曲目，请稍候', 'info');
    };
    $('heroVinylStage').onclick = () => $('immersiveOverlay').classList.remove('hidden');
    $('heroPlayBtn').onclick = togglePlayPause;
    $('heroPrevBtn').onclick = () => stepTrack(-1);
    $('heroNextBtn').onclick = () => stepTrack(1);

    $('changeHeroBgBtn').onclick = async () => {
      const p = await api.chooseHeroImage();
      if (p) {
        state.settings.heroImage = p;
        applyHeroBackground(p);
        toast('主视觉背景已更新', 'success');
      }
    };
    $('resetHeroBgBtn').onclick = async () => {
      await api.saveSettings({ heroImage: '' });
      state.settings.heroImage = '';
      applyHeroBackground('');
    };

    document.querySelectorAll('.q-tile').forEach((tile) => {
      tile.onclick = () => {
        const act = tile.dataset.quick;
        if (act === 'favorites') {
          state.libraryTab = 'favorites';
          switchView('library');
        } else if (act === 'charts') {
          switchView('charts');
        } else if (act === 'playlists') {
          switchView('playlists');
        } else if (act === 'roam') {
          const pool = state.discover.hotTracks.length
            ? state.discover.hotTracks
            : (state.discover.homeTracks.length ? state.discover.homeTracks : state.localTracks);
          if (pool.length) {
            const idx = Math.floor(Math.random() * pool.length);
            playFromList(pool, idx);
            toast('已为你随机漫游一首无损好歌', 'success');
          } else {
            toast('曲库正在加载中，请稍候', 'info');
          }
        } else if (act === 'history') {
          state.libraryTab = 'history';
          switchView('library');
        } else if (act === 'downloads') {
          state.libraryTab = 'downloads';
          switchView('library');
        }
      };
    });

    document.querySelectorAll('#playlistSourceFilters .f-pill').forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll('#playlistSourceFilters .f-pill').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        state.discover.source = b.dataset.source;
        loadDiscoverHome();
      };
    });

    $('homePlayAllTracksBtn').onclick = () => playFromList(state.discover.homeTracks, 0);
    $('playCurrentChartBtn').onclick = () => playFromList(state.discover.chartTracks, 0);
    $('collectionPlayAllBtn').onclick = () => playFromList(state.collection.items, 0);
    $('playAllLocalBtn').onclick = () => {
      if (state.localTracks.length) playFromList(state.localTracks, 0);
      else toast('请先导入本地音频文件', 'info');
    };

    document.querySelectorAll('#librarySubTabs .f-pill').forEach((b) => {
      b.onclick = () => {
        state.libraryTab = b.dataset.lib;
        renderLibraryView();
      };
    });
    $('changeDownloadDirBtn').onclick = async () => {
      const dir = await api.chooseDownloadDir();
      if (dir) {
        state.settings.downloadDir = dir;
        $('downloadDirText').textContent = dir;
        toast('下载保存目录已更新', 'success');
      }
    };
    $('openDownloadDirBtn').onclick = () => api.openDownloadDir();

    $('importFilesBtn').onclick = async () => {
      const merged = await api.importLocalFiles();
      if (merged.length) {
        state.localTracks = merged;
        renderLocalTracks();
        toast(`已导入本地曲库，共 ${merged.length} 首`, 'success');
      }
    };
    $('importFolderBtn').onclick = async () => {
      const merged = await api.importLocalFolder();
      if (merged.length) {
        state.localTracks = merged;
        renderLocalTracks();
        toast(`扫描完成，本地曲库共 ${merged.length} 首`, 'success');
      }
    };

    $('openImmersiveBtn').onclick = (e) => {
      if (e.target.closest('#qualitySwitchBtn')) return;
      $('immersiveOverlay').classList.remove('hidden');
    };
    $('closeImmersiveBtn').onclick = () => $('immersiveOverlay').classList.add('hidden');
    $('qualitySwitchBtn').onclick = (e) => {
      e.stopPropagation();
      openPlayQualityModal();
    };
    $('closeQualityModal').onclick = () => $('qualityModal').classList.add('hidden');

    $('dockPlayBtn').onclick = togglePlayPause;
    $('dockPrevBtn').onclick = () => stepTrack(-1);
    $('dockNextBtn').onclick = () => stepTrack(1);
    $('dockLikeBtn').onclick = () => { if (state.currentTrack) toggleFavorite(state.currentTrack); };
    $('dockDownloadBtn').onclick = () => {
      if (state.currentTrack && !state.currentTrack.filePath) openDownloadPicker(state.currentTrack);
      else toast('请先播放一首在线歌曲再下载', 'info');
    };

    const modeIcons = { sequence: '顺序播放', loop: '单曲循环', shuffle: '随机播放' };
    $('dockModeBtn').onclick = () => {
      const order = ['sequence', 'loop', 'shuffle'];
      state.playMode = order[(order.indexOf(state.playMode) + 1) % order.length];
      $('dockModeBtn').title = modeIcons[state.playMode];
      api.saveSettings({ playMode: state.playMode });
      toast(`播放模式：${modeIcons[state.playMode]}`, 'info');
    };

    $('volumeSlider').addEventListener('input', (e) => {
      const v = Number(e.target.value);
      audio.volume = v;
      api.saveSettings({ volume: v });
    });

    $('dockQueueBtn').onclick = () => $('queueDrawer').classList.toggle('hidden');
    $('clearQueueBtn').onclick = () => {
      state.queue = [];
      state.queueIndex = -1;
      updateQueueUI();
    };

    $('progressBar').onclick = (e) => {
      if (!audio.duration) return;
      const rect = $('progressBar').getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      audio.currentTime = ratio * audio.duration;
    };

    audio.addEventListener('play', syncPlayButtons);
    audio.addEventListener('pause', syncPlayButtons);
    audio.addEventListener('timeupdate', () => {
      const cur = audio.currentTime || 0;
      const dur = audio.duration || 0;
      $('curTime').textContent = formatTime(cur);
      $('durTime').textContent = formatTime(dur);
      const pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;
      $('progressFill').style.width = `${pct}%`;
      $('progressThumb').style.left = `${pct}%`;
      syncActiveLyric(cur);
    });
    audio.addEventListener('ended', () => {
      if (state.playMode === 'loop') {
        audio.currentTime = 0;
        audio.play();
      } else {
        stepTrack(1);
      }
    });
    audio.addEventListener('error', () => {
      if (audio.src) toast('音频流加载出错，可点音质标签切换重试', 'error');
    });

    api.onDownloadProgress(({ id, percent }) => {
      const entry = state.activeDownloads.get(id);
      if (entry) {
        entry.percent = percent;
        renderActiveDownloads();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
        e.preventDefault();
        togglePlayPause();
      }
    });

    $('qualityModal').addEventListener('click', (e) => {
      if (e.target === $('qualityModal')) $('qualityModal').classList.add('hidden');
    });
  }

  function togglePlayPause() {
    if (!audio.src) {
      $('heroPlayAllBtn').click();
      return;
    }
    if (audio.paused) {
      audio.play().catch(() => {});
      ensureAudioVisualizer();
    } else {
      audio.pause();
    }
  }

  // ---------------- Init (Zero-Login Instant Startup!) ----------------
  async function init() {
    bindEvents();
    const boot = await api.getBootstrap();
    state.proxyBase = boot.proxyBase;
    state.siteBase = boot.siteBase;
    state.settings = boot.settings || {};
    state.engine = state.settings.engine || 'public';
    state.preferredQuality = state.settings.preferredQuality || 'flac';
    state.playMode = state.settings.playMode || 'sequence';
    state.localTracks = Array.isArray(state.settings.localTracks) ? state.settings.localTracks : [];
    state.downloads = Array.isArray(state.settings.downloads) ? state.settings.downloads : [];

    audio.volume = typeof state.settings.volume === 'number' ? state.settings.volume : 0.85;
    $('volumeSlider').value = String(audio.volume);
    $('dlCountBadge').textContent = String(state.downloads.length);

    if (state.settings.heroImage) applyHeroBackground(state.settings.heroImage);
    renderLocalTracks();
    loadLocalSavedLibrary();
    await loadDiscoverHome();
  }

  init();
})();
