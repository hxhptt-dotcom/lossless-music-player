const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('musicApp', {
  windowControl: (action) => ipcRenderer.invoke('window-control', action),
  getBootstrap: () => ipcRenderer.invoke('get-bootstrap'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  publicDiscover: (opts) => ipcRenderer.invoke('public-discover', opts),
  publicPlaylist: (opts) => ipcRenderer.invoke('public-playlist', opts),
  publicSearch: (opts) => ipcRenderer.invoke('public-search', opts),
  publicParse: (opts) => ipcRenderer.invoke('public-parse', opts),
  publicResolve: (opts) => ipcRenderer.invoke('public-resolve', opts),
  apiRequest: (opts) => ipcRenderer.invoke('api-request', opts),
  openLogin: (provider) => ipcRenderer.invoke('open-login', provider),
  logout: () => ipcRenderer.invoke('logout'),
  downloadTrack: (payload) => ipcRenderer.invoke('download-track', payload),
  chooseDownloadDir: () => ipcRenderer.invoke('choose-download-dir'),
  chooseHeroImage: () => ipcRenderer.invoke('choose-hero-image'),
  importLocalFiles: () => ipcRenderer.invoke('import-local-files'),
  importLocalFolder: () => ipcRenderer.invoke('import-local-folder'),
  removeLocalTrack: (filePath) => ipcRenderer.invoke('remove-local-track', filePath),
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  openDownloadDir: () => ipcRenderer.invoke('open-download-dir'),
  onAuthChanged: (cb) => ipcRenderer.on('auth-changed', (_e, data) => cb(data)),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (_e, data) => cb(data))
});
