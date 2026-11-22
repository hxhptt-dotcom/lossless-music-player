package com.lossless.musicplayer;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class LocalMusicServer {
    private static final String UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
    private ServerSocket serverSocket;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private volatile boolean running = false;
    private int port = 0;

    public int start() throws IOException {
        serverSocket = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        port = serverSocket.getLocalPort();
        running = true;
        pool.execute(() -> {
            while (running) {
                try {
                    Socket client = serverSocket.accept();
                    pool.execute(() -> handleClient(client));
                } catch (IOException ignored) {
                }
            }
        });
        return port;
    }

    public void stop() {
        running = false;
        try { if (serverSocket != null) serverSocket.close(); } catch (Exception ignored) {}
        pool.shutdownNow();
    }

    public int getPort() {
        return port;
    }

    private void handleClient(Socket socket) {
        try {
            socket.setSoTimeout(30000);
            BufferedInputStream in = new BufferedInputStream(socket.getInputStream());
            OutputStream out = socket.getOutputStream();

            BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.ISO_8859_1));
            String requestLine = reader.readLine();
            if (requestLine == null || requestLine.isEmpty()) return;

            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0];
            String fullPath = parts[1];

            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                int idx = line.indexOf(':');
                if (idx > 0) {
                    headers.put(line.substring(0, idx).trim().toLowerCase(), line.substring(idx + 1).trim());
                }
            }

            if ("OPTIONS".equalsIgnoreCase(method)) {
                sendSimple(out, 204, "text/plain", new byte[0]);
                return;
            }

            String path = fullPath;
            Map<String, String> query = new HashMap<>();
            int qIdx = fullPath.indexOf('?');
            if (qIdx >= 0) {
                path = fullPath.substring(0, qIdx);
                String qs = fullPath.substring(qIdx + 1);
                for (String pair : qs.split("&")) {
                    int eq = pair.indexOf('=');
                    if (eq > 0) {
                        String k = URLDecoder.decode(pair.substring(0, eq), "UTF-8");
                        String v = URLDecoder.decode(pair.substring(eq + 1), "UTF-8");
                        query.put(k, v);
                    }
                }
            }

            if ("/api/discover".equals(path)) {
                String cat = query.containsKey("category") ? query.get("category") : "全部";
                JSONObject data = fetchDiscover(cat);
                sendJson(out, 200, data);
            } else if ("/api/playlist".equals(path)) {
                String id = query.containsKey("id") ? query.get("id") : "";
                JSONArray items = fetchPlaylist(id, 60);
                JSONObject res = new JSONObject();
                res.put("ok", true);
                res.put("data", items);
                sendJson(out, 200, res);
            } else if ("/api/search".equals(path)) {
                String q = query.containsKey("q") ? query.get("q") : "";
                JSONArray items = searchSongs(q, 25);
                JSONObject res = new JSONObject();
                res.put("ok", true);
                res.put("data", items);
                sendJson(out, 200, res);
            } else if ("/api/parse".equals(path)) {
                String id = query.containsKey("id") ? query.get("id") : "";
                String pref = query.containsKey("pref") ? query.get("pref") : "flac";
                JSONObject data = parseTrack(id, pref);
                JSONObject res = new JSONObject();
                res.put("ok", true);
                res.put("data", data);
                sendJson(out, 200, res);
            } else if ("/api/resolve".equals(path)) {
                String id = query.containsKey("id") ? query.get("id") : "";
                int br = 999;
                try { br = Integer.parseInt(query.get("br")); } catch (Exception ignored) {}
                JSONObject data = resolveAudioUrl(id, br);
                JSONObject res = new JSONObject();
                res.put("ok", true);
                res.put("data", data);
                sendJson(out, 200, res);
            } else if ("/stream".equals(path)) {
                String target = query.containsKey("url") ? query.get("url") : "";
                proxyAudioStream(target, headers.get("range"), method, out);
            } else {
                sendSimple(out, 404, "text/plain", "Not Found".getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            try {
                JSONObject err = new JSONObject();
                err.put("ok", false);
                err.put("error", e.getMessage() != null ? e.getMessage() : "Server error");
                sendJson(socket.getOutputStream(), 500, err);
            } catch (Exception ignored) {}
        } finally {
            try { socket.close(); } catch (Exception ignored) {}
        }
    }

    private void sendJson(OutputStream out, int status, JSONObject obj) throws IOException {
        sendSimple(out, status, "application/json; charset=utf-8", obj.toString().getBytes(StandardCharsets.UTF_8));
    }

    private void sendSimple(OutputStream out, int status, String contentType, byte[] body) throws IOException {
        String statusText = status == 200 ? "OK" : (status == 204 ? "No Content" : (status == 404 ? "Not Found" : "Error"));
        String head = "HTTP/1.1 " + status + " " + statusText + "\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n"
                + "Access-Control-Allow-Headers: Range\r\n"
                + "Content-Type: " + contentType + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        if (body.length > 0) out.write(body);
        out.flush();
    }

    private HttpURLConnection openFollowRedirect(String urlStr, Map<String, String> extraHeaders, int timeoutMs) throws IOException {
        String current = urlStr;
        for (int hops = 0; hops < 6; hops++) {
            HttpURLConnection conn = (HttpURLConnection) new URL(current).openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setRequestProperty("User-Agent", UA);
            if (extraHeaders != null) {
                for (Map.Entry<String, String> e : extraHeaders.entrySet()) {
                    conn.setRequestProperty(e.getKey(), e.getValue());
                }
            }
            int code = conn.getResponseCode();
            if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                String loc = conn.getHeaderField("Location");
                conn.disconnect();
                if (loc == null || loc.isEmpty()) throw new IOException("Empty redirect");
                current = new URL(new URL(current), loc).toString();
                continue;
            }
            return conn;
        }
        throw new IOException("Too many redirects");
    }

    private String httpGetString(String urlStr, String referer, int timeoutMs) throws IOException {
        Map<String, String> h = new HashMap<>();
        if (referer != null) h.put("Referer", referer);
        HttpURLConnection conn = openFollowRedirect(urlStr, h, timeoutMs);
        try (InputStream is = conn.getResponseCode() < 400 ? conn.getInputStream() : conn.getErrorStream()) {
            if (is == null) return "";
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
            return bos.toString("UTF-8");
        } finally {
            conn.disconnect();
        }
    }

    private JSONObject fetchDiscover(String category) throws Exception {
        JSONObject out = new JSONObject();
        out.put("ok", true);
        JSONObject data = new JSONObject();

        JSONArray charts = new JSONArray();
        String[][] chartDefs = {
                {"3779629", "新歌榜", "每日新歌速递"},
                {"3778678", "热歌榜", "全网高热度金曲"},
                {"19723756", "飙升榜", "热度急速上升"},
                {"2884035", "原创榜", "优质原创推荐"},
                {"2250011882", "抖音热歌榜", "热门短视频神曲"},
                {"2809513713", "欧美热歌榜", "欧美流行热单"},
                {"5059644681", "日语热歌榜", "日系精选单曲"}
        };
        for (String[] c : chartDefs) {
            JSONObject obj = new JSONObject();
            obj.put("key", c[0]);
            obj.put("id", c[0]);
            obj.put("title", c[1]);
            obj.put("subtitle", c[2]);
            charts.put(obj);
        }
        data.put("charts", charts);

        JSONArray cats = new JSONArray(new String[]{"全部", "流行", "华语", "粤语", "欧美", "治愈", "电子", "说唱", "怀旧", "轻音乐"});
        data.put("categories", cats);

        JSONArray playlists = new JSONArray();
        try {
            String raw = httpGetString(
                    "https://music.163.com/api/playlist/list?cat=" + URLEncoder.encode(category, "UTF-8") + "&order=hot&limit=12&offset=0",
                    "https://music.163.com/",
                    10000
            );
            JSONObject json = new JSONObject(raw);
            JSONArray arr = json.optJSONArray("playlists");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject p = arr.getJSONObject(i);
                    JSONObject item = new JSONObject();
                    item.put("id", String.valueOf(p.optLong("id")));
                    item.put("title", p.optString("name", "精选歌单"));
                    String cov = p.optString("coverImgUrl", "").replaceFirst("^http:", "https:");
                    item.put("cover", cov.isEmpty() ? "" : cov + "?param=400y400");
                    long cnt = p.optLong("playCount", 0);
                    item.put("meta", cnt > 10000 ? (cnt / 10000) + "万播放" : "精选歌单");
                    playlists.put(item);
                }
            }
        } catch (Exception ignored) {}
        data.put("playlists", playlists);
        out.put("data", data);
        return out;
    }

    private String extractIdFromUrl(String u) {
        if (u == null) return "";
        Matcher m = Pattern.compile("[?&]id=(\\d+)").matcher(u);
        return m.find() ? m.group(1) : "";
    }

    private JSONArray fetchPlaylist(String playlistId, int limit) throws Exception {
        String id = playlistId.replaceAll("\\D", "");
        if (id.isEmpty()) return new JSONArray();

        String[] urls = {
                "https://api.injahow.cn/meting/?server=netease&type=playlist&id=" + id,
                "https://api.i-meto.com/meting/api?server=netease&type=playlist&id=" + id
        };
        for (String u : urls) {
            try {
                String raw = httpGetString(u, null, 9000);
                if (raw.startsWith("[")) {
                    JSONArray arr = new JSONArray(raw);
                    JSONArray out = new JSONArray();
                    int max = Math.min(arr.length(), limit);
                    for (int i = 0; i < max; i++) {
                        JSONObject it = arr.getJSONObject(i);
                        String sid = extractIdFromUrl(it.optString("url", ""));
                        if (sid.isEmpty()) sid = extractIdFromUrl(it.optString("lrc", ""));
                        JSONObject t = new JSONObject();
                        t.put("id", sid);
                        t.put("song_id", sid);
                        t.put("track_key", "netease:" + (sid.isEmpty() ? it.optString("name", "") : sid));
                        t.put("title", it.optString("name", it.optString("title", "未命名歌曲")));
                        t.put("artist", it.optString("artist", it.optString("author", "未知歌手")));
                        t.put("cover", it.optString("pic", ""));
                        t.put("fallbackUrl", it.optString("url", ""));
                        out.put(t);
                    }
                    if (out.length() > 0) return out;
                }
            } catch (Exception ignored) {}
        }

        String raw = httpGetString("https://music.163.com/api/playlist/detail?id=" + id, "https://music.163.com/", 10000);
        JSONObject json = new JSONObject(raw);
        JSONObject result = json.optJSONObject("result");
        JSONArray tracks = result != null ? result.optJSONArray("tracks") : null;
        JSONArray out = new JSONArray();
        if (tracks != null) {
            int max = Math.min(tracks.length(), limit);
            for (int i = 0; i < max; i++) {
                JSONObject s = tracks.getJSONObject(i);
                String sid = String.valueOf(s.optLong("id"));
                JSONObject t = new JSONObject();
                t.put("id", sid);
                t.put("song_id", sid);
                t.put("track_key", "netease:" + sid);
                t.put("title", s.optString("name", "未命名"));
                t.put("artist", joinArtists(s.optJSONArray("artists")));
                t.put("duration", s.optLong("duration", 0));
                JSONObject alb = s.optJSONObject("album");
                String cov = alb != null ? alb.optString("picUrl", "").replaceFirst("^http:", "https:") : "";
                t.put("cover", cov.isEmpty() ? "" : cov + "?param=300y300");
                out.put(t);
            }
        }
        return out;
    }

    private JSONArray searchSongs(String query, int limit) throws Exception {
        String q = URLEncoder.encode(query.trim(), "UTF-8");
        String raw = "";
        try {
            raw = httpGetString(
                    "https://music.163.com/api/cloudsearch/pc?s=" + q + "&type=1&offset=0&limit=" + limit,
                    "https://music.163.com/",
                    10000
            );
        } catch (Exception ignored) {}
        if (raw == null || raw.isEmpty() || !raw.contains("\"songs\"")) {
            raw = httpGetString(
                    "https://music.163.com/api/search/get/web?s=" + q + "&type=1&offset=0&limit=" + limit,
                    "https://music.163.com/",
                    10000
            );
        }
        JSONObject json = new JSONObject(raw);
        JSONObject result = json.optJSONObject("result");
        JSONArray songs = result != null ? result.optJSONArray("songs") : null;
        JSONArray out = new JSONArray();
        if (songs != null) {
            for (int i = 0; i < songs.length(); i++) {
                JSONObject s = songs.getJSONObject(i);
                String sid = String.valueOf(s.optLong("id"));
                JSONObject alb = s.optJSONObject("al");
                if (alb == null) alb = s.optJSONObject("album");
                String cov = "";
                if (alb != null) {
                    cov = alb.optString("picUrl", "");
                    if (cov.isEmpty() && alb.optJSONObject("artist") != null) {
                        cov = alb.optJSONObject("artist").optString("img1v1Url", "");
                    }
                }
                cov = cov.replaceFirst("^http:", "https:");
                if (!cov.isEmpty()) cov += "?param=300y300";

                JSONArray artistsArr = s.optJSONArray("ar");
                if (artistsArr == null) artistsArr = s.optJSONArray("artists");
                long dur = s.optLong("dt", s.optLong("duration", 0));

                JSONObject t = new JSONObject();
                t.put("id", sid);
                t.put("song_id", sid);
                t.put("track_key", "netease:" + sid);
                t.put("title", s.optString("name", "未命名"));
                t.put("artist", joinArtists(artistsArr));
                t.put("album", alb != null ? alb.optString("name", "") : "");
                t.put("duration", dur);
                t.put("cover", cov);
                out.put(t);
            }
        }
        return out;
    }

    private String joinArtists(JSONArray arr) {
        if (arr == null || arr.length() == 0) return "未知歌手";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < arr.length(); i++) {
            if (i > 0) sb.append(" / ");
            sb.append(arr.optJSONObject(i) != null ? arr.optJSONObject(i).optString("name", "") : "");
        }
        return sb.toString();
    }

    private JSONObject probeAudio(String urlStr) {
        HttpURLConnection conn = null;
        try {
            Map<String, String> h = new HashMap<>();
            h.put("Range", "bytes=0-31");
            conn = openFollowRedirect(urlStr, h, 9000);
            int code = conn.getResponseCode();
            String ct = conn.getContentType() != null ? conn.getContentType().toLowerCase() : "";
            String finalUrl = conn.getURL().toString();
            if (code >= 400 || ct.contains("text/html")) return null;

            byte[] headBuf = new byte[16];
            int read = 0;
            try (InputStream is = conn.getInputStream()) {
                read = is.read(headBuf);
            }
            String head = read >= 4 ? new String(headBuf, 0, 4, StandardCharsets.ISO_8859_1) : "";
            boolean isFlac = "fLaC".equals(head) || finalUrl.toLowerCase().contains(".flac");
            boolean isAudio = isFlac || head.startsWith("ID3") || ct.startsWith("audio/") || ct.contains("octet-stream");
            if (!isAudio) return null;

            long size = 0;
            String cr = conn.getHeaderField("Content-Range");
            if (cr != null) {
                Matcher m = Pattern.compile("/(\\d+)$").matcher(cr);
                if (m.find()) size = Long.parseLong(m.group(1));
            }
            if (size <= 0) size = conn.getContentLengthLong();

            JSONObject obj = new JSONObject();
            obj.put("url", finalUrl);
            obj.put("size", Math.max(0, size));
            obj.put("isFlac", isFlac);
            obj.put("format", isFlac ? "flac" : "mp3");
            return obj;
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private JSONObject resolveAudioUrl(String songId, int br) throws Exception {
        int brNum = br >= 600 ? 999000 : (br >= 300 ? 320000 : (br >= 180 ? 192000 : 128000));
        JSONObject p = probeAudio("https://api.qijieya.cn/meting/?type=url&id=" + songId + "&br=" + brNum);
        if (p != null) {
            boolean isFlac = p.optBoolean("isFlac", false);
            p.put("br", isFlac ? 999 : (brNum / 1000));
            p.put("quality", isFlac ? "flac" : String.valueOf(brNum / 1000));
            return p;
        }
        JSONObject fb = probeAudio("https://api.injahow.cn/meting/?server=netease&type=url&id=" + songId);
        if (fb != null) {
            boolean isFlac = fb.optBoolean("isFlac", false);
            fb.put("br", isFlac ? 999 : 320);
            fb.put("quality", isFlac ? "flac" : "320");
            return fb;
        }
        JSONObject fallback = new JSONObject();
        fallback.put("url", "https://api.injahow.cn/meting/?server=netease&type=url&id=" + songId);
        fallback.put("br", 320);
        fallback.put("size", 0);
        fallback.put("format", "mp3");
        fallback.put("quality", "320");
        return fallback;
    }

    private JSONObject parseTrack(String songId, String pref) throws Exception {
        int prefBr = "flac".equals(pref) ? 999 : ("320".equals(pref) ? 320 : ("192".equals(pref) ? 192 : 128));
        JSONObject resolved = resolveAudioUrl(songId, prefBr);

        String lyric = "";
        String tlyric = "";
        try {
            String lraw = httpGetString("https://music.163.com/api/song/lyric?id=" + songId + "&lv=1&tv=1", "https://music.163.com/", 8000);
            JSONObject lj = new JSONObject(lraw);
            if (lj.optJSONObject("lrc") != null) lyric = lj.optJSONObject("lrc").optString("lyric", "");
            if (lj.optJSONObject("tlyric") != null) tlyric = lj.optJSONObject("tlyric").optString("lyric", "");
        } catch (Exception ignored) {}

        JSONObject res = new JSONObject();
        res.put("resolved", resolved);
        res.put("lyric", lyric);
        res.put("tlyric", tlyric);
        return res;
    }

    private void proxyAudioStream(String targetUrl, String rangeHeader, String method, OutputStream out) throws IOException {
        if (targetUrl == null || targetUrl.isEmpty()) {
            sendSimple(out, 400, "text/plain", "Missing url".getBytes(StandardCharsets.UTF_8));
            return;
        }
        Map<String, String> reqH = new HashMap<>();
        if (rangeHeader != null && !rangeHeader.isEmpty()) reqH.put("Range", rangeHeader);

        HttpURLConnection conn = openFollowRedirect(targetUrl, reqH, 15000);
        try {
            int status = conn.getResponseCode();
            String finalUrl = conn.getURL().toString();
            String ct = conn.getContentType();
            if (ct == null || ct.isEmpty()) ct = "audio/mpeg";
            if (targetUrl.toLowerCase().contains(".flac") || finalUrl.toLowerCase().contains(".flac")) {
                ct = "audio/flac";
            }
            String cl = conn.getHeaderField("Content-Length");
            String cr = conn.getHeaderField("Content-Range");
            String ar = conn.getHeaderField("Accept-Ranges");
            if (ar == null) ar = "bytes";

            StringBuilder head = new StringBuilder();
            head.append("HTTP/1.1 ").append(status).append(status == 206 ? " Partial Content" : " OK").append("\r\n");
            head.append("Access-Control-Allow-Origin: *\r\n");
            head.append("Accept-Ranges: ").append(ar).append("\r\n");
            head.append("Content-Type: ").append(ct).append("\r\n");
            if (cl != null) head.append("Content-Length: ").append(cl).append("\r\n");
            if (cr != null) head.append("Content-Range: ").append(cr).append("\r\n");
            head.append("Connection: close\r\n\r\n");
            out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
            out.flush();

            if ("HEAD".equalsIgnoreCase(method)) return;

            try (InputStream is = status < 400 ? conn.getInputStream() : conn.getErrorStream()) {
                if (is == null) return;
                byte[] buf = new byte[16384];
                int n;
                while ((n = is.read(buf)) != -1) {
                    out.write(buf, 0, n);
                }
                out.flush();
            }
        } finally {
            conn.disconnect();
        }
    }
}
