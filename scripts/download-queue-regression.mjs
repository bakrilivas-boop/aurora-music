import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { mock } from 'node:test'

const require = createRequire(import.meta.url)
const { createDownloadQueue } = require('../electron/download-queue.cjs')
const root = join(dirname(dirname(fileURLToPath(import.meta.url))), '.qa')
mkdirSync(root, { recursive: true })
const fixtures = mkdtempSync(join(root, 'download-queue-'))
// Synthetic MPEG-1 Layer III silence frames, written byte-for-byte through the actual filesystem.
const FRAME = Buffer.alloc(417)
FRAME.set([0xff, 0xfb, 0x90, 0xc0])
const AUDIO = Buffer.concat(Array.from({ length: 8 }, () => FRAME))
const track = (id = '1', extra = {}) => ({ source: 'netease', id, title: `歌曲${id}`, artist: '歌手', duration: 120, ...extra })
const audio = (bytes = AUDIO, headers = {}, status = 200) => new Response(bytes, { status, headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(bytes.byteLength), ...headers } })
let number = 0
function fixture({ resolve = async (item) => ({ url: `https://m801.music.126.net/${item.id}.mp3`, duration: item.duration }), fetch: fetcher = async () => audio(), onUpdate = () => {}, attemptRestricted = false } = {}) {
  const directory = join(fixtures, `case-${++number}`)
  mkdirSync(directory)
  const calls = { resolve: [], fetch: [], updates: [] }
  const queue = createDownloadQueue({ sources: { resolve: (...args) => { calls.resolve.push(args); return resolve(...args) } },
    fetchImpl: (url, options) => { calls.fetch.push({ url, options }); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual'); assert.ok(!('Cookie' in options.headers)); assert.ok(!('Authorization' in options.headers)); return fetcher(url, options) },
    attemptRestricted,
    onUpdate: (state) => { calls.updates.push({ at: Date.now(), state }); onUpdate(state) } })
  return { queue, calls, directory }
}
async function until(predicate, timeout = 4000) {
  const started = Date.now()
  while (!predicate()) { if (Date.now() - started > timeout) throw new Error('Timed out waiting for mock queue'); await delay(5) }
}
const idle = (queue) => until(() => queue.snapshot().active === 0 && queue.snapshot().tasks.every((item) => ['completed', 'skipped', 'failed', 'cancelled'].includes(item.status)))
const parts = (directory) => readdirSync(directory).filter((name) => name.endsWith('.part'))
let checks = 0
async function check(name, run) { await run(); checks++; console.log(`PASS ${name}`) }

await check('选择原生保存目录之前不联网；批次输入先完整校验', async () => {
  const { queue, calls, directory } = fixture()
  assert.throws(() => queue.enqueue([track()]), /先选择/)
  assert.throws(() => queue.setDirectory('relative-folder'), /有效/)
  queue.setDirectory(directory)
  for (const invalid of [track('1', { source: 'other' }), track('1', { url: 'https://example.com' }), track('../x'), track('1', { duration: -1 })]) {
    assert.throws(() => queue.enqueue([track(), invalid]))
  }
  assert.equal(queue.snapshot().tasks.length, 0)
  assert.equal(calls.resolve.length + calls.fetch.length, 0)
  await queue.close()
})
await check('真实写入完整音频字节，文件名清理且不暴露源URL', async () => {
  const { queue, directory } = fixture({ resolve: async () => ({ url: 'https://music.126.net/public', duration: 120, filename: '../../CON:<unsafe>|name.exe' }) })
  queue.setDirectory(directory)
  queue.enqueue([track()])
  await idle(queue)
  const state = queue.snapshot()
  assert.equal(state.completed, 1)
  assert.equal(state.tasks[0].status, 'completed')
  assert.ok(!/[<>:"/\\|?*]/.test(state.tasks[0].filename))
  assert.ok(state.tasks[0].filename.endsWith('.mp3'))
  assert.deepEqual(readFileSync(join(directory, state.tasks[0].filename)), AUDIO)
  assert.deepEqual(parts(directory), [])
  assert.ok(!JSON.stringify(state).includes('https:'))
  await queue.close()
})
await check('最大并发2，排队时禁止更换目录，批内和跨批不重复入队', async () => {
  const releases = []
  const { queue, directory, calls } = fixture({ resolve: (item) => new Promise((resolve) => releases.push(() => resolve({ url: `https://music.126.net/${item.id}`, duration: 120 }))) })
  queue.setDirectory(directory)
  queue.enqueue([track('1'), track('2'), track('3'), track('3'), track('4')])
  queue.enqueue([track('1')])
  assert.equal(queue.snapshot().tasks.length, 4)
  await until(() => releases.length === 2)
  assert.equal(queue.snapshot().active, 2)
  assert.throws(() => queue.setDirectory(directory), /等待下载/)
  releases[0]()
  await until(() => releases.length === 3)
  releases[1]()
  await until(() => releases.length === 4)
  releases[2](); releases[3]()
  await idle(queue)
  assert.equal(queue.snapshot().completed, 4)
  assert.ok(calls.updates.every(({ state }) => state.active <= 2))
  await queue.close()
})
await check('流式进度约100毫秒节流，最终进度和文件完整', async () => {
  const { queue, directory, calls } = fixture({ fetch: async () => {
    let offset = 0
    return new Response(new ReadableStream({ async pull(controller) { await delay(25); if (offset >= AUDIO.length) return controller.close(); controller.enqueue(AUDIO.subarray(offset, offset + 160)); offset += 160 } }), { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(AUDIO.length) } })
  } })
  queue.setDirectory(directory)
  queue.enqueue([track()])
  await idle(queue)
  const progress = calls.updates.filter(({ state }) => state.tasks[0]?.status === 'downloading' && state.tasks[0].receivedBytes > 0)
  assert.ok(progress.length >= 2 && progress.length < 12)
  for (let index = 1; index < progress.length; index++) assert.ok(progress[index].at - progress[index - 1].at >= 70)
  assert.equal(queue.snapshot().tasks[0].receivedBytes, AUDIO.length)
  assert.deepEqual(readFileSync(join(directory, queue.snapshot().tasks[0].filename)), AUDIO)
  await queue.close()
})
await check('取消流式下载清理本任务part，失败/取消可重试且完成项不能重试', async () => {
  let attempts = 0
  let cancelled = false
  const { queue, directory } = fixture({ fetch: async () => {
    attempts++
    if (attempts > 1) return audio()
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(AUDIO.subarray(0, 100)) }, pull() { return new Promise(() => {}) }, cancel() { cancelled = true } }), { headers: { 'Content-Type': 'audio/mpeg' } })
  } })
  queue.setDirectory(directory)
  const id = queue.enqueue([track()]).tasks[0].id
  await until(() => parts(directory).length === 1)
  queue.cancel(id)
  await idle(queue)
  assert.equal(queue.snapshot().tasks[0].status, 'cancelled')
  assert.equal(cancelled, true)
  assert.deepEqual(readdirSync(directory), [])
  queue.retry(id)
  await idle(queue)
  assert.equal(queue.snapshot().tasks[0].status, 'completed')
  assert.throws(() => queue.retry(id), /只能重试/)
  await queue.close()
})
await check('取消解析会透传AbortSignal，取消排队任务不访问来源', async () => {
  let aborts = 0
  const { queue, directory, calls } = fixture({ resolve: (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => { aborts++; reject(new Error('cancelled resolver')) }, { once: true })) })
  queue.setDirectory(directory)
  const state = queue.enqueue([track('1'), track('2'), track('3')])
  await until(() => queue.snapshot().active === 2)
  state.tasks.forEach((item) => queue.cancel(item.id))
  await idle(queue)
  assert.equal(aborts, 2)
  assert.equal(calls.resolve.length, 2)
  assert.equal(calls.fetch.length, 0)
  assert.ok(queue.snapshot().tasks.every((item) => item.status === 'cancelled'))
  await queue.close()
})
await check('允许的HTTPS CDN可逐跳重定向，无凭证；失败任务可重试', async () => {
  let first = true
  const { queue, directory, calls } = fixture({ fetch: async (url) => {
    if (first) { first = false; return new Response('denied', { status: 403 }) }
    if (url.includes('music.126.net')) return new Response(null, { status: 302, headers: { Location: 'https://dl.stream.qqmusic.qq.com/public.mp3' } })
    return audio()
  } })
  queue.setDirectory(directory)
  const id = queue.enqueue([track()]).tasks[0].id
  await idle(queue)
  assert.equal(queue.snapshot().tasks[0].status, 'failed')
  queue.retry(id)
  await idle(queue)
  assert.equal(queue.snapshot().tasks[0].status, 'completed')
  assert.equal(calls.fetch.length, 3)
  assert.ok(calls.fetch.at(-1).url.startsWith('https://dl.stream.qqmusic.qq.com/'))
  await queue.close()
})
await check('IP、私网、端口、账号凭证、伪造域名及非官方跳转被阻止', async () => {
  for (const url of ['https://127.0.0.1/a', 'https://192.168.1.1/a', 'https://[::1]/a', 'http://music.126.net/a', 'https://music.126.net:8443/a', 'https://user:password@music.126.net/a', 'https://music.126.net.evil.example/a']) {
    const { queue, directory, calls } = fixture({ resolve: async () => ({ url, duration: 120 }) })
    queue.setDirectory(directory); queue.enqueue([track()]); await idle(queue)
    assert.equal(queue.snapshot().tasks[0].status, 'failed')
    assert.equal(calls.fetch.length, 0)
    assert.deepEqual(readdirSync(directory), [])
    await queue.close()
  }
  const { queue, directory, calls } = fixture({ fetch: async () => new Response(null, { status: 302, headers: { Location: 'https://example.com/private' } }) })
  queue.setDirectory(directory); queue.enqueue([track()]); await idle(queue)
  assert.equal(queue.snapshot().tasks[0].status, 'failed')
  assert.equal(calls.fetch.length, 1)
  await queue.close()
})
await check('最多3次跳转，重定向循环不会无限请求', async () => {
  const { queue, directory, calls } = fixture({ fetch: async () => new Response(null, { status: 302, headers: { Location: '/again.mp3' } }) })
  queue.setDirectory(directory); queue.enqueue([track()]); await idle(queue)
  assert.equal(queue.snapshot().tasks[0].status, 'failed')
  assert.match(queue.snapshot().tasks[0].message, /3 次/)
  assert.equal(calls.fetch.length, 4)
  await queue.close()
})
await check('试听、受限、无链接和时长不符全部跳过，不请求媒体', async () => {
  for (const resolved of [{ preview: true, url: 'https://music.126.net/a', duration: 120 }, { reason: '公开音源受限' }, {},
    { url: 'https://music.126.net/a', duration: 30 }, { url: 'https://music.126.net/a' }]) {
    const { queue, directory, calls } = fixture({ resolve: async () => resolved })
    queue.setDirectory(directory); queue.enqueue([track()]); await idle(queue)
    assert.equal(queue.snapshot().tasks[0].status, 'skipped')
    assert.equal(calls.fetch.length, 0)
    await queue.close()
  }
  const { queue, directory, calls } = fixture()
  queue.setDirectory(directory)
  queue.enqueue(Array.from({ length: 203 }, (_, index) => track(String(index + 1), { restricted: true })))
  await idle(queue)
  assert.equal(queue.snapshot().tasks.length, 203)
  assert.ok(queue.snapshot().tasks.every((item) => item.status === 'skipped'))
  assert.equal(calls.resolve.length + calls.fetch.length, 0)
  await queue.close()
})
await check('已有文件绝不覆盖，两个同名任务竞争只保存一份', async () => {
  const first = fixture()
  writeFileSync(join(first.directory, '歌手 - 歌曲1.mp3'), 'EXISTING_MUSIC_DO_NOT_OVERWRITE')
  first.queue.setDirectory(first.directory); first.queue.enqueue([track()]); await idle(first.queue)
  assert.equal(first.queue.snapshot().tasks[0].status, 'skipped')
  assert.equal(readFileSync(join(first.directory, '歌手 - 歌曲1.mp3'), 'utf8'), 'EXISTING_MUSIC_DO_NOT_OVERWRITE')
  await first.queue.close()
  const { queue, directory } = fixture({ resolve: async () => ({ url: 'https://music.126.net/a', duration: 120, filename: 'same.mp3' }) })
  queue.setDirectory(directory); queue.enqueue([track('1'), track('2')]); await idle(queue)
  assert.equal(queue.snapshot().completed, 1)
  assert.equal(queue.snapshot().tasks.filter((item) => item.status === 'skipped').length, 1)
  assert.deepEqual(readdirSync(directory), ['same.mp3'])
  assert.deepEqual(readFileSync(join(directory, 'same.mp3')), AUDIO)
  await queue.close()
})
await check('HTML、JSON、伪音频、片段、截断以及200MiB以上声明被阻止', async () => {
  for (const fetch of [() => audio(Buffer.from('<html>not music</html>'), { 'Content-Type': 'text/html' }),
    () => audio(Buffer.from('{"error":"paywall"}'), { 'Content-Type': 'application/json' }), () => audio(Buffer.from('invalid audio content')),
    () => audio(AUDIO, {}, 206), () => audio(AUDIO, { 'Content-Length': String(AUDIO.length + 1) }),
    () => audio(AUDIO, { 'Content-Length': String(200 * 1024 * 1024 + 1) })]) {
    const { queue, directory } = fixture({ fetch })
    queue.setDirectory(directory); queue.enqueue([track()]); await idle(queue)
    assert.equal(queue.snapshot().tasks[0].status, 'failed')
    assert.deepEqual(readdirSync(directory), [])
    await queue.close()
  }
})
await check('累计1000任务上限、批次1000上限，超限保持原队列不变', async () => {
  const { queue, directory, calls } = fixture()
  queue.setDirectory(directory)
  const batch = (count, start = 1) => Array.from({ length: count }, (_, index) => track(String(index + start), { restricted: true }))
  assert.throws(() => queue.enqueue(batch(1001)), /1,000/)
  queue.enqueue(batch(900))
  assert.throws(() => queue.enqueue(batch(101, 901)), /累计/)
  assert.equal(queue.snapshot().tasks.length, 900)
  queue.enqueue(batch(100, 901))
  assert.equal(queue.snapshot().tasks.length, 1000)
  assert.equal(calls.resolve.length + calls.fetch.length, 0)
  await queue.close()
})
await check('60秒无活动超时会中止解析并释放并发位置', async () => {
  const { queue, directory } = fixture({ resolve: () => new Promise(() => {}) })
  queue.setDirectory(directory)
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    queue.enqueue([track()])
    await Promise.resolve()
    assert.equal(queue.snapshot().active, 1)
    mock.timers.tick(60001)
    for (let index = 0; index < 15; index++) await Promise.resolve()
    assert.equal(queue.snapshot().tasks[0].status, 'failed')
    assert.match(queue.snapshot().tasks[0].message, /60 秒/)
    assert.equal(queue.snapshot().active, 0)
  } finally { mock.timers.reset(); await queue.close() }
})
await check('close等待运行任务清理part、取消队列，关闭后拒绝新任务', async () => {
  const { queue, directory } = fixture({ fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(AUDIO.subarray(0, 100)) }, pull() { return new Promise(() => {}) } }), { headers: { 'Content-Type': 'audio/mpeg' } }) })
  queue.setDirectory(directory)
  queue.enqueue([track('1'), track('2'), track('3')])
  await until(() => parts(directory).length === 2)
  const final = await queue.close()
  assert.equal(final.active, 0)
  assert.ok(final.tasks.every((item) => item.status === 'cancelled'))
  assert.deepEqual(readdirSync(directory), [])
  assert.throws(() => queue.enqueue([track('4')]), /正在关闭/)
})

