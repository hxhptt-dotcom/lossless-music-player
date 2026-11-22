# 无损音乐播放器 (Lossless Music Player)

一款开箱即用、免登录的 Windows PC 桌面无损音乐播放器，基于 Electron 构建，支持 **SQ 无损 FLAC** 在线畅听、同步滚动歌词、一键无损下载以及本地无损文件播放。

## 核心特性

- **免登录即开即用**：打开 EXE 即可直接浏览热门精选歌单、7 大官方排行榜（新歌 / 热歌 / 飙升 / 原创 / 抖音 / 欧美 / 日语）与全网搜歌。
- **真无损 FLAC 播放与音质切换**：优先解析 `SQ 无损 FLAC` 音频流，支持 `SQ 无损 / 320K HQ / 192K / 128K` 实时切换并保留当前播放进度。
- **潮流黑胶视觉体验**：暖米白 + 玫红黑胶拼贴风格界面、6 色快捷入口、动态波形歌曲列表、深色毛玻璃浮动播控栏，以及带仿真唱臂与实时频谱的沉浸式黑胶滚动歌词页。
- **一键无损下载 & 本地离线播放**：支持自定义目录下载无损 FLAC 歌曲到本地，支持直接导入或扫描本机 `.flac / .wav / .mp3 / .m4a / .ogg` 文件离线畅听。
- **本地持久收藏 & 可选扩展源**：红心收藏与最近播放自动本地持久化保存；右上角支持按需登录切换 `74520` 多平台扩展源。

## 下载使用

前往本仓库右侧 **[Releases](https://github.com/hxhptt-dotcom/lossless-music-player/releases)** 下载便携单文件版 `无损音乐播放器.exe`，双击即可运行，无需安装任何运行环境。

## 本地开发与构建

```bash
# 安装依赖
npm install

# 开发模式启动
npm start

# 打包 Windows 单文件便携版 EXE（输出到 dist/）
npm run build
```

## 技术栈

- **桌面壳与流媒体代理**：Electron 主进程 + 本地 HTTP Range 流代理（解决防盗链、FLAC MIME 与 Web Audio 频谱跨域）
- **界面与音频引擎**：原生 HTML5 / CSS3 / ES JavaScript + Web Audio API 实时频谱
- **打包**：`electron-builder`（Windows x64 Portable 单文件）
