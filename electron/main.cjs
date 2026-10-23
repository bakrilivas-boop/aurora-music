/* Aurora Music: stable local origin, isolated renderer and native desktop controls. */
const { app, BrowserWindow, shell, dialog, Menu, session, ipcMain, Tray, screen, safeStorage, net } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { createMetadata } = require('./metadata.cjs')
const { createDeepSeekAI } = require('./deepseek-ai.cjs')
const { createPlaylistSources } = require('./playlist-sources.cjs')
const { createDownloadQueue } = require('./download-queue.cjs')
const { createMusicMirror, DEFAULT_ENDPOINT } = require('./music-mirror.cjs')
const { createPreferences } = require('./preferences.cjs')
const { createNativeLibrary } = require('./native-library.cjs')

app.setName('Aurora Music')
if (process.platform === 'win32') app.setAppUserModelId('com.aurora.music')
const profile = app.commandLine.getSwitchValue('user-data-dir')
if (profile) app.setPath('userData', path.resolve(profile))
const ROOT = app.getAppPath()
const DIST = path.join(ROOT, 'dist')
const INDEX = path.join(DIST, 'index.html')
const dataFile = (name) => path.join(app.getPath('userData'), name)
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' }
let server, win, tray, downloads, preferences, nativeLibrary
let libraryUpdateTimer
let baseUrl = ''
let playback = { title: '', artist: '', playing: false }
let downloadsClosed = false

