/* 桌面版冒烟测试：启动 Electron，验证页面渲染、FSA/IndexedDB/WebAudio 可用、控制台无报错 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'node:net'

async function availablePort() {
  const probe = createServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

const customExe = process.argv[2]
const electronPath = customExe || (await import('electron')).default
const isPackaged = !!customExe
const PORT = await availablePort()
const OUT = 'shots'
mkdirSync(OUT, { recursive: true })
const PROFILE = resolve('.qa', `desktop-smoke-${Date.now()}`)
mkdirSync(PROFILE, { recursive: true })
let originPort = await availablePort()
while (originPort === PORT) originPort = await availablePort()
writeFileSync(resolve(PROFILE, 'desktop-origin.json'), JSON.stringify({ port: originPort }))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`)
}

console.log('启动 Electron:', electronPath)
console.log('测试数据目录（保留）:', PROFILE)
const childEnv = { ...process.env }
delete childEnv.ELECTRON_RUN_AS_NODE
const appArgs = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`]
const proc = spawn(electronPath, isPackaged ? appArgs : ['.', ...appArgs], {
  cwd: resolve('.'),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: childEnv,
})
const logs = []
proc.stdout.on('data', (d) => logs.push(String(d).trim()))
proc.stderr.on('data', (d) => logs.push(String(d).trim()))

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.events = []
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res()
      this.ws.onerror = rej
    })
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve: rs, reject: rj } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? rj(new Error(m.error.message)) : rs(m.result)
        return
      }
      this.events.push(m)
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''))
    return r.result.value
  }
}

async function findTarget() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'))
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      /* 等待 Electron 起来 */
    }
    await sleep(300)
  }
  return null
}

try {
  const target = await findTarget()
  if (!target) throw new Error('未找到 Electron 窗口的调试目标')
  record('Electron 窗口启动', true, { url: target.url, title: target.title })

  const cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  // 等界面渲染完成
  let ui = null
  for (let i = 0; i < 60; i++) {
    await sleep(300)
    ui = await cdp
      .eval(`(() => ({
        ready: !document.querySelector('.content .spinner'),
        sidebar: !!document.querySelector('.sidebar'),
        playerbar: !!document.querySelector('.playerbar'),
        brand: document.querySelector('.brand-text')?.innerText?.replace(/\\s+/g, ' ').trim() || '',
        emptyText: document.querySelector('.empty-state h2')?.textContent?.trim() || '',
      }))()`)
      .catch(() => null)
    if (ui?.ready && ui.sidebar) break
  }
  record('界面渲染完成', !!(ui && ui.sidebar && ui.playerbar), ui)

  const api = await cdp.eval(`(async () => {
    const out = {
      showDirectoryPicker: typeof window.showDirectoryPicker,
      FileSystemDirectoryHandle: typeof window.FileSystemDirectoryHandle,
      indexedDB: typeof indexedDB,
      AudioContext: typeof (window.AudioContext || window.webkitAudioContext),
      secureContext: window.isSecureContext,
      origin: location.origin,
      nodeLeak: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
    }
    // IndexedDB 实际可用性
    out.idbOpen = await new Promise((res) => {
      try {
        const req = indexedDB.open('__probe__', 1)
        req.onsuccess = () => { req.result.close(); indexedDB.deleteDatabase('__probe__'); res('ok') }
        req.onerror = () => res('error')
      } catch (e) { res('throw:' + e.message) }
    })
    // WebAudio 实际可用性
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      out.audioState = ctx.state
      await ctx.close()
    } catch (e) { out.audioState = 'throw:' + e.message }
    return out
  })()`)
  record('文件夹选择 API 可用', api.showDirectoryPicker === 'function', api)
  record('IndexedDB 可写', api.idbOpen === 'ok', api.idbOpen)
  record('WebAudio 可创建', ['running', 'suspended', 'closed'].includes(api.audioState), api.audioState)
  record('渲染进程未泄露 Node', api.nodeLeak === false, api.nodeLeak)
  const native = await cdp.eval(`(async () => ({ version: (await window.auroraDesktop.info()).version, model: (await window.auroraDesktop.aiInfo()).model, metadata: typeof window.auroraDesktop.metadata, ai: typeof window.auroraDesktop.aiRecommend, playlist: typeof window.auroraDesktop.playlistPreview, downloads: typeof window.auroraDesktop.enqueueDownloads, settings: typeof window.auroraDesktop.settingsWrite, library: typeof window.auroraDesktop.nativeLibrary }))()`)
  record('当前版本资料、设置和自动入库接口可用', native.version === JSON.parse(readFileSync('package.json', 'utf8')).version && native.model === 'deepseek-flash' && [native.metadata, native.ai, native.playlist, native.downloads, native.settings, native.library].every((value) => value === 'function'), native)

  const equalizer = await cdp.eval(`(async () => {
    document.querySelector('.playerbar button[title="均衡器"]').click()
    await new Promise(resolve => setTimeout(resolve, 80))
    return !!document.querySelector('.settings-section:not([hidden]) .eq-bands')
  })()`)
  record('播放条直接打开均衡器分类', equalizer)
  const preferences = await cdp.eval(`(async () => {
    document.querySelector('.settings-nav button').click()
    await new Promise(resolve => setTimeout(resolve, 40))
    const section = document.querySelector('.settings-section:not([hidden])')
    return { categories: document.querySelectorAll('.settings-nav button').length, appearance: !!section?.querySelector('[aria-label="减弱动态效果"]'), hiddenEQ: !section?.querySelector('.eq-bands') }
  })()`)
  record('分类设置仅显示选中内容', preferences.categories === 4 && preferences.appearance && preferences.hiddenEQ, preferences)
  const motion = await cdp.eval(`(async () => {
    document.querySelector('[aria-label="减弱动态效果"]').click()
    await new Promise(resolve => setTimeout(resolve, 60))
    return document.documentElement.dataset.reducedMotion === 'true' && window.auroraDesktop.settingsRead().reducedMotion === true
  })()`)
  record('动效偏好立即生效并保存到原生设置', motion)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
  await sleep(60)
  record('Escape 关闭设置', await cdp.eval(`!document.querySelector('.modal[role="dialog"]')`))

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(resolve(OUT, 'desktop-app.png'), Buffer.from(shot.data, 'base64'))
  record('窗口截图', true)

  const errors = cdp.events
    .filter((m) => m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
    .map((m) => m.params.args.map((a) => a.value ?? a.description).join(' '))
    .concat(
      cdp.events
        .filter((m) => m.method === 'Runtime.exceptionThrown')
        .map((m) => 'EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)),
    )
  record('无控制台报错', errors.length === 0, errors.slice(0, 3))

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exitCode = failed.length ? 1 : 0
} catch (e) {
  console.error('桌面版测试失败:', e.message)
  if (logs.length) console.error('Electron 输出:\n' + logs.slice(-12).join('\n'))
  process.exitCode = 1
} finally {
  if (proc.pid && proc.exitCode === null) {
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        const cleanup = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
        cleanup.once('error', resolve)
        cleanup.once('exit', resolve)
      })
    } else proc.kill()
  }
}