await check('开启备用音源后受限歌曲照常入队并落盘', async () => {
  const { queue, directory, calls } = fixture({ attemptRestricted: true, resolve: async (item) => ({ url: `https://m801.music.126.net/${item.id}.mp3`, duration: 120, mirrored: true }) })
  queue.setDirectory(directory)
  queue.enqueue([track('1', { restricted: true }), track('2', { restricted: true }), track('3')])
  await idle(queue)
  const state = queue.snapshot()
  assert.equal(state.completed, 3)
  assert.equal(calls.resolve.length, 3)
  assert.match(state.tasks[0].message, /备用音源/)
  assert.equal(readdirSync(directory).length, 3)
  await queue.close()
})

await check('备用音源开关可以是函数，关闭后受限歌曲恢复跳过', async () => {
  let enabled = false
  const { queue, directory, calls } = fixture({ attemptRestricted: () => enabled })
  queue.setDirectory(directory)
  queue.enqueue([track('1', { restricted: true })])
  await idle(queue)
  assert.equal(queue.snapshot().tasks[0].status, 'skipped')
  assert.equal(calls.resolve.length, 0)
  enabled = true
  queue.setDirectory(directory)
  queue.enqueue([track('2', { restricted: true })])
  await idle(queue)
  assert.equal(queue.snapshot().tasks[1].status, 'completed')
  assert.equal(calls.resolve.length, 1)
  await queue.close()
})

await check('QQ 音乐任意 stream 子域都算官方音频 CDN，其他域名仍被阻止', async () => {
  for (const host of ['ws.stream.qqmusic.qq.com', 'isure.stream.qqmusic.qq.com', 'aqqmusic.tc.qqmusic.qq.com']) {
    const { queue, directory } = fixture({ resolve: async () => ({ url: `https://${host}/a.mp3`, duration: 120 }) })
    queue.setDirectory(directory); queue.enqueue([track('1')]); await idle(queue)
    assert.equal(queue.snapshot().tasks[0].status, 'completed', host)
    await queue.close()
  }
  const { queue, directory, calls } = fixture({ resolve: async () => ({ url: 'https://stream.qqmusic.qq.com.evil.example/a.mp3', duration: 120 }) })
  queue.setDirectory(directory); queue.enqueue([track('1')]); await idle(queue)
  assert.equal(queue.snapshot().tasks[0].status, 'failed')
  assert.equal(calls.fetch.length, 0)
  await queue.close()
})

console.log(`Download queue regression: ${checks} checks passed (mock CDNs only; actual fixture file writes verified)`)
