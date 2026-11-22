import Foundation
import Network

final class LocalMusicServer {
    private static let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"

    private var listener: NWListener?
    private let queue = DispatchQueue(label: "com.lossless.musicserver", qos: .userInitiated, attributes: .concurrent)
    private let stateLock = NSLock()
    private var readyPort: Int = 0
    private var readyCallbacks: [(Int) -> Void] = []
    private var triedFallback = false

    func start() {
        startListener(preferredPort: 18427)
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    func whenReady(_ block: @escaping (Int) -> Void) {
        stateLock.lock()
        let currentPort = readyPort
        if currentPort > 0 {
            stateLock.unlock()
            block(currentPort)
            return
        }
        readyCallbacks.append(block)
        stateLock.unlock()
    }

    private func startListener(preferredPort: UInt16?) {
        do {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            if let p = preferredPort, let nwPort = NWEndpoint.Port(rawValue: p) {
                params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: nwPort)
            } else {
                params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: .any)
            }

            let l = try NWListener(using: params)
            self.listener = l

            l.stateUpdateHandler = { [weak self] state in
                guard let self = self else { return }
                switch state {
                case .ready:
                    let p = Int(l.port?.rawValue ?? 0)
                    self.notifyReady(port: p)
                case .failed:
                    if !self.triedFallback {
                        self.triedFallback = true
                        l.cancel()
                        self.startListener(preferredPort: nil)
                    }
                default:
                    break
                }
            }

            l.newConnectionHandler = { [weak self] conn in
                self?.handleConnection(conn)
            }
            l.start(queue: queue)
        } catch {
            if !triedFallback {
                triedFallback = true
                startListener(preferredPort: nil)
            }
        }
    }

    private func notifyReady(port: Int) {
        stateLock.lock()
        readyPort = port
        let cbs = readyCallbacks
        readyCallbacks.removeAll()
        stateLock.unlock()
        for cb in cbs {
            cb(port)
        }
    }

    private func handleConnection(_ conn: NWConnection) {
        conn.start(queue: queue)
        receiveRequest(conn: conn, buffer: Data())
    }

    private func receiveRequest(conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            if error != nil {
                conn.cancel()
                return
            }
            var acc = buffer
            if let d = data { acc.append(d) }

            let sep = Data("\r\n\r\n".utf8)
            if let range = acc.range(of: sep) {
                let headerData = acc.subdata(in: 0..<range.lowerBound)
                self.dispatchRequest(conn: conn, headerData: headerData)
                return
            }
            if isComplete || acc.count > 65536 {
                conn.cancel()
                return
            }
            self.receiveRequest(conn: conn, buffer: acc)
        }
    }

    private func dispatchRequest(conn: NWConnection, headerData: Data) {
        guard let rawHeader = String(data: headerData, encoding: .utf8) ?? String(data: headerData, encoding: .isoLatin1) else {
            conn.cancel()
            return
        }
        let lines = rawHeader.components(separatedBy: "\r\n")
        guard let reqLine = lines.first else { conn.cancel(); return }
        let parts = reqLine.split(separator: " ")
        guard parts.count >= 2 else { conn.cancel(); return }

        let method = String(parts[0]).uppercased()
        let fullPath = String(parts[1])

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            if let idx = line.firstIndex(of: ":") {
                let k = line[..<idx].trimmingCharacters(in: .whitespaces).lowercased()
                let v = line[line.index(after: idx)...].trimmingCharacters(in: .whitespaces)
                headers[k] = v
            }
        }

        if method == "OPTIONS" {
            sendSimple(conn: conn, status: 204, contentType: "text/plain", body: Data())
            return
        }

        let comps = URLComponents(string: "http://127.0.0.1" + fullPath)
        let path = comps?.path ?? fullPath
        var query: [String: String] = [:]
        for item in comps?.queryItems ?? [] {
            query[item.name] = item.value ?? ""
        }

        if path == "/" || path.hasPrefix("/web/") {
            serveWebAsset(conn: conn, path: path)
            return
        }

        if path == "/stream" {
            let target = query["url"] ?? ""
            proxyAudioStream(conn: conn, targetUrl: target, rangeHeader: headers["range"], isHead: method == "HEAD")
            return
        }

        queue.async {
            switch path {
            case "/api/discover":
                let cat = query["category"] ?? "全部"
                self.sendJSON(conn: conn, object: self.fetchDiscover(category: cat))
            case "/api/playlist":
                let id = query["id"] ?? ""
                let items = self.fetchPlaylist(playlistId: id, limit: 60)
                self.sendJSON(conn: conn, object: ["ok": true, "data": items])
            case "/api/search":
                let q = query["q"] ?? ""
                let items = self.searchSongs(query: q, limit: 25)
                self.sendJSON(conn: conn, object: ["ok": true, "data": items])
            case "/api/parse":
                let id = query["id"] ?? ""
                let pref = query["pref"] ?? "flac"
                let data = self.parseTrack(songId: id, pref: pref)
                self.sendJSON(conn: conn, object: ["ok": true, "data": data])
            case "/api/resolve":
                let id = query["id"] ?? ""
                let br = Int(query["br"] ?? "999") ?? 999
                let data = self.resolveAudioUrl(songId: id, br: br)
                self.sendJSON(conn: conn, object: ["ok": true, "data": data])
            default:
                self.sendSimple(conn: conn, status: 404, contentType: "text/plain; charset=utf-8", body: Data("Not Found".utf8))
            }
        }
    }

    private func serveWebAsset(conn: NWConnection, path: String) {
        let rel = path == "/" ? "index.html" : String(path.dropFirst("/web/".count))
        let safeRel = rel.components(separatedBy: "/").last ?? "index.html"
        guard let webRoot = Bundle.main.url(forResource: "web", withExtension: nil) else {
            sendSimple(conn: conn, status: 404, contentType: "text/plain", body: Data("Web bundle missing".utf8))
            return
        }
        let fileURL = webRoot.appendingPathComponent(safeRel)
        guard let data = try? Data(contentsOf: fileURL) else {
            sendSimple(conn: conn, status: 404, contentType: "text/plain", body: Data("Asset not found".utf8))
            return
        }
        let ext = fileURL.pathExtension.lowercased()
        let mime: String
        switch ext {
        case "html": mime = "text/html; charset=utf-8"
        case "css": mime = "text/css; charset=utf-8"
        case "js": mime = "application/javascript; charset=utf-8"
        case "png": mime = "image/png"
        case "jpg", "jpeg": mime = "image/jpeg"
        case "svg": mime = "image/svg+xml"
        default: mime = "application/octet-stream"
        }
        sendSimple(conn: conn, status: 200, contentType: mime, body: data)
    }

    private func sendJSON(conn: NWConnection, object: Any) {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [])) ?? Data("{}".utf8)
        sendSimple(conn: conn, status: 200, contentType: "application/json; charset=utf-8", body: data)
    }

    private func sendSimple(conn: NWConnection, status: Int, contentType: String, body: Data) {
        let text = status == 200 ? "OK" : (status == 204 ? "No Content" : (status == 404 ? "Not Found" : "Error"))
        let head = "HTTP/1.1 \(status) \(text)\r\n"
            + "Access-Control-Allow-Origin: *\r\n"
            + "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n"
            + "Access-Control-Allow-Headers: Range\r\n"
            + "Content-Type: \(contentType)\r\n"
            + "Content-Length: \(body.count)\r\n"
            + "Connection: close\r\n\r\n"
        var payload = Data(head.utf8)
        payload.append(body)
        conn.send(content: payload, isComplete: true, completion: .contentProcessed { _ in
            conn.cancel()
        })
    }

    // MARK: - Sync HTTP Helpers

    private func httpGetData(urlStr: String, referer: String? = nil, range: String? = nil, timeout: TimeInterval = 10) -> (Data?, HTTPURLResponse?) {
        guard let url = URL(string: urlStr) else { return (nil, nil) }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.setValue(Self.ua, forHTTPHeaderField: "User-Agent")
        if let ref = referer { req.setValue(ref, forHTTPHeaderField: "Referer") }
        if let r = range { req.setValue(r, forHTTPHeaderField: "Range") }

        let sem = DispatchSemaphore(value: 0)
        var outData: Data?
        var outResp: HTTPURLResponse?
        let task = URLSession.shared.dataTask(with: req) { data, resp, _ in
            outData = data
            outResp = resp as? HTTPURLResponse
            sem.signal()
        }
        task.resume()
        _ = sem.wait(timeout: .now() + timeout + 1)
        return (outData, outResp)
    }

    private func httpGetString(urlStr: String, referer: String? = nil, timeout: TimeInterval = 10) -> String {
        let (data, _) = httpGetData(urlStr: urlStr, referer: referer, timeout: timeout)
        guard let d = data else { return "" }
        return String(data: d, encoding: .utf8) ?? ""
    }

    // MARK: - Music API Logic

    private func fetchDiscover(category: String) -> [String: Any] {
        let chartDefs: [[String]] = [
            ["3779629", "新歌榜", "每日新歌速递"],
            ["3778678", "热歌榜", "全网高热度金曲"],
            ["19723756", "飙升榜", "热度急速上升"],
            ["2884035", "原创榜", "优质原创推荐"],
            ["2250011882", "抖音热歌榜", "热门短视频神曲"],
            ["2809513713", "欧美热歌榜", "欧美流行热单"],
            ["5059644681", "日语热歌榜", "日系精选单曲"]
        ]
        let charts: [[String: Any]] = chartDefs.map {
            ["key": $0[0], "id": $0[0], "title": $0[1], "subtitle": $0[2]]
        }
        let categories = ["全部", "流行", "华语", "粤语", "欧美", "治愈", "电子", "说唱", "怀旧", "轻音乐"]

        var playlists: [[String: Any]] = []
        let encodedCat = category.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "%E5%85%A8%E9%83%A8"
        let raw = httpGetString(
            urlStr: "https://music.163.com/api/playlist/list?cat=\(encodedCat)&order=hot&limit=12&offset=0",
            referer: "https://music.163.com/"
        )
        if let d = raw.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
           let arr = json["playlists"] as? [[String: Any]] {
            for p in arr {
                let pid = "\(p["id"] ?? "")"
                let title = p["name"] as? String ?? "精选歌单"
                var cov = (p["coverImgUrl"] as? String ?? "").replacingOccurrences(of: "^http:", with: "https:", options: .regularExpression)
                if !cov.isEmpty { cov += "?param=400y400" }
                let cnt = (p["playCount"] as? NSNumber)?.int64Value ?? 0
                let meta = cnt > 10000 ? "\(cnt / 10000)万播放" : "精选歌单"
                playlists.append(["id": pid, "title": title, "cover": cov, "meta": meta])
            }
        }

        return [
            "ok": true,
            "data": [
                "charts": charts,
                "categories": categories,
                "playlists": playlists
            ]
        ]
    }

    private func extractIdFromUrl(_ u: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: "[?&]id=(\\d+)"),
              let m = regex.firstMatch(in: u, range: NSRange(u.startIndex..., in: u)),
              let r = Range(m.range(at: 1), in: u) else { return "" }
        return String(u[r])
    }

    private func fetchPlaylist(playlistId: String, limit: Int) -> [[String: Any]] {
        let id = playlistId.filter { $0.isNumber }
        if id.isEmpty { return [] }

        let urls = [
            "https://api.injahow.cn/meting/?server=netease&type=playlist&id=\(id)",
            "https://api.i-meto.com/meting/api?server=netease&type=playlist&id=\(id)"
        ]
        for u in urls {
            let raw = httpGetString(urlStr: u, timeout: 9)
            if raw.hasPrefix("["),
               let d = raw.data(using: .utf8),
               let arr = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]] {
                var out: [[String: Any]] = []
                for it in arr.prefix(limit) {
                    let urlStr = it["url"] as? String ?? ""
                    let lrcStr = it["lrc"] as? String ?? ""
                    var sid = extractIdFromUrl(urlStr)
                    if sid.isEmpty { sid = extractIdFromUrl(lrcStr) }
                    let name = it["name"] as? String ?? it["title"] as? String ?? "未命名歌曲"
                    let artist = it["artist"] as? String ?? it["author"] as? String ?? "未知歌手"
                    let pic = (it["pic"] as? String ?? "").replacingOccurrences(of: "^http:", with: "https:", options: .regularExpression)
                    out.append([
                        "id": sid,
                        "song_id": sid,
                        "track_key": "netease:\(sid.isEmpty ? name : sid)",
                        "title": name,
                        "artist": artist,
                        "cover": pic,
                        "fallbackUrl": urlStr
                    ])
                }
                if !out.isEmpty { return out }
            }
        }

        let raw = httpGetString(urlStr: "https://music.163.com/api/playlist/detail?id=\(id)", referer: "https://music.163.com/")
        guard let d = raw.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let result = json["result"] as? [String: Any],
              let tracks = result["tracks"] as? [[String: Any]] else { return [] }
        var out: [[String: Any]] = []
        for s in tracks.prefix(limit) {
            let sid = "\(s["id"] ?? "")"
            let alb = s["album"] as? [String: Any]
            var cov = (alb?["picUrl"] as? String ?? "").replacingOccurrences(of: "^http:", with: "https:", options: .regularExpression)
            if !cov.isEmpty { cov += "?param=300y300" }
            out.append([
                "id": sid,
                "song_id": sid,
                "track_key": "netease:\(sid)",
                "title": s["name"] as? String ?? "未命名",
                "artist": joinArtists(s["artists"] as? [[String: Any]]),
                "duration": (s["duration"] as? NSNumber)?.int64Value ?? 0,
                "cover": cov
            ])
        }
        return out
    }

    private func searchSongs(query: String, limit: Int) -> [[String: Any]] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
            .addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        var raw = httpGetString(
            urlStr: "https://music.163.com/api/cloudsearch/pc?s=\(q)&type=1&offset=0&limit=\(limit)",
            referer: "https://music.163.com/"
        )
        if !raw.contains("\"songs\"") {
            raw = httpGetString(
                urlStr: "https://music.163.com/api/search/get/web?s=\(q)&type=1&offset=0&limit=\(limit)",
                referer: "https://music.163.com/"
            )
        }
        guard let d = raw.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let result = json["result"] as? [String: Any],
              let songs = result["songs"] as? [[String: Any]] else { return [] }

        var out: [[String: Any]] = []
        for s in songs {
            let sid = "\(s["id"] ?? "")"
            let alb = (s["al"] as? [String: Any]) ?? (s["album"] as? [String: Any])
            var cov = (alb?["picUrl"] as? String ?? "").replacingOccurrences(of: "^http:", with: "https:", options: .regularExpression)
            if !cov.isEmpty { cov += "?param=300y300" }
            let artistsArr = (s["ar"] as? [[String: Any]]) ?? (s["artists"] as? [[String: Any]])
            let dur = (s["dt"] as? NSNumber)?.int64Value ?? (s["duration"] as? NSNumber)?.int64Value ?? 0
            out.append([
                "id": sid,
                "song_id": sid,
                "track_key": "netease:\(sid)",
                "title": s["name"] as? String ?? "未命名",
                "artist": joinArtists(artistsArr),
                "album": alb?["name"] as? String ?? "",
                "duration": dur,
                "cover": cov
            ])
        }
        return out
    }

    private func joinArtists(_ arr: [[String: Any]]?) -> String {
        guard let arr = arr, !arr.isEmpty else { return "未知歌手" }
        let names = arr.compactMap { $0["name"] as? String }.filter { !$0.isEmpty }
        return names.isEmpty ? "未知歌手" : names.joined(separator: " / ")
    }

    private func probeAudio(urlStr: String) -> [String: Any]? {
        let (data, resp) = httpGetData(urlStr: urlStr, range: "bytes=0-31", timeout: 9)
        guard let r = resp, r.statusCode < 400 else { return nil }
        let ct = (r.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
        if ct.contains("text/html") { return nil }
        let finalUrl = r.url?.absoluteString ?? urlStr
        let head = data.flatMap { d -> String? in
            d.count >= 4 ? String(data: d.prefix(4), encoding: .isoLatin1) : ""
        } ?? ""
        let isFlac = head == "fLaC" || finalUrl.lowercased().contains(".flac")
        let isAudio = isFlac || head.hasPrefix("ID3") || ct.hasPrefix("audio/") || ct.contains("octet-stream")
        if !isAudio { return nil }

        var size: Int64 = 0
        if let cr = r.value(forHTTPHeaderField: "Content-Range"),
           let slash = cr.lastIndex(of: "/"),
           let total = Int64(cr[cr.index(after: slash)...]) {
            size = total
        }
        if size <= 0 {
            size = max(0, r.expectedContentLength)
        }
        return [
            "url": finalUrl,
            "size": size,
            "isFlac": isFlac,
            "format": isFlac ? "flac" : "mp3"
        ]
    }

    private func resolveAudioUrl(songId: String, br: Int) -> [String: Any] {
        let brNum = br >= 600 ? 999000 : (br >= 300 ? 320000 : (br >= 180 ? 192000 : 128000))
        if var p = probeAudio(urlStr: "https://api.qijieya.cn/meting/?type=url&id=\(songId)&br=\(brNum)") {
            let isFlac = (p["isFlac"] as? Bool) ?? false
            p["br"] = isFlac ? 999 : (brNum / 1000)
            p["quality"] = isFlac ? "flac" : "\(brNum / 1000)"
            return p
        }
        if var fb = probeAudio(urlStr: "https://api.injahow.cn/meting/?server=netease&type=url&id=\(songId)") {
            let isFlac = (fb["isFlac"] as? Bool) ?? false
            fb["br"] = isFlac ? 999 : 320
            fb["quality"] = isFlac ? "flac" : "320"
            return fb
        }
        return [
            "url": "https://api.injahow.cn/meting/?server=netease&type=url&id=\(songId)",
            "br": 320,
            "size": 0,
            "format": "mp3",
            "quality": "320"
        ]
    }

    private func parseTrack(songId: String, pref: String) -> [String: Any] {
        let prefBr = pref == "flac" ? 999 : (pref == "320" ? 320 : (pref == "192" ? 192 : 128))
        let resolved = resolveAudioUrl(songId: songId, br: prefBr)

        var lyric = ""
        var tlyric = ""
        let lraw = httpGetString(
            urlStr: "https://music.163.com/api/song/lyric?id=\(songId)&lv=1&tv=1",
            referer: "https://music.163.com/",
            timeout: 8
        )
        if let d = lraw.data(using: .utf8),
           let lj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            if let lrcObj = lj["lrc"] as? [String: Any] { lyric = lrcObj["lyric"] as? String ?? "" }
            if let tlrcObj = lj["tlyric"] as? [String: Any] { tlyric = tlrcObj["lyric"] as? String ?? "" }
        }

        return [
            "resolved": resolved,
            "lyric": lyric,
            "tlyric": tlyric
        ]
    }

    // MARK: - Streaming Range Proxy

    private func proxyAudioStream(conn: NWConnection, targetUrl: String, rangeHeader: String?, isHead: Bool) {
        guard let url = URL(string: targetUrl) else {
            sendSimple(conn: conn, status: 400, contentType: "text/plain", body: Data("Missing url".utf8))
            return
        }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.setValue(Self.ua, forHTTPHeaderField: "User-Agent")
        if let r = rangeHeader, !r.isEmpty {
            req.setValue(r, forHTTPHeaderField: "Range")
        }

        let pipe = StreamPipeDelegate(conn: conn, targetUrl: targetUrl, isHead: isHead)
        let session = URLSession(configuration: .ephemeral, delegate: pipe, delegateQueue: nil)
        pipe.session = session
        let task = session.dataTask(with: req)
        pipe.task = task

        conn.stateUpdateHandler = { state in
            if case .cancelled = state {
                task.cancel()
                session.invalidateAndCancel()
            } else if case .failed = state {
                task.cancel()
                session.invalidateAndCancel()
            }
        }
        task.resume()
    }
}

