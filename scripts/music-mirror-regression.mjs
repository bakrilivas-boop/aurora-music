import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { createMusicMirror, safeAudioUrl, safeEndpoint, DEFAULT_ENDPOINT } = createRequire(import.meta.url)('../electron/music-mirror.cjs')
let checks = 0
const check = (name, fn) => { fn(); checks++; console.log(`PASS ${name}`) }
const json = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Content-Length': String(JSON.stringify(value).length) } })

check('默认接口是公网HTTPS，未配置时直接可用', () => { assert.equal(safeEndpoint(DEFAULT_ENDPOINT), DEFAULT_ENDPOINT); assert.equal(createMusicMirror({ fetchImpl: async () => json({}) }).info().enabled, true) })
for (const bad of ['http://music-api.gdstudio.xyz/api.php', 'https://127.0.0.1/api.php', 'https://localhost/api.php', 'https://10.0.0.1/api.php', 'https://user:pass@music-api.gdstudio.xyz/api.php', 'https://music-api.gdstudio.xyz:8443/api.php', 'ftp://music-api.gdstudio.xyz/api.php', '', 'not-a-url']) {
  check(`拒绝不安全接口地址 ${bad || '(空)'}`, () => assert.equal(safeEndpoint(bad), undefined))
}
for (const bad of ['http://m801.music.126.net/a.mp3', 'https://192.168.1.9/a.mp3', 'https://[::1]/a.mp3', 'https://m801.music.126.net:8080/a.mp3', 'https://token@m801.music.126.net/a.mp3', '']) {
  check(`拒绝不安全音频地址 ${bad || '(空)'}`, () => assert.equal(safeAudioUrl(bad), undefined))
}

let requested = ''
const mirror = createMusicMirror({ fetchImpl: async (raw, options) => {
  requested = String(raw)
  assert.equal(options.redirect, 'follow')
  assert.equal(options.credentials, 'omit')
  return json({ url: 'https://m701.music.126.net/2026/x.mp3', br: 320, size: 9728044 })
} })
const ok = await mirror.resolve({ source: 'netease', id: '215382', duration: 243 })
check('按平台编号请求解析接口并返回HTTPS直链', () => {
  const url = new URL(requested)
  assert.equal(url.origin + url.pathname, DEFAULT_ENDPOINT)
  assert.equal(url.searchParams.get('types'), 'url')
  assert.equal(url.searchParams.get('source'), 'netease')
  assert.equal(url.searchParams.get('id'), '215382')
  assert.equal(url.searchParams.get('br'), '320')
  assert.equal(ok.ok, true)
  assert.equal(ok.url, 'https://m701.music.126.net/2026/x.mp3')
  assert.equal(ok.br, 320)
  assert.ok(Math.abs(ok.estimatedDuration - 243) < 1)
})

const qqMirror = createMusicMirror({ fetchImpl: async (raw) => { assert.equal(new URL(raw).searchParams.get('source'), 'tencent'); return json({ url: 'https://isure.stream.qqmusic.qq.com/a.m4a', br: 320, size: 0 }) } })
const qq = await qqMirror.resolve({ source: 'qq', id: '00000000000001' })
check('QQ 音乐映射到 tencent 音乐源', () => { assert.equal(qq.ok, true); assert.equal(qq.estimatedDuration, 0) })

const text = createMusicMirror({ fetchImpl: async () => new Response('  https://m801.music.126.net/b.mp3  ', { headers: { 'Content-Type': 'text/plain' } }) })
const textResult = await text.resolve({ source: 'netease', id: '1' })
check('兼容纯文本直链返回', () => assert.equal(textResult.url, 'https://m801.music.126.net/b.mp3'))

const failures = [
  [{ url: '' }, /未提供/],
  [{ detail: 'Value of `source` is not supported.' }, /提示/],
  [{ url: 'http://m801.music.126.net/a.mp3' }, /不安全/],
  [{ url: 'https://127.0.0.1/a.mp3' }, /不安全/],
]
for (const [payload, expected] of failures) {
  const service = createMusicMirror({ fetchImpl: async () => json(payload) })
  const result = await service.resolve({ source: 'netease', id: '1', duration: 200 })
  check(`解析接口无有效地址时返回原因 ${JSON.stringify(payload).slice(0, 40)}`, () => { assert.equal(result.ok, false); assert.match(result.reason, expected) })
}

const mismatch = await createMusicMirror({ fetchImpl: async () => json({ url: 'https://m801.music.126.net/a.mp3', br: 320, size: 9728044 }) }).resolve({ source: 'netease', id: '1', duration: 120 })
check('时长与曲目不符时拒绝（避免下到别的版本）', () => { assert.equal(mismatch.ok, false); assert.match(mismatch.reason, /时长/) })

const disabled = createMusicMirror({ enabled: false, fetchImpl: async () => json({ url: 'https://m801.music.126.net/a.mp3' }) })
const disabledResult = await disabled.resolve({ source: 'netease', id: '1' })
check('关闭后返回未启用原因', () => { assert.equal(disabledResult.ok, false); assert.match(disabledResult.reason, /未启用/) ; assert.equal(disabled.info().enabled, false) })

const badId = createMusicMirror({ fetchImpl: async () => { throw new Error('不该被调用') } })
const badIdResult = await badId.resolve({ source: 'netease', id: '1?url=https://evil.test' })
check('歌曲编号不能注入 URL', () => { assert.equal(badIdResult.ok, false); assert.match(badIdResult.reason, /编号无效/) })

const boom = createMusicMirror({ fetchImpl: async () => new Response('nope', { status: 500 }) })
const boomResult = await boom.resolve({ source: 'netease', id: '1' })
check('接口非 2xx 时返回原因而不是抛错', () => { assert.equal(boomResult.ok, false); assert.match(boomResult.reason, /HTTP 500/) })

const huge = createMusicMirror({ fetchImpl: async () => new Response('x'.repeat(200 * 1024), { headers: { 'Content-Length': String(200 * 1024) } }) })
const hugeResult = await huge.resolve({ source: 'netease', id: '1' })
check('超大响应被拒绝', () => { assert.equal(hugeResult.ok, false) })

const configure = createMusicMirror({ fetchImpl: async () => json({ url: 'https://m801.music.126.net/a.mp3' }) })
check('可通过 configure 改接口与开关，非法接口抛错', () => {
  assert.throws(() => configure.configure({ endpoint: 'http://insecure.test/api.php' }), /HTTPS/)
  const info = configure.configure({ endpoint: 'https://music.example.test/api.php', enabled: false })
  assert.deepEqual(info, { enabled: false, endpoint: 'https://music.example.test/api.php' })
  assert.deepEqual(configure.configure({ enabled: true }), { enabled: true, endpoint: 'https://music.example.test/api.php' })
})

const controller = new AbortController()
const cancelMirror = createMusicMirror({ fetchImpl: (raw, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })) })
const pending = cancelMirror.resolve({ source: 'netease', id: '1' }, { signal: controller.signal })
controller.abort(new Error('测试取消'))
const cancelled = await pending
check('取消信号会中止解析请求并返回原因', () => { assert.equal(cancelled.ok, false); assert.match(cancelled.reason, /测试取消/) })

console.log(`Music mirror regressions: ${checks} passed`)