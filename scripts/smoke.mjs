/* 生产包冒烟测试：确认 dist 在 preview 下正常启动、空库引导正确、无控制台报错 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'node:net'

async function availablePort() {
  const probe = createServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = await availablePort()
const URL_ARG = process.argv[2] || 'http://127.0.0.1:5274/'
const OUT = 'shots'
mkdirSync(OUT, { recursive: true })
const PROFILE = resolve('.qa', `chrome-smoke-${Date.now()}`)
mkdirSync(PROFILE, { recursive: true })
console.log('测试数据目录（保留）:', PROFILE)

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--window-size=1680,1000',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`)
}

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* 等待 */
    }
    await sleep(200)
  }
  throw new Error('DevTools 未就绪')
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
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
      }
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }
}

try {
  const cdp = new CDP(await getTarget())
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1000, deviceScaleFactor: 1, mobile: false })

  const errors = []
  cdp.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text))
    }
  })

  await cdp.send('Page.navigate', { url: URL_ARG })
  let ready = false
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    const s = await cdp.eval(`(() => ({
      loaded: !document.querySelector('.content .spinner'),
      empty: !!document.querySelector('.empty-state'),
      title: document.querySelector('.empty-state h2')?.textContent?.trim() || '',
      nav: document.querySelectorAll('.nav-item').length,
      bar: !!document.querySelector('.playerbar'),
    }))()`).catch(() => ({}))
    if (s.loaded && s.empty) {
      ready = true
      record('生产包启动并显示空库引导', s.empty && s.nav >= 5 && s.bar, s)
      break
    }
  }
  if (!ready) record('生产包启动并显示空库引导', false)

  // 确认没有 dev 演示数据被注入
  const noDemo = await cdp.eval(`document.querySelectorAll('.track-row').length`)
  record('生产包无演示数据注入', noDemo === 0, noDemo)

  // 确认 dist 资源都是 200
  const res = await cdp.eval(`(async () => {
    const url = document.querySelector('script[type=module]')?.src
    const css = document.querySelector('link[rel=stylesheet]')?.href
    const r1 = url ? await fetch(url) : null
    const r2 = css ? await fetch(css) : null
    return { js: r1?.status, css: r2?.status }
  })()`)
  record('静态资源可加载', res.js === 200 && res.css === 200, res)

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(resolve(OUT, 'empty-state.png'), Buffer.from(shot.data, 'base64'))
  record('截图空库状态', true)

  record('无控制台报错', errors.length === 0, errors.slice(0, 3))

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exitCode = failed.length ? 1 : 0
} catch (e) {
  console.error('冒烟测试失败:', e.message)
  process.exitCode = 1
} finally {
  if (chrome.pid && chrome.exitCode === null) {
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        const cleanup = spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' })
        cleanup.once('error', resolve)
        cleanup.once('exit', resolve)
      })
    } else chrome.kill()
  }
}