private final class StreamPipeDelegate: NSObject, URLSessionDataDelegate {
    private let conn: NWConnection
    private let targetUrl: String
    private let isHead: Bool
    var session: URLSession?
    var task: URLSessionDataTask?

    init(conn: NWConnection, targetUrl: String, isHead: Bool) {
        self.conn = conn
        self.targetUrl = targetUrl
        self.isHead = isHead
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            conn.cancel()
            return
        }
        let status = http.statusCode
        let finalUrl = http.url?.absoluteString ?? targetUrl
        var ct = http.value(forHTTPHeaderField: "Content-Type") ?? "audio/mpeg"
        if targetUrl.lowercased().contains(".flac") || finalUrl.lowercased().contains(".flac") {
            ct = "audio/flac"
        }
        let cl = http.value(forHTTPHeaderField: "Content-Length")
        let cr = http.value(forHTTPHeaderField: "Content-Range")
        let ar = http.value(forHTTPHeaderField: "Accept-Ranges") ?? "bytes"

        var head = "HTTP/1.1 \(status) \(status == 206 ? "Partial Content" : "OK")\r\n"
        head += "Access-Control-Allow-Origin: *\r\n"
        head += "Accept-Ranges: \(ar)\r\n"
        head += "Content-Type: \(ct)\r\n"
        if let cl = cl { head += "Content-Length: \(cl)\r\n" }
        if let cr = cr { head += "Content-Range: \(cr)\r\n" }
        head += "Connection: close\r\n\r\n"

        conn.send(content: Data(head.utf8), isComplete: isHead, completion: .contentProcessed { [weak self] _ in
            if self?.isHead == true {
                self?.conn.cancel()
            }
        })

        if isHead {
            completionHandler(.cancel)
        } else {
            completionHandler(.allow)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        conn.send(content: data, completion: .idempotent)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        conn.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { [weak self] _ in
            self?.conn.cancel()
        })
        session.finishTasksAndInvalidate()
    }
}
