/* 通过 CDP 驱动 Chrome：等待页面就绪 → 截图 → 实测播放链路 */
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
const URL_ARG = process.argv[2] || 'http://127.0.0.1:5273/?demo=1'
const OUT = process.argv[3] || 'shots'
const VW = +(process.argv[4] || 1680)
const VH = +(process.argv[5] || 1000)
mkdirSync(OUT, { recursive: true })

const PROFILE = resolve('.qa', `chrome-e2e-${Date.now()}`)
mkdirSync(PROFILE, { recursive: true })
console.log('测试数据目录（保留）:', PROFILE)
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=Translate,MediaRouter',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    `--window-size=${VW},${VH}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* 等待端口就绪 */
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
      this.ws.onerror = (e) => rej(e)
    })
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: rs, reject: rj } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) rj(new Error(msg.error.message))
        else rs(msg.result)
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
  async eval(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''))
    return r.result.value
  }
  async shot(path) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(path, Buffer.from(r.data, 'base64'))
    return path
  }
}

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`)
}

try {
  const wsUrl = await getTarget()
  const cdp = new CDP(wsUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VW,
    height: VH,
    deviceScaleFactor: 1,
    mobile: false,
  })

  const consoleErrors = []
  cdp.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text))
    }
  })

  await cdp.send('Page.navigate', { url: URL_ARG })

  // 等待应用就绪（loading 消失 且 曲目渲染出来）
  let ready = false
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    try {
      const state = await cdp.eval(`(() => {
        const rows = document.querySelectorAll('.track-row').length
        const loading = !!document.querySelector('.content .spinner')
        const err = document.querySelector('#root')?.innerText?.slice(0,120) || ''
        return { rows, loading, err }
      })()`)
      if (!state.loading && state.rows > 0) {
        ready = true
        record('页面加载并渲染曲目', true, state)
        break
      }
    } catch {
      /* 页面可能还在导航 */
    }
  }
  if (!ready) {
    record('页面加载并渲染曲目', false, await cdp.eval(`document.body.innerText.slice(0,300)`))
  }

  await sleep(600)
  await cdp.shot(resolve(OUT, 'library.png'))
  record('截图 library', true)

  // 等待后台时长补全
  for (let i = 0; i < 40; i++) {
    const done = await cdp.eval(
      `[...document.querySelectorAll('.t-dur')].filter(e=>e.textContent.trim()!=='--:--').length`,
    )
    if (done >= 5) break
    await sleep(250)
  }

  // 校验解析结果（标签/文件名推断 + 时长分析）
  const tracks = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('.track-row')].map(r => ({
      title: r.querySelector('.t-title')?.childNodes[0]?.textContent?.trim(),
      artist: r.querySelector('.t-artist')?.textContent?.trim(),
      dur: r.querySelector('.t-dur')?.textContent?.trim(),
    }))
    return { rows, rowHeight: Math.round(document.querySelector('.track-row')?.getBoundingClientRect().height || 0) }
  })()`)
  const rows = tracks.rows
  record('曲目列表解析', rows.length >= 5, { ...tracks })

  const guessed = rows.every((t) => t.artist && t.artist !== '未知艺术家')
  record('文件名推断艺术家', guessed)
  const withDuration = rows.filter((t) => t.dur && t.dur !== '--:--').length
  record('时长解析/后台补全', withDuration >= 5, `${withDuration}/5`)

  // 播放第一首
  await cdp.eval(`document.querySelector('.ctrl-play').click(); true`)
  await sleep(2500)

  const playState = await cdp.eval(`(() => {
    const a = document.querySelector('audio')
    return {
      paused: a.paused,
      currentTime: +a.currentTime.toFixed(2),
      duration: +(a.duration || 0).toFixed(2),
      src: (a.currentSrc || '').slice(0, 24),
      title: document.querySelector('.pb-title')?.textContent?.trim(),
      playingClass: !!document.querySelector('.track-row.playing'),
      volumeRailW: Math.round(document.querySelector('.volume-rail')?.getBoundingClientRect().width || 0),
      playerOverflow: Math.round(
        (document.querySelector('.pb-right')?.getBoundingClientRect().right || 0) -
          (document.querySelector('.playerbar')?.getBoundingClientRect().right || 0),
      ),
    }
  })()`)
  record('播放推进', playState.currentTime > 0.6, playState)
  record('播放态 UI 标记', playState.playingClass)

  await cdp.shot(resolve(OUT, 'playing.png'))

  // 打开正在播放（歌词页）
  await cdp.eval(`document.querySelector('.ctrl[title="歌词 / 正在播放"]').click(); true`)
  await sleep(1600)
  const np = await cdp.eval(`(() => {
    const wrap = document.querySelector('.np-lyrics-wrap')
    const list = document.querySelector('.np-lyrics')
    const active = document.querySelector('.lyric-line.active')
    return {
      open: !!document.querySelector('.now-playing'),
      lines: document.querySelectorAll('.lyric-line').length,
      active: document.querySelectorAll('.lyric-line.active').length,
      activeText: active?.textContent?.trim() || '',
      transform: list?.style.transform || '',
      bodyH: Math.round(document.querySelector('.np-body')?.getBoundingClientRect().height || 0),
      wrapH: Math.round(wrap?.clientHeight || 0),
      listH: Math.round(list?.getBoundingClientRect().height || 0),
      activeTop: Math.round(active?.offsetTop ?? -1),
      activeViewportCenter: Math.round(
        active ? active.getBoundingClientRect().top + active.offsetHeight / 2 - wrap.getBoundingClientRect().top : -1,
      ),
    }
  })()`)
  record('正在播放页 + 歌词滚动', np.open && np.lines > 0 && np.activeText.length > 0, np)
  await cdp.shot(resolve(OUT, 'nowplaying.png'))

  // 关闭歌词页 → 专辑页
  await cdp.eval(`document.querySelector('.np-close').click(); true`)
  await sleep(400)
  await cdp.eval(`[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.includes('专辑')).click(); true`)
  await sleep(900)
  const albums = await cdp.eval(`document.querySelectorAll('.album-card').length`)
  record('专辑视图渲染', albums > 0, albums)
  await cdp.shot(resolve(OUT, 'albums.png'))

  // 设置 / 均衡器
  await cdp.eval(`[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.includes('设置')).click(); true`)
  await sleep(700)
  const eq = await cdp.eval(`(() => ({
    open: !!document.querySelector('.modal'),
    bands: document.querySelectorAll('.eq-band input[type=range]').length,
    presets: document.querySelectorAll('.preset-row .chip').length,
    sliderBox: (() => {
      const r = document.querySelector('.eq-band input[type=range]').getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height) }
    })(),
    rowHeight: Math.round(document.querySelector('.track-row')?.getBoundingClientRect().height || 0),
  }))()`)
  record('设置面板 + 10 段均衡器', eq.open && eq.bands === 10 && eq.presets >= 6, eq)
  await cdp.shot(resolve(OUT, 'settings.png'))

  // 拖一个均衡器滑块，验证 Web Audio 图建立且不报错
  const eqApplied = await cdp.eval(`(() => {
    const input = document.querySelectorAll('.eq-band input[type=range]')[0]
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '8')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await sleep(500)
  record('均衡器交互', eqApplied)

  // 切歌 + 队列
  await cdp.eval(`document.querySelector('.modal .ctrl[title="关闭"]').click(); true`)
  await sleep(300)
  await cdp.eval(`document.querySelector('.ctrl[title="下一首"]').click(); true`)
  await sleep(1200)
  const afterNext = await cdp.eval(`(() => ({
    title: document.querySelector('.pb-title')?.textContent?.trim(),
    t: +(document.querySelector('audio').currentTime || 0).toFixed(2),
  }))()`)
  record('切歌', afterNext.title !== playState.title, { before: playState.title, after: afterNext.title })

  await cdp.eval(`document.querySelector('.ctrl[title="播放队列"]').click(); true`)
  await sleep(600)
  const queue = await cdp.eval(`document.querySelectorAll('.q-item').length`)
  record('播放队列面板', queue >= 5, queue)
  await cdp.shot(resolve(OUT, 'queue.png'))

  // 收藏 + 搜索
  await cdp.eval(`document.querySelector('.queue-drawer .ctrl[title="关闭"]').click(); true`)
  await sleep(300)
  await cdp.eval(`[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.includes('歌曲库')).click(); true`)
  await sleep(400)
  await cdp.eval(`document.querySelector('.track-row .t-btn').click(); true`)
  await sleep(400)
  const favCount = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('.nav-item')].find(b=>b.textContent.includes('我的收藏'))
    return el?.querySelector('.count')?.textContent || '0'
  })()`)
  record('收藏按钮', favCount === '1', favCount)

  await cdp.eval(`(() => {
    const input = document.querySelector('.search-box input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '潮汐')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(600)
  const searched = await cdp.eval(`[...document.querySelectorAll('.track-row')].map(r=>r.querySelector('.t-title')?.childNodes[0]?.textContent?.trim())`)
  record('搜索过滤', searched.length === 1 && searched[0].includes('潮汐'), searched)

  // ---- 清空搜索 ----
  await cdp.eval(`(() => {
    const input = document.querySelector('.search-box input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(350)

  // ---- 进度条点击跳转 ----
  const seek = await cdp.eval(`(async () => {
    const rail = document.querySelector('.progress-rail')
    const r = rail.getBoundingClientRect()
    const opts = { clientX: r.left + r.width * 0.45, clientY: r.top + 8, pointerId: 1, bubbles: true }
    rail.dispatchEvent(new PointerEvent('pointerdown', opts))
    rail.dispatchEvent(new PointerEvent('pointerup', opts))
    await new Promise((res) => setTimeout(res, 420))
    const a = document.querySelector('audio')
    return { t: +a.currentTime.toFixed(2), d: +(a.duration || 0).toFixed(2) }
  })()`)
  record('进度条点击跳转', seek.t > seek.d * 0.3 && seek.t < seek.d * 0.75, seek)

  // ---- 快捷键：空格暂停 ----
  const space = await cdp.eval(`(async () => {
    const before = document.querySelector('audio').paused
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    await new Promise((res) => setTimeout(res, 400))
    return { before, after: document.querySelector('audio').paused }
  })()`)
  record('空格键暂停/恢复', space.before !== space.after, space)

  // ---- 右键菜单 ----
  const ctx = await cdp.eval(`(async () => {
    const row = document.querySelectorAll('.track-row')[2]
    const r = row.getBoundingClientRect()
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 300, clientY: r.top + 10 }))
    await new Promise((res) => setTimeout(res, 250))
    const menu = document.querySelector('.context-menu')
    return { menu: !!menu, items: [...(menu?.querySelectorAll('.cm-item') || [])].map((b) => b.textContent.trim()) }
  })()`)
  record('右键上下文菜单', ctx.menu && ctx.items.length >= 5, ctx.items)

  // ---- 通过菜单加入队列 ----
  const queueAdd = await cdp.eval(`(async () => {
    const m = await import('/src/lib/store.ts')
    m.usePlayer.setState({ queue: [] })
    await new Promise((res) => setTimeout(res, 150))
    const row = document.querySelectorAll('.track-row')[1]
    const r = row.getBoundingClientRect()
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 300, clientY: r.top + 10 }))
    await new Promise((res) => setTimeout(res, 250))
    const btn = [...document.querySelectorAll('.context-menu .cm-item')].find((b) => b.textContent.includes('加入播放队列'))
    btn?.click()
    await new Promise((res) => setTimeout(res, 300))
    document.querySelector('.ctrl[title="播放队列"]').click()
    await new Promise((res) => setTimeout(res, 450))
    const n = document.querySelectorAll('.q-item').length
    document.querySelector('.queue-drawer .ctrl[title="关闭"]').click()
    await new Promise((res) => setTimeout(res, 250))
    return n
  })()`)
  record('菜单加入播放队列', queueAdd === 1, queueAdd)

  // ---- 新建歌单 ----
  const pl = await cdp.eval(`(async () => {
    document.querySelector('.nav-label .row-act').click()
    await new Promise((res) => setTimeout(res, 250))
    const input = document.querySelector('.text-input')
    if (!input) return { error: 'input missing' }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '通勤歌单')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await new Promise((res) => setTimeout(res, 500))
    const rows = [...document.querySelectorAll('.playlist-row')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim())
    return { rows }
  })()`)
  record('新建歌单', Array.isArray(pl.rows) && pl.rows.some((t) => t.includes('通勤歌单')), pl)

  // ---- 通过右键菜单把曲目加入歌单，并进入歌单查看 ----
  const plAdd = await cdp.eval(`(async () => {
    const row = document.querySelectorAll('.track-row')[0]
    const r = row.getBoundingClientRect()
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 300, clientY: r.top + 10 }))
    await new Promise((res) => setTimeout(res, 250))
    const item = [...document.querySelectorAll('.context-menu .cm-item')].find((b) => b.textContent.trim() === '通勤歌单')
    item?.click()
    await new Promise((res) => setTimeout(res, 400))
    const target = [...document.querySelectorAll('.playlist-row')].find((r) => r.innerText.includes('通勤歌单'))
    target?.click()
    await new Promise((res) => setTimeout(res, 500))
    return {
      rows: document.querySelectorAll('.track-row').length,
      heading: document.querySelector('.page-head h1')?.textContent?.trim(),
    }
  })()`)
  record('歌单详情与曲目', plAdd.rows === 1 && plAdd.heading === '通勤歌单', plAdd)

  // ---- 刷新后持久化 ----
  await cdp.send('Page.reload')
  await sleep(1200)
  for (let i = 0; i < 40; i++) {
    const ok = await cdp.eval(`(() => !document.querySelector('.content .spinner') && !!document.querySelector('.track-row'))()`)
    if (ok) break
    await sleep(250)
  }
  const persisted = await cdp.eval(`(() => {
    const fav = [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.includes('我的收藏'))
    const pls = [...document.querySelectorAll('.playlist-row')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim())
    return { fav: fav?.querySelector('.count')?.textContent || '0', pls, rows: document.querySelectorAll('.track-row').length }
  })()`)
  record('刷新后收藏/歌单保留', persisted.fav === '1' && persisted.pls.some((t) => t.includes('通勤歌单')), persisted)

  record('控制台无报错', consoleErrors.length === 0, consoleErrors.slice(0, 4))

  console.log('\n结果汇总：')
  const failed = results.filter((r) => !r.ok)
  console.log(`${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    console.log('失败：')
    failed.forEach((f) => console.log('  ✗ ' + f.name + '  ' + JSON.stringify(f.detail)))
  }
  process.exitCode = failed.length ? 1 : 0
} catch (e) {
  console.error('E2E 失败:', e.message)
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
