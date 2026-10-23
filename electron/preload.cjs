const { contextBridge, ipcRenderer } = require('electron')
const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}
contextBridge.exposeInMainWorld('auroraDesktop', {
  info: () => ipcRenderer.invoke('desktop:info'),
  settingsRead: () => ipcRenderer.sendSync('desktop:settings-read'),
  settingsWrite: (value) => ipcRenderer.sendSync('desktop:settings-write', value),
  nativeLibrary: () => ipcRenderer.invoke('desktop:native-library'),
  onLibraryChanged: (callback) => subscribe('desktop:library-changed', callback),
  metadata: (input) => ipcRenderer.invoke('desktop:metadata', input),
  aiRecommend: (input) => ipcRenderer.invoke('desktop:ai-recommend', input),
  aiInfo: () => ipcRenderer.invoke('desktop:ai-info'),
  aiConfigure: (input) => ipcRenderer.invoke('desktop:ai-configure', input),
  playlistPreview: (url) => ipcRenderer.invoke('desktop:playlist-preview', url),
  mirrorInfo: () => ipcRenderer.invoke('desktop:mirror-info'),
  mirrorConfigure: (input) => ipcRenderer.invoke('desktop:mirror-configure', input),
  downloadInfo: () => ipcRenderer.invoke('desktop:download-info'),
  chooseDownloadDirectory: () => ipcRenderer.invoke('desktop:download-directory'),
  enqueueDownloads: (input) => ipcRenderer.invoke('desktop:download-enqueue', input),
  cancelDownload: (id) => ipcRenderer.invoke('desktop:download-cancel', id),
  retryDownload: (id) => ipcRenderer.invoke('desktop:download-retry', id),
  openDownloadsFolder: () => ipcRenderer.invoke('desktop:download-open'),
  onDownloads: (callback) => subscribe('desktop:downloads', callback),
  window: (action) => ipcRenderer.invoke('desktop:window', action),
  playback: (value) => ipcRenderer.send('desktop:playback', value),
  onState: (callback) => subscribe('desktop:state', callback),
  onCommand: (callback) => subscribe('desktop:command', callback),
})
