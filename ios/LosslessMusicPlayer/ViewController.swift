import UIKit
import WebKit
import AVFoundation
import MediaPlayer

class ViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {
    private var webView: WKWebView!

    override var preferredStatusBarStyle: UIStatusBarStyle {
        return .darkContent
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 1.0, green: 0.973, blue: 0.957, alpha: 1.0)
        setupWebView()
        loadAppPage()
    }

    private func setupWebView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = true

        let ucc = WKUserContentController()
        ucc.add(self, name: "iosMusic")
        config.userContentController = ucc

        webView = WKWebView(frame: .zero, configuration: config)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = view.backgroundColor
        webView.scrollView.backgroundColor = view.backgroundColor
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never

        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
    }

    private func loadAppPage() {
        guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
        appDelegate.musicServer.whenReady { [weak self] port in
            DispatchQueue.main.async {
                guard let self = self, port > 0 else { return }
                let base = "http://127.0.0.1:\(port)"
                let script = WKUserScript(
                    source: "window.IOSMusic = { proxyBase: '\(base)' };",
                    injectionTime: .atDocumentStart,
                    forMainFrameOnly: true
                )
                self.webView.configuration.userContentController.addUserScript(script)
                if let url = URL(string: "\(base)/web/index.html") {
                    self.webView.load(URLRequest(url: url))
                }
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "iosMusic", let body = message.body as? [String: Any] else { return }
        let action = body["action"] as? String ?? ""

        if action == "nowPlaying" {
            let title = body["title"] as? String ?? "无损音乐"
            let artist = body["artist"] as? String ?? "SQ 无损 FLAC"
            let playing = body["playing"] as? Bool ?? false
            updateNowPlaying(title: title, artist: artist, playing: playing)
        } else if action == "download" {
            let urlStr = body["url"] as? String ?? ""
            let fileName = body["fileName"] as? String ?? "lossless_audio.flac"
            downloadAndShare(urlStr: urlStr, fileName: fileName)
        }
    }

    private func updateNowPlaying(title: String, artist: String, playing: Bool) {
        do {
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {}
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPMediaItemPropertyTitle] = title
        info[MPMediaItemPropertyArtist] = artist
        info[MPNowPlayingInfoPropertyPlaybackRate] = playing ? 1.0 : 0.0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func downloadAndShare(urlStr: String, fileName: String) {
        guard let url = URL(string: urlStr) else { return }
        let invalid = CharacterSet(charactersIn: "<>:\"/\\|?*")
        let cleanName = fileName.components(separatedBy: invalid).joined(separator: "_").trimmingCharacters(in: .whitespacesAndNewlines)
        let finalName = cleanName.isEmpty ? "lossless_audio.flac" : cleanName

        var req = URLRequest(url: url)
        req.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", forHTTPHeaderField: "User-Agent")

        let task = URLSession.shared.downloadTask(with: req) { [weak self] tempUrl, _, error in
            guard let self = self, let tempUrl = tempUrl, error == nil else { return }
            let destDir = FileManager.default.temporaryDirectory
            let destUrl = destDir.appendingPathComponent(finalName)
            try? FileManager.default.removeItem(at: destUrl)
            do {
                try FileManager.default.moveItem(at: tempUrl, to: destUrl)
                DispatchQueue.main.async {
                    let avc = UIActivityViewController(activityItems: [destUrl], applicationActivities: nil)
                    if let pop = avc.popoverPresentationController {
                        pop.sourceView = self.view
                        pop.sourceRect = CGRect(x: self.view.bounds.midX, y: self.view.bounds.midY, width: 1, height: 1)
                    }
                    self.present(avc, animated: true)
                }
            } catch {
                print("Download move error: \(error)")
            }
        }
        task.resume()
    }
}
