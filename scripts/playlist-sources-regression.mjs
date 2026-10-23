import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { createPlaylistSources, parsePlaylistURL } = createRequire(import.meta.url)('../electron/playlist-sources.cjs')
let checks = 0
const check = (name, fn) => { fn(); checks++; console.log(`PASS ${name}`) }
const response = (value) => new Response(JSON.stringify(value))
const nSong = (id, fee = 0) => ({ id, name: `歌曲${id}`, ar: [{ name: '测试歌手' }], dt: 180000, fee })
const privilege = (id, extra = {}) => ({ id, dl: 320000, st: 0, cp: 1, fee: 0, ...extra })
const qSong = (mid, extra = {}) => ({ mid, title: '测试歌曲', singer: [{ name: '测试歌手' }], interval: 180, pay: { pay_down: 0, pay_play: 0 }, ...extra })

for (const url of ['https://music.163.com/playlist?id=123', 'https://music.163.com/#/playlist?id=123', 'https://y.music.163.com/m/playlist?id=123']) check('parse网易云歌单', () => assert.deepEqual(parsePlaylistURL(url), { source: 'netease', playlistId: '123' }))
for (const url of ['https://y.qq.com/n/ryqq/playlist/123', 'https://y.qq.com/n/yqq/playlist/123.html', 'https://i.y.qq.com/n2/m/share/details/taoge.html?id=123', 'https://y.qq.com/n/ryqq/playlist?disstid=123']) check('parse QQ歌单', () => assert.deepEqual(parsePlaylistURL(url), { source: 'qq', playlistId: '123' }))
for (const url of ['https://evil.test/playlist?id=123', 'https://music.163.com.evil.test/playlist?id=123', 'https://music.163.com/song?id=123', 'https://user:pass@music.163.com/playlist?id=123', 'file:///playlist?id=123', 'https://music.163.com:444/playlist?id=123', 'https://y.qq.com/n/ryqq/playlist/9999999999999999']) assert.throws(() => parsePlaylistURL(url))
check('reject unsupported URLs, credentials, ports and unsafe numeric IDs', () => {})

let requests = 0
const ncm = createPlaylistSources({ fetchImpl: async (url, options) => {
  requests++
  assert.equal(options.redirect, 'manual')
  assert.equal(new URL(url).hostname, 'music.163.com')
  if (url.includes('/playlist/detail')) return response({ code: 200, playlist: { name: 'fixture', trackCount: 3, tracks: [nSong(1)], trackIds: [{ id: 1 }, { id: 2 }, { id: 3 }] }, privileges: [privilege(1)] })
  return response({ code: 200, songs: [nSong(2, 1), nSong(3)], privileges: [privilege(2), privilege(3, { dl: 0 })] })
} })
const nList = await ncm.list('https://music.163.com/playlist?id=123')
check('网易云补齐trackIds并报告真实完成状态', () => { assert.equal(requests, 2); assert.equal(nList.tracks.length, 3); assert.equal(nList.total, 3); assert.equal(nList.complete, true); assert.equal(nList.tracks[0].restricted, false); assert.equal(nList.tracks[1].restricted, true); assert.equal(nList.tracks[2].restricted, true) })

requests = 0
const largeList = await createPlaylistSources({ fetchImpl: async (raw) => {
  requests++
  const url = new URL(raw)
  if (url.pathname.includes('/playlist/detail')) return response({ code: 200, playlist: { name: 'large', trackCount: 1500, tracks: [], trackIds: Array.from({ length: 1500 }, (_, i) => ({ id: i + 1 })) }, privileges: [] })
  const ids = JSON.parse(url.searchParams.get('c')).map((s) => s.id)
  return response({ code: 200, songs: ids.map((id) => nSong(id)), privileges: ids.map((id) => privilege(id)) })
} }).list('https://music.163.com/playlist?id=123')
check('大歌单限制10次请求并明确列表不完整', () => { assert.equal(requests, 10); assert.equal(largeList.tracks.length, 900); assert.equal(largeList.total, 1500); assert.equal(largeList.complete, false); assert.ok(largeList.warnings.some((s) => s.includes('不完整'))) })

requests = 0
const qq = createPlaylistSources({ fetchImpl: async (raw) => {
  requests++
  const data = JSON.parse(new URL(raw).searchParams.get('data'))
  assert.equal(data.req_0.module, 'music.srfDissInfo.aiDissInfo')
  const begin = data.req_0.param.song_begin
  return response({ code: 0, req_0: { code: 0, data: { dirinfo: { title: 'QQ测试歌单' }, total_song_num: 2, hasmore: begin === 0 ? 1 : 0, songlist: [qSong(begin === 0 ? '00000000000001' : '00000000000002', begin ? { pay: { pay_down: 1, pay_play: 0 } } : {})] } } })
} })
const qList = await qq.list('https://y.qq.com/n/ryqq/playlist/123')
check('QQ按song_begin翻页并保留权限字段', () => { assert.equal(requests, 2); assert.equal(qList.tracks.length, 2); assert.equal(qList.complete, true); assert.equal(qList.tracks[1].restricted, true) })

