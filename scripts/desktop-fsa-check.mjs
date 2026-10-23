/* 验证 Electron 中 showDirectoryPicker 是否真的会挂起等待用户选择（而不是直接 reject）
 * 判定：调用后 3 秒内既不 resolve 也不 reject => 系统目录选择框已弹出，正在等用户操作
 */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'

async function availablePort() {
  const probe = createServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

const electronPath = process.argv[2] || (await import('electron')).default
const isPackaged = !!process.argv[2]
const PORT = await availablePort()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PROFILE = resolve('.qa', `desktop-fsa-${Date.now()}`)
mkdirSync(PROFILE, { recursive: true })
let originPort = await availablePort()
while (originPort === PORT) originPort = await availablePort()
writeFileSync(resolve(PROFILE, 'desktop-origin.json'), JSON.stringify({ port: originPort }))
console.log('测试数据目录（保留）:', PROFILE)

const childEnv = { ...process.env }
delete childEnv.ELECTRON_RUN_AS_NODE

const proc = spawn(
  electronPath,
  [...(isPackaged ? [] : ['.']), `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`],
  { cwd: resolve('.'), stdio: 'ignore', env: childEnv },
)

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
  async eval(expression, userGesture = false) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: false, returnByValue: true, userGesture })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }
}

let ok = false
try {
  let target = null
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'))
      if (target?.webSocketDebuggerUrl) break
    } catch {
      /* 等待 */
    }
    await sleep(300)
  }
  if (!target) throw new Error('未找到窗口')

  const cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')

  for (let i = 0; i < 40; i++) {
    const ready = await cdp.eval(`!!document.querySelector('.sidebar')`).catch(() => false)
    if (ready) break
    await sleep(250)
  }

  // 发起调用（带用户手势），结果写到 window.__fsa
  await cdp.eval(
    `(() => {
      window.__fsa = 'pending'
      try {
        const p = window.showDirectoryPicker({ mode: 'read' })
        p.then(() => { window.__fsa = 'resolved' })
         .catch((e) => { window.__fsa = 'rejected:' + (e && e.name) + ':' + (e && e.message) })
      } catch (e) {
        window.__fsa = 'throw:' + (e && e.name) + ':' + (e && e.message)
      }
      return true
    })()`,
    true,
  )

  await sleep(3000)
  const state = await cdp.eval(`window.__fsa`)
  console.log('showDirectoryPicker 调用结果:', state)

  if (state === 'pending') {
    console.log('✓ 目录选择请求保持等待，未立即失败；此检查不验证实际选取目录')
    ok = true
  } else if (String(state).startsWith('rejected:NotAllowedError')) {
    console.log('✗ 请求被用户手势校验拦下，本次未验证目录选择')
  } else if (String(state).startsWith('rejected:AbortError')) {
    console.log('✗ 目录选择已取消，本次未完成选择验证')
  } else {
    console.log('✗ 异常结果，需要改用 IPC 方案')
  }
} catch (e) {
  console.error('测试失败:', e.message)
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
  process.exitCode = ok ? 0 : 1
}
