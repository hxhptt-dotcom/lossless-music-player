const { app, BrowserWindow, ipcMain, session, dialog, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Readable } = require('stream');

const BASE_URL = 'https://dl.74520.xyz';
const GD_API = 'https://music-api.gdstudio.xyz/api.php';
const PARTITION = 'persist:music74520';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PUBLIC_CHARTS = [
  { key: '3779629', id: '3779629', title: '新歌榜', subtitle: '全网每日新歌速递', platform: 'netease', platform_label: '免登无损' },
  { key: '3778678', id: '3778678', title: '热歌榜', subtitle: '全网高热度金曲榜', platform: 'netease', platform_label: '免登无损' },
  { key: '19723756', id: '19723756', title: '飙升榜', subtitle: '热度急速上升单曲', platform: 'netease', platform_label: '免登无损' },
  { key: '2884035', id: '2884035', title: '原创榜', subtitle: '优质原创音乐推荐', platform: 'netease', platform_label: '免登无损' },
  { key: '2250011882', id: '2250011882', title: '抖音热歌榜', subtitle: '热门短视频神曲', platform: 'netease', platform_label: '免登无损' },
  { key: '2809513713', id: '2809513713', title: '欧美热歌榜', subtitle: '欧美流行热单', platform: 'netease', platform_label: '免登无损' },
  { key: '5059644681', id: '5059644681', title: '日语热歌榜', subtitle: '日系精选人气单曲', platform: 'netease', platform_label: '免登无损' }
];

const PUBLIC_CATEGORIES = ['全部', '流行', '华语', '粤语', '欧美', '治愈', '电子', '说唱', '怀旧', '轻音乐'];

let mainWindow = null;
let authWindow = null;
let clientToken = '';
let proxyPort = 0;
let proxyServer = null;
const picUrlCache = new Map();

// ---------------- Settings & Local Storage ----------------
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'player-settings.json');
}

function getDefaultDownloadDir() {
  const dir = path.join(app.getPath('music'), '无损音乐播放器');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

function loadSettings() {
  const defaults = {
    engine: 'public', // 'public' (免登录默认) | 'site74520' (扩展源)
    downloadDir: getDefaultDownloadDir(),
    preferredQuality: 'flac',
    heroImage: '',
    localTracks: [],
    downloads: [],
    localFavorites: [],
    localHistory: [],
    volume: 0.85,
    playMode: 'sequence'
  };
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

function saveSettings(patch) {
  const current = loadSettings();
  const next = { ...current, ...patch };
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(next, null, 2), 'utf-8');
  } catch (e) {
    console.error('saveSettings error:', e);
  }
  return next;
}

// ---------------- Public No-Login Lossless Engine ----------------
async function fetchJson(url, extraHeaders = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await net.fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        ...extraHeaders
      },
      signal: controller.signal
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function extractNeteaseIdFromUrl(u) {
  const m = String(u || '').match(/[?&]id=(\d+)/);
  return m ? m[1] : '';
}

function normalizeMetingTrack(item) {
  const songId = extractNeteaseIdFromUrl(item.url) || extractNeteaseIdFromUrl(item.lrc) || String(item.id || '');
  const title = item.name || item.title || '未命名歌曲';
  const artist = item.artist || item.author || '未知歌手';
  return {
    id: songId,
    song_id: songId,
    track_key: `public:netease:${songId || title}`,
    title,
    artist,
    album: item.album || '',
    platform: 'netease',
    engine: 'public',
    cover: item.pic || '',
    fallbackUrl: item.url || '',
    lrcUrl: item.lrc || '',
    url: songId ? `https://music.163.com/#/song?id=${songId}` : (item.url || '')
  };
}

