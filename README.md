# 无损音乐播放器 (Lossless Music Player)

一款开箱即用、免登录的 **Windows PC 桌面端 + Android 安卓端** 无损音乐播放器，支持 **SQ 无损 FLAC** 在线畅听、同步滚动歌词与一键无损下载。

## 核心特性

- **双端覆盖（Windows + Android）**：
  - **Windows 版**：Electron 便携单文件 EXE，双击即用，支持在线无损 + 本地离线无损扫描播放。
  - **Android 版**：原生 WebView + 内置 `127.0.0.1` 无损音频代理服务 + 前台保活息屏播放 + 系统下载器直存 `Music/无损音乐/`，1:1 潮流黑胶拼贴竖屏体验。
- **免登录即开即用**：打开即可直接浏览热门精选歌单、7 大官方排行榜（新歌 / 热歌 / 飙升 / 原创 / 抖音 / 欧美 / 日语）与全网搜歌。
- **真无损 FLAC 播放与音质切换**：优先解析 `SQ 无损 FLAC` 音频流，支持 `SQ 无损 / 320K HQ / 192K / 128K` 实时切换。
- **沉浸黑胶滚动歌词**：仿真旋转黑胶唱片与唱臂、自动同步滚动歌词（点击歌词跳转进度）。
- **本地持久收藏 & 最近播放**：红心收藏与最近播放自动本地保存，重启不丢失。

## 下载使用

前往本仓库右侧 **[Releases](https://github.com/hxhptt-dotcom/lossless-music-player/releases)** 下载对应安装包：

- **Windows 电脑**：`LosslessMusicPlayer-v1.0.0-win-x64.exe`（便携单文件，双击即用）
- **Android 手机**：`LosslessMusicPlayer-v1.0.0-android.apk`（已签名，下载后直接安装）

## 本地开发与构建

### Windows PC 版
```bash
npm install
npm start       # 开发启动
npm run build   # 打包单文件便携版 EXE（输出到 dist/）
```

### Android 安卓版
推送代码至 `main` 分支后，GitHub Actions（`.github/workflows/build-android.yml`）会自动使用 JDK 17 + Gradle 8.7 编译已签名 Release APK 并同步发布到 Releases。本地有 Android SDK 时也可在 `android/` 目录执行：
```bash
gradle assembleRelease
```