function readJSON(name) {
  try { return JSON.parse(fs.readFileSync(dataFile(name), 'utf8')) } catch { return null }
}
function writeJSON(name, value) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(dataFile(name), JSON.stringify(value), 'utf8')
}
function libraryPort() {
  const saved = readJSON('desktop-origin.json')?.port
  if (Number.isInteger(saved) && saved > 1023 && saved < 65536) return saved
  // Adopt the latest old library origin once, keeping existing IndexedDB reachable.
  try {
    const dir = dataFile('IndexedDB')
    const old = fs.readdirSync(dir).map((name) => ({ name, port: Number(name.match(/^http_127\.0\.0\.1_(\d+)\.indexeddb\.leveldb$/)?.[1]) }))
      .filter((item) => item.port > 1023 && item.port < 65536)
      .sort((a, b) => fs.statSync(path.join(dir, b.name)).mtimeMs - fs.statSync(path.join(dir, a.name)).mtimeMs)
    if (old.length) return old[0].port
  } catch { /* first launch */ }
  return 47831
}
function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const headers = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; frame-ancestors 'none'" }
      if (req.headers.host !== new URL(baseUrl).host || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(403, headers); res.end(); return }
      let pathname
      try { pathname = decodeURIComponent(new URL(req.url, baseUrl).pathname) } catch { res.writeHead(400, headers); res.end(); return }
      if (pathname.startsWith('/native-audio/')) {
        if ((req.headers.origin && req.headers.origin !== new URL(baseUrl).origin) || req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403, headers); res.end(); return }
        if (!nativeLibrary) { res.writeHead(404, headers); res.end(); return }
        nativeLibrary.serve(req, res, pathname.slice('/native-audio/'.length), headers)
        return
      }
      const file = path.resolve(DIST, '.' + (pathname === '/' ? '/index.html' : pathname))
      const relative = path.relative(DIST, file)
      if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403, headers); res.end(); return }
      fs.readFile(file, (error, data) => {
        res.writeHead(error ? 404 : 200, { ...headers, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
        res.end(req.method === 'HEAD' ? undefined : error ? 'Not found' : data)
      })
    })
    server.once('error', reject)
    const port = libraryPort()
    server.listen(port, '127.0.0.1', () => {
      baseUrl = 'http://127.0.0.1:' + port + '/'
      writeJSON('desktop-origin.json', { port })
      resolve()
    })
  })
}
function showWindow() {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
function command(action) {
  if (win && !win.isDestroyed()) win.webContents.send('desktop:command', action)
}
function updateTray() {
  if (!tray) return
  tray.setToolTip(playback.title ? (playback.title + ' · ' + playback.artist).slice(0, 120) : 'Aurora Music · 本地音乐播放器')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: playback.title || 'Aurora Music', enabled: false },
    { label: '打开播放器', click: showWindow },
    { type: 'separator' },
    { label: playback.playing ? '暂停' : '播放', click: () => command('togglePlay') },
    { label: '上一首', click: () => command('prev') },
    { label: '下一首', click: () => command('next') },
    { type: 'separator' },
    { label: '导入音乐文件夹', click: () => { showWindow(); void win.webContents.executeJavaScript("document.querySelector('[data-import-folder]')?.click()", true) } },
    { label: '设置', click: () => { showWindow(); command('settings') } },
    { label: '隐藏到托盘', click: () => win?.hide() },
    { type: 'separator' },
    { label: '退出 Aurora Music', click: () => app.quit() },
  ]))
}
function trusted(event) { return win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url.startsWith(baseUrl) }
function permissionAllowed(contents, permission, details, origin) {
  if (!win || contents !== win.webContents || !contents.getURL().startsWith(baseUrl)) return false
  if (origin && origin !== new URL(baseUrl).origin && origin !== baseUrl) return false
  if (details.requestingUrl && !details.requestingUrl.startsWith(baseUrl)) return false
  // Chromium reports isMainFrame=false for fileSystem. The picker scopes handles;
  // allow only read access from our own window, never write/microphone/camera access.
  if (permission === 'fileSystem') return details.fileAccessType === 'readable'
  return permission === 'fullscreen' && details.isMainFrame !== false
}
function bindIPC() {
  preferences = createPreferences(dataFile('settings.json'))
  const downloadConfig = readJSON('downloads.json') || {}
  const directories = new Set((Array.isArray(downloadConfig.directories) ? downloadConfig.directories : []).filter((dir) => typeof dir === 'string' && path.isAbsolute(dir)).slice(0, 100))
  nativeLibrary = createNativeLibrary({ directories: () => [...directories] })
  let lastCompleted = 0
  const metadata = createMetadata({ cacheDir: dataFile('metadata-cache') })
  const ai = createDeepSeekAI({ configPath: dataFile('deepseek-config.json'), secureStorage: safeStorage, fetchImpl: (url, options) => net.fetch(url, options) })
  // 备用音源解析：官方匿名接口给不出地址时按歌曲编号兜底取直链，可随时在下载面板开关。
  const mirrorConfig = readJSON('music-mirror.json') || {}
  const mirror = createMusicMirror({
    endpoint: typeof mirrorConfig.endpoint === 'string' ? mirrorConfig.endpoint : DEFAULT_ENDPOINT,
    enabled: mirrorConfig.enabled !== false,
    fetchImpl: (url, options) => net.fetch(url, options),
  })
  const sources = createPlaylistSources({ fetchImpl: (url, options) => net.fetch(url, options), mirror })
  const previewTracks = new Map()
  let previewBusy = false
  downloads = createDownloadQueue({ sources, fetchImpl: (url, options) => net.fetch(url, options), attemptRestricted: () => mirror.enabled, onUpdate: (value) => {
    if (win && !win.isDestroyed()) win.webContents.send('desktop:downloads', value)
    if (value.completed !== lastCompleted) {
      lastCompleted = value.completed
      clearTimeout(libraryUpdateTimer)
      libraryUpdateTimer = setTimeout(() => {
        if (win && !win.isDestroyed()) win.webContents.send('desktop:library-changed')
      }, 250)
    }
  } })
  const savedDirectory = readJSON('downloads.json')?.directory
  const initialDirectory = typeof savedDirectory === 'string' && path.isAbsolute(savedDirectory) ? savedDirectory : path.join(app.getPath('music'), 'Aurora Music')
  try { fs.mkdirSync(initialDirectory, { recursive: true }); downloads.setDirectory(initialDirectory); directories.add(initialDirectory) } catch { /* A new folder can be chosen from the UI. */ }
  ipcMain.on('desktop:settings-read', (event) => { event.returnValue = trusted(event) ? preferences.read() : {} })
  ipcMain.on('desktop:settings-write', (event, value) => {
    try {
      if (!trusted(event)) throw new Error('请求来源无效')
      event.returnValue = preferences.save(value)
    } catch { event.returnValue = { ok: false, message: '设置未能保存，请检查本机配置目录权限' } }
  })
  ipcMain.handle('desktop:native-library', (event) => {
    if (!trusted(event)) throw new Error('请求来源无效')
    return nativeLibrary.list()
  })
  ipcMain.handle('desktop:info', (event) => trusted(event) ? { version: app.getVersion(), maximized: win.isMaximized() } : null)
  ipcMain.handle('desktop:metadata', (event, input) => trusted(event) ? metadata.lookup(input) : null)
  ipcMain.handle('desktop:ai-info', (event) => trusted(event) ? ai.info() : null)
  ipcMain.handle('desktop:ai-configure', (event, input) => {
    if (!trusted(event)) throw new Error('请求来源无效')
    return ai.configure(input)
  })
  ipcMain.handle('desktop:ai-recommend', (event, input) => {
    if (!trusted(event)) throw new Error('请求来源无效')
    return ai.recommend(input)
  })
  ipcMain.handle('desktop:mirror-info', (event) => trusted(event) ? mirror.info() : null)
  ipcMain.handle('desktop:mirror-configure', (event, input) => {
    if (!trusted(event)) throw new Error('请求来源无效')
    if (!input || typeof input !== 'object') throw new Error('音源解析设置无效')
    const value = mirror.configure({
      enabled: input.enabled === undefined ? undefined : input.enabled === true,
      endpoint: typeof input.endpoint === 'string' && input.endpoint.trim() ? input.endpoint.trim() : undefined,
    })
    writeJSON('music-mirror.json', value)
    return value
  })
  ipcMain.handle('desktop:playlist-preview', async (event, input) => {
    if (!trusted(event)) throw new Error('请求来源无效')
    if (previewBusy) throw new Error('正在读取歌单，请稍候')
    previewBusy = true
    try {
      const result = await sources.list(input)
      previewTracks.clear()
      for (const track of result.tracks) previewTracks.set(track.source + ':' + track.id, track)
      return result
    } finally { previewBusy = false }
  })
  ipcMain.handle('desktop:download-info', (event) => trusted(event) ? downloads.snapshot() : null)
  ipcMain.handle('desktop:download-directory', async (event) => {
    if (!trusted(event)) throw new Error('请求来源无效')
    const selected = await dialog.showOpenDialog(win, { title: '选择歌曲下载保存目录', defaultPath: downloads.snapshot().directory || app.getPath('music'), properties: ['openDirectory', 'createDirectory'] })
    if (selected.canceled || !selected.filePaths[0]) return downloads.snapshot()
    const value = downloads.setDirectory(selected.filePaths[0])
    directories.add(value.directory)
    writeJSON('downloads.json', { directory: value.directory, directories: [...directories].slice(-100) })
    win.webContents.send('desktop:library-changed')
    return value
  })
  ipcMain.handle('desktop:download-enqueue', (event, input) => {
    if (!trusted(event)) throw new Error('请求来源无效')
    if (!Array.isArray(input?.tracks) || !input.tracks.length || input.tracks.length > 1000) throw new Error('每次请选择 1 至 1000 首歌曲')
    const tracks = input.tracks.map((track) => {
      const known = previewTracks.get(track?.source + ':' + track?.id)
      if (!known) throw new Error('歌单预览已改变，请重新读取后下载')
      return known
    })
    return downloads.enqueue(tracks)
  })
  ipcMain.handle('desktop:download-cancel', (event, id) => {
    if (!trusted(event) || typeof id !== 'string') throw new Error('下载任务无效')
    return downloads.cancel(id)
  })
  ipcMain.handle('desktop:download-retry', (event, id) => {
    if (!trusted(event) || typeof id !== 'string') throw new Error('下载任务无效')
    return downloads.retry(id)
  })
  ipcMain.handle('desktop:download-open', async (event) => {
    if (!trusted(event)) throw new Error('请求来源无效')
    const directory = downloads.snapshot().directory
    if (!directory) throw new Error('请先选择保存目录')
    if (await shell.openPath(directory)) throw new Error('无法打开保存目录')
  })
  ipcMain.handle('desktop:window', (event, action) => {
    if (!trusted(event)) return
    if (action === 'minimize') win.minimize()
    else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize()
    else if (action === 'close') win.close()
  })
  ipcMain.on('desktop:playback', (event, value) => {
    if (!trusted(event) || !value || typeof value !== 'object') return
    playback = { title: String(value.title || '').slice(0, 160), artist: String(value.artist || '').slice(0, 160), playing: value.playing === true }
    win.setTitle(playback.title ? playback.title + ' · ' + playback.artist + ' — Aurora Music' : 'Aurora Music')
    updateTray()
  })
}
async function createWindow() {
  const stored = readJSON('window-state.json')
  const saved = stored && Number.isFinite(stored.width) && Number.isFinite(stored.height) ? stored : null
  const validPosition = saved && screen.getAllDisplays().some(({ workArea: a }) => saved.x + saved.width > a.x + 80 && saved.x < a.x + a.width - 80 && saved.y + saved.height > a.y + 80 && saved.y < a.y + a.height - 80)
  win = new BrowserWindow({
    width: Math.max(900, Math.min(2560, saved?.width || 1440)), height: Math.max(620, Math.min(1600, saved?.height || 900)),
    ...(validPosition ? { x: saved.x, y: saved.y } : {}),
    minWidth: 900, minHeight: 620, frame: false, backgroundColor: '#0c0c11', title: 'Aurora Music', show: false,
    icon: path.join(ROOT, 'build/icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  })
  if (saved?.maximized) win.maximize()
  win.once('ready-to-show', showWindow)
  const emitState = () => win.webContents.send('desktop:state', { maximized: win.isMaximized() })
  win.on('maximize', emitState)
  win.on('unmaximize', emitState)
  win.on('close', (event) => {
    try { preferences?.flush() } catch {
      event.preventDefault()
      dialog.showErrorBox('设置保存失败', '未能写入本机设置，请检查配置目录权限或磁盘空间后重试退出。')
      return
    }
    try { writeJSON('window-state.json', { ...win.getNormalBounds(), maximized: win.isMaximized() }) } catch { /* allow exit */ }
  })
  win.on('closed', () => { win = null })
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(baseUrl)) event.preventDefault() })
  win.webContents.on('render-process-gone', (_event, details) => {
    void dialog.showMessageBox({ type: 'error', title: 'Aurora Music', message: '播放界面异常退出', detail: '原因：' + details.reason + '。音乐库保留在本机，请重启播放器。', buttons: ['关闭'] }).then(() => app.quit())
  })
  await win.loadURL(baseUrl)
}
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', showWindow)
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    if (!fs.existsSync(INDEX)) throw new Error('缺少 dist/index.html，请先运行 npm run build。')
    await startServer()
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(permissionAllowed(contents, permission, details)))
    session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) => permissionAllowed(contents, permission, details, origin))
    bindIPC()
    await createWindow()
    tray = new Tray(path.join(ROOT, 'build/icon.png'))
    tray.on('double-click', showWindow)
    tray.on('click', showWindow)
    updateTray()
    app.on('activate', showWindow)
  }).catch((error) => {
    dialog.showErrorBox('Aurora Music 启动失败', error.code === 'EADDRINUSE' ? '音乐库使用的本地端口已被占用。请关闭另一个播放器实例或占用该端口的程序后重试。为保护音乐库，应用没有切换到其他端口。' : error.message)
    app.quit()
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    try { preferences?.flush() } catch { event.preventDefault(); dialog.showErrorBox('设置保存失败', '未能写入本机设置，请检查配置目录权限或磁盘空间。'); return }
    if (downloads && !downloadsClosed) {
      event.preventDefault()
      void downloads.close().finally(() => { downloadsClosed = true; app.quit() })
      return
    }
    clearTimeout(libraryUpdateTimer); tray?.destroy(); server?.close()
  })
  app.on('web-contents-created', (_event, contents) => contents.on('will-attach-webview', (event) => event.preventDefault()))
}