async function publicGetDiscover(category = '全部', limit = 15) {
  let playlists = [];
  try {
    const cat = encodeURIComponent(category || '全部');
    const data = await fetchJson(
      `https://music.163.com/api/playlist/list?cat=${cat}&order=hot&limit=${limit}&offset=0`,
      { Referer: 'https://music.163.com/' }
    );
    const raw = Array.isArray(data.playlists) ? data.playlists : [];
    playlists = raw.map((p) => ({
      id: String(p.id),
      playlist_id: String(p.id),
      title: p.name || '精选歌单',
      cover: p.coverImgUrl ? `${p.coverImgUrl.replace(/^http:/, 'https:')}?param=400y400` : '',
      platform: 'netease',
      platform_label: p.playCount ? `${Math.round(p.playCount / 10000)}万播放` : '精选歌单',
      engine: 'public'
    }));
  } catch (e) {
    console.error('publicGetDiscover playlists error:', e.message);
  }
  return {
    charts: PUBLIC_CHARTS,
    playlists,
    categories: PUBLIC_CATEGORIES
  };
}

async function publicGetPlaylistTracks(playlistId, limit = 80) {
  const id = String(playlistId || '').replace(/\D/g, '');
  if (!id) throw new Error('无效的歌单 ID');

  // 1. Primary: injahow meting (fast ~160ms)
  const metingUrls = [
    `https://api.injahow.cn/meting/?server=netease&type=playlist&id=${id}`,
    `https://api.i-meto.com/meting/api?server=netease&type=playlist&id=${id}`
  ];
  for (const url of metingUrls) {
    try {
      const arr = await fetchJson(url, {}, 9000);
      if (Array.isArray(arr) && arr.length) {
        return arr.slice(0, limit).map(normalizeMetingTrack);
      }
    } catch {}
  }

  // 2. Fallback: Netease official detail API
  const detail = await fetchJson(
    `https://music.163.com/api/playlist/detail?id=${id}`,
    { Referer: 'https://music.163.com/' },
    10000
  );
  const tracks = (detail.result && detail.result.tracks) || [];
  return tracks.slice(0, limit).map((t) => ({
    id: String(t.id),
    song_id: String(t.id),
    track_key: `public:netease:${t.id}`,
    title: t.name || '未命名歌曲',
    artist: Array.isArray(t.artists) ? t.artists.map((a) => a.name).join(' / ') : '',
    album: (t.album && t.album.name) || '',
    duration: t.duration || 0,
    platform: 'netease',
    engine: 'public',
    cover: t.album && t.album.picUrl ? `${t.album.picUrl.replace(/^http:/, 'https:')}?param=300y300` : '',
    url: `https://music.163.com/#/song?id=${t.id}`
  }));
}

async function publicSearch(query, count = 25) {
  const q = encodeURIComponent(String(query || '').trim());
  // Primary: Netease public web search (fast, reliable, includes cover + duration)
  try {
    const data = await fetchJson(
      `https://music.163.com/api/search/get/web?s=${q}&type=1&offset=0&limit=${count}`,
      { Referer: 'https://music.163.com/' },
      10000
    );
    const songs = (data && data.result && data.result.songs) || [];
    if (songs.length) {
      return songs.map((s) => {
        const id = String(s.id || '');
        const artist = Array.isArray(s.artists) ? s.artists.map((a) => a.name).join(' / ') : '未知歌手';
        const coverRaw = (s.album && (s.album.picUrl || (s.album.artist && s.album.artist.img1v1Url))) || '';
        const cover = coverRaw ? `${coverRaw.replace(/^http:/, 'https:')}?param=300y300` : `https://api.injahow.cn/meting/?server=netease&type=pic&id=${id}`;
        return {
          id,
          song_id: id,
          lyric_id: id,
          track_key: `public:netease:${id}`,
          title: s.name || '未命名歌曲',
          artist,
          album: (s.album && s.album.name) || '',
          duration: s.duration || 0,
          platform: 'netease',
          engine: 'public',
          cover,
          fallbackUrl: `https://api.injahow.cn/meting/?server=netease&type=url&id=${id}`,
          url: `https://music.163.com/#/song?id=${id}`
        };
      });
    }
  } catch (e) {
    console.error('Netease search failed, trying GDStudio:', e.message);
  }

  // Fallback: GDStudio search
  const arr = await fetchJson(`${GD_API}?types=search&source=netease&name=${q}&count=${count}&pages=1`, {}, 12000);
  if (!Array.isArray(arr)) return [];
  return arr.map((it) => {
    const id = String(it.id || it.url_id || '');
    const picId = String(it.pic_id || '');
    const artist = Array.isArray(it.artist) ? it.artist.join(' / ') : String(it.artist || '未知歌手');
    return {
      id,
      song_id: id,
      lyric_id: String(it.lyric_id || id),
      pic_id: picId,
      track_key: `public:netease:${id}`,
      title: it.name || '未命名歌曲',
      artist,
      album: it.album || '',
      platform: 'netease',
      engine: 'public',
      cover: picId ? `http://127.0.0.1:${proxyPort}/gd-pic?id=${encodeURIComponent(picId)}` : '',
      fallbackUrl: `https://api.injahow.cn/meting/?server=netease&type=url&id=${id}`,
      url: `https://music.163.com/#/song?id=${id}`
    };
  });
}

