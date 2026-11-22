package com.lossless.musicplayer;

import android.annotation.SuppressLint;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

public class MainActivity extends AppCompatActivity {
    private WebView webView;
    private LocalMusicServer musicServer;
    private String proxyBase = "";

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        musicServer = new LocalMusicServer();
        try {
            int port = musicServer.start();
            proxyBase = "http://127.0.0.1:" + port;
        } catch (Exception e) {
            Toast.makeText(this, "本地音频服务启动失败: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }

        webView = new WebView(this);
        setContentView(webView);

        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setAllowFileAccess(true);
        ws.setAllowFileAccessFromFileURLs(true);
        ws.setAllowUniversalAccessFromFileURLs(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient());
        webView.addJavascriptInterface(new AndroidBridge(), "AndroidMusic");
        webView.loadUrl("file:///android_asset/web/index.html");
    }

    private class AndroidBridge {
        @JavascriptInterface
        public String getProxyBase() {
            return proxyBase;
        }

        @JavascriptInterface
        public void updateNowPlaying(String title, String artist, boolean playing) {
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(MainActivity.this, PlaybackKeepAliveService.class);
                    i.putExtra("title", title != null ? title : "无损音乐");
                    i.putExtra("artist", artist != null ? artist : "SQ 无损 FLAC");
                    i.putExtra("playing", playing);
                    if (playing && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        startForegroundService(i);
                    } else {
                        startService(i);
                    }
                } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public boolean downloadAudio(String url, String fileName, String title) {
            try {
                String rawSafe = fileName.replaceAll("[<>:\"/\\\\|?*\\x00-\\x1f]", "_").trim();
                final String safeName = rawSafe.isEmpty() ? "lossless_audio.flac" : rawSafe;
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm == null) return false;

                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                req.setTitle(title != null && !title.isEmpty() ? title : safeName);
                req.setDescription("正在下载无损音乐到 Music/无损音乐");
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_MUSIC, "无损音乐/" + safeName);
                req.addRequestHeader("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36");
                dm.enqueue(req);
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "已开始下载到手机 Music/无损音乐/" + safeName, Toast.LENGTH_SHORT).show());
                return true;
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "下载失败: " + e.getMessage(), Toast.LENGTH_SHORT).show());
                return false;
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null) {
            webView.evaluateJavascript("window.__handleAndroidBack && window.__handleAndroidBack()", value -> {
                if (!"true".equals(value)) {
                    runOnUiThread(MainActivity.super::onBackPressed);
                }
            });
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        try {
            stopService(new Intent(this, PlaybackKeepAliveService.class));
        } catch (Exception ignored) {}
        if (musicServer != null) musicServer.stop();
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