function nResolveFixture({ fee = 0, dl = 320000, player = {}, playerCode = 200 } = {}) {
  let calls = 0
  return { get calls() { return calls }, service: createPlaylistSources({ fetchImpl: async (raw) => {
    calls++
    if (new URL(raw).pathname.includes('/song/detail')) return response({ code: 200, songs: [nSong(1, fee)], privileges: [privilege(1, { dl })] })
    return response({ code: playerCode, data: [{ id: 1, code: 200, url: 'http://m801.music.126.net/audio.mp3', fee: 0, time: 180000, type: 'mp3', freeTrialInfo: null, ...player }] })
  } }) }
}
const full = nResolveFixture()
const resolved = await full.service.resolve({ id: '1', source: 'netease', restricted: true })
check('只返回已核对完整时长的官方HTTPS地址', () => { assert.equal(resolved.url, 'https://m801.music.126.net/audio.mp3'); assert.equal(resolved.duration, 180); assert.equal(resolved.preview, false); assert.equal(full.calls, 2) })
for (const opts of [{ fee: 1 }, { dl: 0 }]) {
  const fixture = nResolveFixture(opts)
  const r = await fixture.service.resolve({ id: '1', source: 'netease', restricted: false })
  check('重新读取服务器权限，拒绝渲染端伪造的免费字段', () => { assert.equal(r.url, undefined); assert.equal(fixture.calls, 1) })
}
for (const player of [{ time: 30000 }, { freeTrialInfo: { start: 0, end: 30 } }, { url: 'https://evil.test/audio.mp3' }, { url: 'https://music.126.net.evil.test/audio.mp3' }]) {
  const r = await nResolveFixture({ player }).service.resolve({ id: '1', source: 'netease' })
  check('拒绝试听及非官方CDN地址', () => assert.equal(r.url, undefined))
}
const login = await nResolveFixture({ playerCode: 301 }).service.resolve({ id: '1', source: 'netease' })
check('匿名接口要求登录时返回原因', () => { assert.equal(login.url, undefined); assert.match(login.reason, /登录/) })