async function publicFetchLyrics(songId) {
  try {
    const data = await fetchJson(
      `https://music.163.com/api/song/lyric?id=${encodeURIComponent(songId)}&lv=1&tv=1`,
      { Referer: 'https://music.163.com/' },
      8000
    );
    const lyric = (data && data.lrc && data.lrc.lyric) || '';
    const tlyric = (data && data.tlyric && data.tlyric.lyric) || '';
    if (lyric) return { lyric, tlyric };
  } catch {}
  try {
    const gd = await fetchJson(`${GD_API}?types=lyric&source=netease&id=${encodeURIComponent(songId)}`, {}, 8000);
    return { lyric: (gd && gd.lyric) || '', tlyric: (gd && gd.tlyric) || '' };
  } catch {
    return { lyric: '', tlyric: '' };
  }
}

async function probeAudioRedirect(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await net.fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, 'Range': 'bytes=0-31' },
      redirect: 'follow',
      signal: controller.signal
    });
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await resp.arrayBuffer());
    const head = buf.slice(0, 4).toString('latin1');
    const isFlac = head === 'fLaC' || /\.flac(\?|$)/i.test(resp.url || '');
    const isAudio = isFlac || head.startsWith('ID3') || ct.startsWith('audio/') || ct.includes('octet-stream') || /\.(mp3|m4a|flac|aac|ogg)(\?|$)/i.test(resp.url || '');
    if (!resp.ok || !isAudio || ct.includes('text/html')) {
      return null;
    }
    let totalSize = 0;
    const cr = resp.headers.get('content-range') || '';
    const m = cr.match(/\/(\d+)$/);
    if (m) totalSize = parseInt(m[1], 10);
    else totalSize = parseInt(resp.headers.get('content-length') || '0', 10);

    return {
      url: resp.url || url,
      size: totalSize,
      isFlac,
      format: isFlac ? 'flac' : 'mp3'
    };
  } finally {
    clearTimeout(timer);
  }
}

async function publicResolveUrl(songId, br = 999) {
  const id = encodeURIComponent(String(songId || ''));
  const brNum = br >= 600 ? 999000 : (br >= 300 ? 320000 : (br >= 180 ? 192000 : 128000));

  // Primary: qijieya meting (no-login, full-track real FLAC up to 999000 & 320k)
  try {
    const p = await probeAudioRedirect(`https://api.qijieya.cn/meting/?type=url&id=${id}&br=${brNum}`, 9000);
    if (p && p.url) {
      const estBr = p.isFlac ? 999 : Math.round(brNum / 1000);
      return {
        url: p.url,
        br: estBr,
        size: p.size,
        format: p.format,
        quality: p.isFlac ? 'flac' : String(estBr)
      };
    }
  } catch {}

  // Secondary: GDStudio API
  try {
    const data = await fetchJson(`${GD_API}?types=url&source=netease&id=${id}&br=${br}`, {}, 8000);
    const url = String((data && data.url) || '').trim();
    const realBr = Number((data && data.br) || 0);
    const size = Number((data && data.size) || 0);
    if (url) {
      const isFlac = /\.flac(\?|$)/i.test(url) || realBr >= 600;
      return {
        url,
        br: realBr,
        size,
        format: isFlac ? 'flac' : 'mp3',
        quality: isFlac ? 'flac' : String(realBr || br)
      };
    }
  } catch {}

  // Fallback: injahow meting direct stream
  const fb = await probeAudioRedirect(`https://api.injahow.cn/meting/?server=netease&type=url&id=${id}`, 8000).catch(() => null);
  return {
    url: (fb && fb.url) || `https://api.injahow.cn/meting/?server=netease&type=url&id=${id}`,
    br: fb && fb.isFlac ? 999 : 320,
    size: (fb && fb.size) || 0,
    format: (fb && fb.format) || 'mp3',
    quality: (fb && fb.isFlac) ? 'flac' : '320'
  };
}

async function publicParseTrack(track, preferredQuality = 'flac') {
  const songId = String(track.song_id || track.id || extractNeteaseIdFromUrl(track.url) || '');
  if (!songId) throw new Error('缺少歌曲 ID');
  const lyricId = String(track.lyric_id || songId);

  const prefBr = preferredQuality === 'flac' ? 999
    : preferredQuality === '320' ? 320
    : preferredQuality === '192' ? 192 : 128;

  const lyricPromise = publicFetchLyrics(lyricId);

  const tryBrs = [...new Set([prefBr, 999, 320, 128])];
  let resolved = null;
  for (const br of tryBrs) {
    try {
      const r = await publicResolveUrl(songId, br);
      if (r && r.url) {
        resolved = r;
        break;
      }
    } catch {}
  }

  if (!resolved) {
    resolved = {
      url: track.fallbackUrl || `https://api.injahow.cn/meting/?server=netease&type=url&id=${songId}`,
      br: 320,
      size: 0,
      format: 'mp3',
      quality: '320'
    };
  }

  const lyricData = await lyricPromise;

  const formatSizeMb = (b) => b > 1024 * 1024 ? `${(b / (1024 * 1024)).toFixed(1)} MB` : (b > 0 ? `${Math.round(b / 1024)} KB` : '');
  const tiers = [
    { tier: 'flac', br: 999, label: 'SQ 无损 FLAC', format: 'flac', quality: 'flac' },
    { tier: '320', br: 320, label: '320K 极高音质', format: 'mp3', quality: '320' },
    { tier: '192', br: 192, label: '192K 较高音质', format: 'mp3', quality: '192' },
    { tier: '128', br: 128, label: '128K 标准音质', format: 'mp3', quality: '128' }
  ];

  const qualities = tiers.map((t) => {
    const matched = resolved && (
      (t.tier === 'flac' && resolved.format === 'flac') ||
      (t.tier !== 'flac' && resolved.format !== 'flac' && Math.abs(resolved.br - t.br) <= 40)
    );
    return {
      engine: 'public',
      platform: 'netease',
      song_id: songId,
      br: t.br,
      quality: t.quality,
      format: matched ? resolved.format : t.format,
      label: matched && resolved.br > 0 ? `${t.label} · ${resolved.br}kbps` : t.label,
      size: matched ? (formatSizeMb(resolved.size) || '在线高速流') : '按需解析',
      url: matched ? resolved.url : '',
      lazy: !matched
    };
  });

  if (resolved && !qualities.some((q) => q.url)) {
    const slot = resolved.format === 'flac' ? qualities[0] : qualities[1];
    slot.url = resolved.url;
    slot.format = resolved.format;
    slot.lazy = false;
    slot.size = formatSizeMb(resolved.size) || '在线高速流';
    if (resolved.br > 0) slot.label = `${slot.label} · ${resolved.br}kbps`;
  }

  return {
    title: track.title || '未命名歌曲',
    author: track.artist || track.author || '',
    cover: track.cover || '',
    platform: 'netease',
    engine: 'public',
    lyric: (lyricData && lyricData.lyric) || '',
    tlyric: (lyricData && lyricData.tlyric) || '',
    audio_qualities: qualities
  };
}

// ---------------- Site 74520 Optional Extended Engine ----------------
function getSiteSession() {
  return session.fromPartition(PARTITION);
}

async function refreshClientToken() {
  const ses = getSiteSession();
  try {
    const resp = await ses.fetch(`${BASE_URL}/api/token`, {
      method: 'GET',
      headers: { 'User-Agent': UA, 'Referer': `${BASE_URL}/` }
    });
    if (resp.ok) {
      const data = await resp.json();
      const tok = data.token || (data.data && data.data.token) || '';
      if (tok) {
        clientToken = tok;
        return tok;
      }
    }
  } catch (e) {
    console.error('refreshClientToken failed:', e.message);
  }
  return clientToken;
}