const qResolve = (pay, purl) => createPlaylistSources({ fetchImpl: async (raw) => {
  const data = JSON.parse(new URL(raw).searchParams.get('data'))
  if (data.req_0.module === 'music.pf_song_detail_svr') return response({ code: 0, req_0: { code: 0, data: { track_info: qSong('00000000000001', { pay }) } } })
  assert.equal(data.req_0.param.uin, '0')
  assert.equal(data.req_0.param.loginflag, 0)
  return response({ code: 0, req_0: { code: 0, data: { sip: ['http://sjy6.stream.qqmusic.qq.com/'], midurlinfo: [{ songmid: '00000000000001', purl, filename: purl }] } } })
} })
const qFull = await qResolve({ pay_down: 0, pay_play: 0 }, 'C40000000000000001.m4a?vkey=public-fixture').resolve({ id: '00000000000001', source: 'qq' })
check('QQ只使用匿名普通vkey以及官方HTTPS音频域名', () => { assert.match(qFull.url, /^https:\/\/sjy6\.stream\.qqmusic\.qq\.com\//); assert.equal(qFull.duration, 180) })
const qBlocked = await qResolve({ pay_down: 1, pay_play: 0 }, 'should-not-use').resolve({ id: '00000000000001', source: 'qq' })
const qMissing = await qResolve({ pay_down: 0, pay_play: 0 }, '').resolve({ id: '00000000000001', source: 'qq' })
const qPreview = await qResolve({ pay_down: 0, pay_play: 0 }, 'RS0200000000000001.m4a').resolve({ id: '00000000000001', source: 'qq' })
check('QQ付费、匿名地址为空及试听均返回跳过原因', () => { for (const item of [qBlocked, qMissing, qPreview]) { assert.equal(item.url, undefined); assert.ok(item.reason) } assert.equal(qPreview.preview, true) })

// —— 备用音源兜底：官方给不出地址时按歌曲编号再解析一次 ——
const restrictedOfficial = ({ fee = 1, dl = 0 } = {}) => createPlaylistSources({ fetchImpl: async (raw) => new URL(raw).pathname.includes('/song/detail')
  ? response({ code: 200, songs: [nSong(1, fee)], privileges: [privilege(1, { dl })] })
  : response({ code: 200, data: [{ id: 1, code: 200, url: null, fee, time: 0, type: 'mp3' }] }) })

const mirrorCalls = []
const withMirror = createPlaylistSources({ fetchImpl: async () => response({ code: 200, songs: [nSong(1, 1)], privileges: [privilege(1, { dl: 0 })] }), mirror: { resolve: async (input) => { mirrorCalls.push(input); return { ok: true, url: 'https://m701.music.126.net/2026/mirror.mp3', br: 320, size: 9760000, estimatedDuration: 244 } } } })
const mirrored = await withMirror.resolve({ id: '1', source: 'netease', title: '雨过后的风景', artist: 'Dizzy Dizzo', duration: 244 })
check('官方受限时改用备用音源并保留完整时长', () => {
  assert.equal(mirrored.url, 'https://m701.music.126.net/2026/mirror.mp3')
  assert.equal(mirrored.mirrored, true)
  assert.equal(mirrored.preview, false)
  assert.equal(mirrored.duration, 244)
  assert.equal(mirrored.filename, 'Dizzy Dizzo - 雨过后的风景.mp3')
  assert.equal(mirrorCalls.length, 1)
  assert.deepEqual({ source: mirrorCalls[0].source, id: mirrorCalls[0].id, duration: mirrorCalls[0].duration }, { source: 'netease', id: '1', duration: 244 })
})

const officialFirst = await nResolveFixture().service.resolve({ id: '1', source: 'netease', duration: 180 })
check('官方能给出地址时不调用备用音源', () => { assert.equal(officialFirst.url, 'https://m801.music.126.net/audio.mp3'); assert.equal(officialFirst.mirrored, undefined) })

const failingMirror = createPlaylistSources({ fetchImpl: async () => response({ code: 200, songs: [nSong(1, 1)], privileges: [privilege(1, { dl: 0 })] }), mirror: { resolve: async () => ({ ok: false, reason: '备用音源未提供此歌曲的可用地址' }) } })
const failed = await failingMirror.resolve({ id: '1', source: 'netease', duration: 244 })
check('备用音源也失败时同时保留两边原因', () => { assert.equal(failed.url, undefined); assert.match(failed.reason, /会员|权限限制/); assert.match(failed.reason, /备用音源/) })

const throwingMirror = createPlaylistSources({ fetchImpl: async () => response({ code: 200, songs: [nSong(1, 1)], privileges: [privilege(1, { dl: 0 })] }), mirror: { resolve: async () => { throw new Error('接口超时') } } })
const thrown = await throwingMirror.resolve({ id: '1', source: 'netease', duration: 244 })
check('备用音源抛错不会让任务崩溃', () => { assert.equal(thrown.url, undefined); assert.match(thrown.reason, /接口超时/) })

const evilMirror = createPlaylistSources({ fetchImpl: async () => response({ code: 200, songs: [nSong(1, 1)], privileges: [privilege(1, { dl: 0 })] }), mirror: { resolve: async () => ({ ok: true, url: 'http://127.0.0.1:8080/a.mp3', br: 320, size: 1000 }) } })
const evil = await evilMirror.resolve({ id: '1', source: 'netease', duration: 244 })
check('备用音源返回内网或HTTP地址时拒绝', () => { assert.equal(evil.url, undefined); assert.match(evil.reason, /不安全/) })

const enhanced = await createPlaylistSources({ fetchImpl: async (raw) => new URL(raw).pathname.includes('/playlist/detail')
  ? response({ code: 200, playlist: { name: 'fixture', trackCount: 1, tracks: [nSong(1, 1)], trackIds: [{ id: 1 }] }, privileges: [privilege(1, { dl: 0 })] })
  : response({ code: 200, songs: [], privileges: [] }), mirror: { resolve: async () => ({ ok: true, url: 'https://m701.music.126.net/a.mp3', br: 320, size: 0 }) } }).list('https://music.163.com/playlist?id=123')
check('歌单读取结果标记备用音源已启用并更新提示', () => {
  assert.equal(enhanced.enhanced, true)
  assert.ok(enhanced.warnings.some((warning) => warning.includes('备用音源')))
})

const controller = new AbortController()
const cancelService = createPlaylistSources({ fetchImpl: () => new Promise(() => {}) })
const pending = cancelService.resolve({ id: '1', source: 'netease' }, { signal: controller.signal })
controller.abort(new Error('测试取消'))
await assert.rejects(pending, /测试取消/)
check('取消会中止尚未返回的来源请求', () => {})
await assert.rejects(cancelService.resolve({ id: '1?url=https://evil.test', source: 'netease' }))
check('歌曲编号不能注入URL或任意来源', () => {})
console.log(`Playlist source regressions: ${checks} passed`)