async function siteApiFetch(apiPath, options = {}) {
  const ses = getSiteSession();
  if (!clientToken) await refreshClientToken();

  const fullUrl = apiPath.startsWith('http') ? apiPath : `${BASE_URL}${apiPath}`;
  const buildHeaders = (tok) => ({
    'User-Agent': UA,
    'Referer': `${BASE_URL}/`,
    'Origin': BASE_URL,
    ...(tok ? { 'X-Client-Token': tok } : {}),
    ...(options.headers || {})
  });

  const doReq = async (tok) => {
    const init = {
      method: options.method || 'GET',
      headers: buildHeaders(tok)
    };
    if (options.body !== undefined) {
      init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
    }
    return ses.fetch(fullUrl, init);
  };

  let resp = await doReq(clientToken);
  if (resp.status === 403) {
    const newTok = await refreshClientToken();
    if (newTok) resp = await doReq(newTok);
  }

  let data = null;
  const text = await resp.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { ok: resp.ok, status: resp.status, data };
}

// ---------------- Local Audio Stream & Cover Proxy ----------------
function mimeFromExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.flac': 'audio/flac',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/opus',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp'
  };
  return map[ext] || 'application/octet-stream';
}

function startLocalProxy() {
  return new Promise((resolve) => {
    proxyServer = http.createServer(async (req, res) => {
      try {
        const parsed = new URL(req.url, 'http://127.0.0.1');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Range');
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        // Lazy HD album cover redirect for GDStudio search results
        if (parsed.pathname === '/gd-pic') {
          const picId = parsed.searchParams.get('id') || '';
          if (!picId) {
            res.writeHead(404);
            res.end();
            return;
          }
          let targetPic = picUrlCache.get(picId);
          if (!targetPic) {
            try {
              const d = await fetchJson(`${GD_API}?types=pic&source=netease&id=${encodeURIComponent(picId)}&size=300`, {}, 6000);
              if (d && d.url) {
                targetPic = d.url;
                picUrlCache.set(picId, targetPic);
              }
            } catch {}
          }
          if (targetPic) {
            res.writeHead(302, { Location: targetPic, 'Cache-Control': 'public, max-age=86400' });
            res.end();
          } else {
            res.writeHead(404);
            res.end();
          }
          return;
        }

        // Local file streaming
        if (parsed.pathname === '/local') {
          const filePath = parsed.searchParams.get('path') || '';
          if (!filePath || !fs.existsSync(filePath)) {
            res.writeHead(404);
            res.end('File not found');
            return;
          }
          const stat = fs.statSync(filePath);
          const total = stat.size;
          const contentType = mimeFromExt(filePath);
          const range = req.headers.range;

          if (range) {
            const m = range.match(/bytes=(\d*)-(\d*)/);
            const start = m && m[1] ? parseInt(m[1], 10) : 0;
            const end = m && m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
            const chunkSize = end - start + 1;
            res.writeHead(206, {
              'Content-Range': `bytes ${start}-${end}/${total}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': chunkSize,
              'Content-Type': contentType
            });
            fs.createReadStream(filePath, { start, end }).pipe(res);
          } else {
            res.writeHead(200, {
              'Content-Length': total,
              'Content-Type': contentType,
              'Accept-Ranges': 'bytes'
            });
            fs.createReadStream(filePath).pipe(res);
          }
          return;
        }

        // Remote audio stream proxy (with FLAC MIME fix + Range support)
        if (parsed.pathname === '/stream') {
          let targetUrl = parsed.searchParams.get('url') || '';
          if (!targetUrl) {
            res.writeHead(400);
            res.end('Missing url');
            return;
          }
          if (targetUrl.startsWith('/')) targetUrl = `${BASE_URL}${targetUrl}`;

          const isSiteUrl = targetUrl.startsWith(BASE_URL);
          const headers = { 'User-Agent': UA };
          if (req.headers.range) headers['Range'] = req.headers.range;
          if (isSiteUrl) {
            if (!clientToken) await refreshClientToken();
            headers['Referer'] = `${BASE_URL}/`;
            if (clientToken) headers['X-Client-Token'] = clientToken;
          }

          const fetcher = isSiteUrl ? getSiteSession().fetch.bind(getSiteSession()) : net.fetch;
          const upstream = await fetcher(targetUrl, {
            method: req.method === 'HEAD' ? 'HEAD' : 'GET',
            headers,
            redirect: 'follow'
          });

          let contentType = upstream.headers.get('content-type') || 'audio/mpeg';
          if (/\.flac(\?|$)/i.test(targetUrl) || /\.flac(\?|$)/i.test(upstream.url || '')) {
            contentType = 'audio/flac';
          }

          const outHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
            'Content-Type': contentType
          };
          const cl = upstream.headers.get('content-length');
          const cr = upstream.headers.get('content-range');
          if (cl) outHeaders['Content-Length'] = cl;
          if (cr) outHeaders['Content-Range'] = cr;

          res.writeHead(upstream.status, outHeaders);
          if (req.method === 'HEAD' || !upstream.body) {
            res.end();
            return;
          }
          const nodeStream = Readable.fromWeb(upstream.body);
          nodeStream.on('error', () => {
            try { res.end(); } catch {}
          });
          req.on('close', () => {
            try { nodeStream.destroy(); } catch {}
          });
          nodeStream.pipe(res);
          return;
        }

        res.writeHead(404);
        res.end('Not Found');
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(502);
          res.end(String(err.message || err));
        }
      }
    });

    proxyServer.listen(0, '127.0.0.1', () => {
      proxyPort = proxyServer.address().port;
      resolve(proxyPort);
    });
  });
}

// ---------------- OAuth Login Window (Optional 74520 Extended Source) ----------------
function openOAuthLogin(provider) {
  const target = provider === 'github'
    ? `${BASE_URL}/api/auth/github/login`
    : `${BASE_URL}/api/auth/linuxdo/login`;

  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.focus();
    authWindow.loadURL(target);
    return;
  }

  authWindow = new BrowserWindow({
    width: 960,
    height: 720,
    parent: mainWindow || undefined,
    title: provider === 'github' ? 'GitHub 登录 - 74520 扩展源' : 'LINUX DO 登录 - 74520 扩展源',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const checkLoggedIn = async (url) => {
    if (!url || !url.startsWith(BASE_URL)) return;
    if (url.includes('/api/auth/')) return;
    try {
      await refreshClientToken();
      const me = await siteApiFetch('/api/auth/me');
      if (me.ok && me.data && me.data.data && me.data.data.authenticated) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('auth-changed', me.data.data);
        }
        if (authWindow && !authWindow.isDestroyed()) {
          authWindow.close();
        }
      }
    } catch {}
  };

  authWindow.webContents.on('did-navigate', (_e, url) => checkLoggedIn(url));
  authWindow.webContents.on('did-finish-load', () => {
    if (authWindow && !authWindow.isDestroyed()) {
      checkLoggedIn(authWindow.webContents.getURL());
    }
  });
  authWindow.on('closed', async () => {
    authWindow = null;
    try {
      const me = await siteApiFetch('/api/auth/me');
      if (mainWindow && !mainWindow.isDestroyed() && me.ok && me.data && me.data.data) {
        mainWindow.webContents.send('auth-changed', me.data.data);
      }
    } catch {}
  });

  authWindow.loadURL(target);
}

// ---------------- Download Lossless Track to Disk ----------------
function sanitizeFilename(name) {
  return String(name || 'audio')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'audio';
}

async function downloadTrackToDisk({ id, url, title, artist, format, cover, qualityLabel }) {
  const settings = loadSettings();
  const dir = settings.downloadDir || getDefaultDownloadDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const ext = (format || 'flac').toLowerCase().replace(/[^a-z0-9]/g, '') || 'flac';
  const baseName = sanitizeFilename(artist ? `${artist} - ${title}` : title);
  let targetPath = path.join(dir, `${baseName}.${ext}`);
  let idx = 1;
  while (fs.existsSync(targetPath)) {
    targetPath = path.join(dir, `${baseName} (${idx++}).${ext}`);
  }

  let fetchUrl = url;
  if (fetchUrl.startsWith('/')) fetchUrl = `${BASE_URL}${fetchUrl}`;
  const isSiteUrl = fetchUrl.startsWith(BASE_URL);
  const headers = { 'User-Agent': UA };
  if (isSiteUrl) {
    if (!clientToken) await refreshClientToken();
    headers['Referer'] = `${BASE_URL}/`;
    if (clientToken) headers['X-Client-Token'] = clientToken;
  }

  const fetcher = isSiteUrl ? getSiteSession().fetch.bind(getSiteSession()) : net.fetch;
  const resp = await fetcher(fetchUrl, { headers, redirect: 'follow' });
  if (!resp.ok || !resp.body) {
    throw new Error(`下载失败 (HTTP ${resp.status})`);
  }

  const total = parseInt(resp.headers.get('content-length') || '0', 10);
  let received = 0;
  const ws = fs.createWriteStream(targetPath);
  const reader = resp.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      ws.write(Buffer.from(value));
      received += value.byteLength;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-progress', {
          id,
          received,
          total,
          percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : -1
        });
      }
    }
    await new Promise((resolve, reject) => {
      ws.end(() => resolve());
      ws.on('error', reject);
    });
  } catch (err) {
    try { ws.destroy(); } catch {}
    try { if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath); } catch {}
    throw err;
  }

  const record = {
    id: id || `dl_${Date.now()}`,
    title: title || baseName,
    artist: artist || '未知歌手',
    format: ext.toUpperCase(),
    qualityLabel: qualityLabel || ext.toUpperCase(),
    cover: cover || '',
    filePath: targetPath,
    size: received,
    downloadedAt: Date.now()
  };

  const latest = loadSettings();
  const downloads = [record, ...(latest.downloads || []).filter((d) => d.filePath !== targetPath)];
  saveSettings({ downloads });
  return record;
}

// ---------------- Local Music Import ----------------
const AUDIO_EXTS = new Set(['.flac', '.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus']);

function parseLocalTrackMeta(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const ext = path.extname(filePath).slice(1).toUpperCase();
  let artist = '本地音乐';
  let title = base;
  if (base.includes(' - ')) {
    const parts = base.split(' - ');
    artist = parts[0].trim() || '本地音乐';
    title = parts.slice(1).join(' - ').trim() || base;
  }
  let size = 0;
  try { size = fs.statSync(filePath).size; } catch {}
  return {
    id: `local:${filePath}`,
    track_key: `local:${filePath}`,
    isLocal: true,
    filePath,
    title,
    artist,
    format: ext,
    size,
    platform: 'local',
    cover: ''
  };
}

function scanAudioFolder(folderPath) {
  const found = [];
  const walk = (dir, depth = 0) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (AUDIO_EXTS.has(path.extname(ent.name).toLowerCase())) {
        found.push(parseLocalTrackMeta(full));
      }
    }
  };
  walk(folderPath, 0);
  return found;
}

// ---------------- Main Window ----------------
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 840,
    minWidth: 1060,
    minHeight: 700,
    frame: false,
    backgroundColor: '#fdf6f2',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------- IPC Handlers ----------------
function setupIPC() {
  ipcMain.handle('window-control', (_e, action) => {
    if (!mainWindow) return;
    if (action === 'minimize') mainWindow.minimize();
    else if (action === 'maximize') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
      return mainWindow.isMaximized();
    } else if (action === 'close') mainWindow.close();
  });

  ipcMain.handle('get-bootstrap', async () => {
    const settings = loadSettings();
    return {
      proxyBase: `http://127.0.0.1:${proxyPort}`,
      siteBase: BASE_URL,
      settings
    };
  });

  ipcMain.handle('save-settings', (_e, patch) => saveSettings(patch));

  // Public no-login lossless endpoints
  ipcMain.handle('public-discover', async (_e, { category, limit } = {}) => {
    try {
      return { ok: true, data: await publicGetDiscover(category, limit) };
    } catch (err) {
      return { ok: false, error: err.message || '加载失败' };
    }
  });

  ipcMain.handle('public-playlist', async (_e, { id, limit } = {}) => {
    try {
      return { ok: true, data: await publicGetPlaylistTracks(id, limit) };
    } catch (err) {
      return { ok: false, error: err.message || '歌单加载失败' };
    }
  });

  ipcMain.handle('public-search', async (_e, { query, count } = {}) => {
    try {
      return { ok: true, data: await publicSearch(query, count) };
    } catch (err) {
      return { ok: false, error: err.message || '搜索失败' };
    }
  });

  ipcMain.handle('public-parse', async (_e, { track, preferredQuality } = {}) => {
    try {
      return { ok: true, data: await publicParseTrack(track, preferredQuality) };
    } catch (err) {
      return { ok: false, error: err.message || '解析无损音频失败' };
    }
  });

  ipcMain.handle('public-resolve', async (_e, { songId, br } = {}) => {
    try {
      return { ok: true, data: await publicResolveUrl(songId, br) };
    } catch (err) {
      return { ok: false, error: err.message || '切换音质失败' };
    }
  });

  // Optional 74520 extended site API proxy
  ipcMain.handle('api-request', async (_e, { path: apiPath, method, body, headers }) => {
    try {
      return await siteApiFetch(apiPath, { method, body, headers });
    } catch (err) {
      return { ok: false, status: 0, data: { detail: err.message || '网络请求失败' } };
    }
  });

  ipcMain.handle('open-login', (_e, provider) => {
    openOAuthLogin(provider);
    return true;
  });

  ipcMain.handle('logout', async () => {
    try { await siteApiFetch('/api/auth/logout', { method: 'POST' }); } catch {}
    try { await getSiteSession().clearStorageData({ storages: ['cookies'] }); } catch {}
    clientToken = '';
    saveSettings({ engine: 'public' });
    return true;
  });

  ipcMain.handle('download-track', async (_e, payload) => downloadTrackToDisk(payload));

  ipcMain.handle('choose-download-dir', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择无损音乐保存目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths.length) return null;
    const dir = r.filePaths[0];
    saveSettings({ downloadDir: dir });
    return dir;
  });

  ipcMain.handle('choose-hero-image', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择播放器主视觉图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile']
    });
    if (r.canceled || !r.filePaths.length) return null;
    const imgPath = r.filePaths[0];
    saveSettings({ heroImage: imgPath });
    return imgPath;
  });

  ipcMain.handle('import-local-files', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '导入本地无损 / 音频文件',
      filters: [{ name: '音频文件', extensions: ['flac', 'wav', 'mp3', 'm4a', 'aac', 'ogg', 'opus'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (r.canceled || !r.filePaths.length) return [];
    const added = r.filePaths.map(parseLocalTrackMeta);
    const settings = loadSettings();
    const map = new Map();
    for (const t of [...added, ...(settings.localTracks || [])]) map.set(t.filePath, t);
    const merged = Array.from(map.values());
    saveSettings({ localTracks: merged });
    return merged;
  });

  ipcMain.handle('import-local-folder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '扫描本地音乐文件夹',
      properties: ['openDirectory']
    });
    if (r.canceled || !r.filePaths.length) return [];
    const added = scanAudioFolder(r.filePaths[0]);
    const settings = loadSettings();
    const map = new Map();
    for (const t of [...added, ...(settings.localTracks || [])]) map.set(t.filePath, t);
    const merged = Array.from(map.values());
    saveSettings({ localTracks: merged });
    return merged;
  });

  ipcMain.handle('remove-local-track', (_e, filePath) => {
    const settings = loadSettings();
    const next = (settings.localTracks || []).filter((t) => t.filePath !== filePath);
    saveSettings({ localTracks: next });
    return next;
  });

  ipcMain.handle('show-in-folder', (_e, filePath) => {
    if (filePath && fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath);
      return true;
    }
    return false;
  });

  ipcMain.handle('open-download-dir', () => {
    const dir = loadSettings().downloadDir || getDefaultDownloadDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return true;
  });
}

app.whenReady().then(async () => {
  await startLocalProxy();
  setupIPC();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('before-quit', () => {
  if (proxyServer) {
    try { proxyServer.close(); } catch {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
