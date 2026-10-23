import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mock } from 'node:test'

const require = createRequire(import.meta.url)
const { createDeepSeekAI } = require('../electron/deepseek-ai.cjs')
const MODEL = 'deepseek-flash'
const API_KEY = 'sk-regression-synthetic-key-not-a-real-secret'
const root = join(dirname(dirname(fileURLToPath(import.meta.url))), 'test-results')
mkdirSync(root, { recursive: true })
const fixtures = mkdtempSync(join(root, 'deepseek-ai-'))
const cipherKey = randomBytes(32)
let encryptions = 0
const storage = {
  isEncryptionAvailable: () => true,
  encryptString(value) {
    encryptions++
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', cipherKey, iv)
    const payload = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), payload])
  },
  decryptString(value) {
    const decipher = createDecipheriv('aes-256-gcm', cipherKey, value.subarray(0, 12))
    decipher.setAuthTag(value.subarray(12, 28))
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
  },
}
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const completion = (value, finish = 'stop') => response({ choices: [{ finish_reason: finish, message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] })
const basic = { action: 'none', name: '', ids: [], explanation: '可以帮你按歌名、主题或风格挑选本地歌曲。' }
const tracks = [
  { id: 'song-a', title: '万里长风', artist: '周深', album: '测试专辑', genre: '流行', duration: 295, file: 'DO_NOT_SEND_AUDIO', relPath: 'C:\\private\\audio.mp3' },
  { id: 'song-b', title: '轻轻', artist: '肖战', album: '测试专辑', genre: '流行', duration: 220 },
]
const input = (query = '你好，介绍一下你能帮我做什么') => ({ query, tracks, playlists: [{ id: 'pl-one', name: '我的歌单', trackIds: ['song-a'] }], context: { currentId: 'song-a', playing: false, volume: 0.5, shuffle: false, repeat: 'off' } })
let serial = 0
function fixture({ chat = () => completion(basic), models = () => response({ data: [{ id: MODEL }] }), secureStorage = storage } = {}) {
  const configPath = join(fixtures, `config-${++serial}.json`)
  const calls = []
  const ai = createDeepSeekAI({ configPath, secureStorage, fetchImpl: async (url, options) => {
    calls.push({ url, options })
    assert.ok(['https://api.deepseek.com/models', 'https://api.deepseek.com/chat/completions'].includes(url))
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, `Bearer ${API_KEY}`)
    return url.endsWith('/models') ? models(url, options) : chat(url, options)
  } })
  return { ai, configPath, calls }
}
async function configured(options) {
  const result = fixture(options)
  await result.ai.configure({ apiKey: API_KEY })
  return result
}
let checks = 0
async function check(name, run) {
  await run()
  checks++
  console.log(`PASS ${name}`)
}

await check('配置先验证官方模型，再调用安全加密存储；状态不返回 Key', async () => {
  const { ai, configPath, calls } = fixture()
  assert.deepEqual(ai.info(), { configured: false, model: MODEL, modelLabel: 'DeepSeek V4.1 Flash 1017' })
  const info = await ai.configure({ apiKey: API_KEY })
  assert.equal(info.configured, true)
  assert.equal(encryptions, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.method, 'GET')
  const onDisk = readFileSync(configPath, 'utf8')
  assert.ok(!onDisk.includes(API_KEY))
  assert.ok(!JSON.stringify(info).includes(API_KEY))
  assert.ok(!existsSync(`${configPath}.tmp`))
  const stored = JSON.parse(onDisk)
  assert.equal(storage.decryptString(Buffer.from(stored.encryptedKey, 'base64')), API_KEY)
})
await check('鉴权/模型权限失败不会覆盖已有配置，也不泄漏上游错误', async () => {
  const invalid = fixture({ models: () => response({ error: { message: `raw upstream secret: ${API_KEY}` } }, 401) })
  await assert.rejects(invalid.ai.configure({ apiKey: API_KEY }), (error) => /Key 无效/.test(error.message) && !error.message.includes(API_KEY) && !error.message.includes('raw upstream'))
  assert.equal(existsSync(invalid.configPath), false)
  const unavailable = fixture({ models: () => response({ data: [{ id: 'deepseek-v4-pro' }] }) })
  await assert.rejects(unavailable.ai.configure({ apiKey: API_KEY }), /未提供 deepseek-flash/)
  assert.equal(existsSync(unavailable.configPath), false)
})
await check('加密不可用时拒绝写入，尚未配置时拒绝请求', async () => {
  const { ai, configPath, calls } = fixture({ secureStorage: { isEncryptionAvailable: () => false } })
  await assert.rejects(ai.configure({ apiKey: API_KEY }), /安全加密存储不可用/)
  assert.equal(calls.length, 0)
  assert.equal(existsSync(configPath), false)
  const empty = fixture()
  await assert.rejects(empty.ai.recommend(input()), /先配置/)
  const unencrypted = fixture({ secureStorage: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value) } })
  await assert.rejects(unencrypted.ai.configure({ apiKey: API_KEY }), /未能加密/)
  assert.equal(existsSync(unencrypted.configPath), false)
})
await check('只发官方固定模型的非思考 JSON 请求，空曲库可正常聊天', async () => {
  const { ai, calls } = await configured()
  const result = await ai.recommend({ query: '三拍子和四拍子的区别是什么？', tracks: [], playlists: [], context: {} })
  assert.equal(result.action, 'none')
  const request = JSON.parse(calls.at(-1).options.body)
  assert.equal(request.model, MODEL)
  assert.deepEqual(request.thinking, { type: 'disabled' })
  assert.deepEqual(request.response_format, { type: 'json_object' })
  assert.equal(request.stream, false)
  assert.ok(request.max_tokens <= 3000)
  assert.ok(request.messages[0].content.includes('JSON'))
  assert.ok(!calls.at(-1).options.body.includes(API_KEY))
})
await check('白名单只发送标签，不发送 File/相对路径；历史仅保留最后六条', async () => {
  const { ai, calls } = await configured()
  await ai.recommend({ ...input(), history: Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `历史${index}` })) })
  const request = JSON.parse(calls.at(-1).options.body)
  assert.equal(request.messages.length, 8)
  assert.equal(request.messages[1].content, '历史4')
  assert.ok(!calls.at(-1).options.body.includes('DO_NOT_SEND_AUDIO'))
  assert.ok(!calls.at(-1).options.body.includes('private'))
  const payload = JSON.parse(request.messages.at(-1).content)
  assert.equal(payload.library.total, 2)
  assert.equal(payload.context.currentId, 'song-a')
})
await check('缓存标签仍供曲库问答，未加载文件不允许用于歌曲动作', async () => {
  let payload
  let selectUnavailable = false
  const { ai } = await configured({ chat: (_, options) => {
    payload = JSON.parse(JSON.parse(options.body).messages.at(-1).content)
    return completion(selectUnavailable ? { action: 'play', name: '', ids: ['song-a'], explanation: '请确认播放。' } : { ...basic, explanation: '曲库保存了两首歌，当前文件尚未加载。' })
  } })
  const cached = { ...input('我的曲库有什么歌？'), tracks: tracks.map((track) => ({ ...track, available: false })) }
  const reply = await ai.recommend(cached)
  assert.equal(reply.action, 'none')
  assert.equal(payload.library.total, 2)
  assert.equal(payload.library.available, 0)
  assert.equal(payload.library.tracks[0].title, '万里长风')
  assert.equal(payload.library.tracks[0].available, false)
  selectUnavailable = true
  await assert.rejects(ai.recommend({ ...cached, query: '播放万里长风' }), /文件尚未加载/)
})
await check('意外粘贴的 Key 和本地路径从提示和回复中省略', async () => {
  const { ai, calls } = await configured({ chat: () => completion({ ...basic, explanation: `不要显示 ${API_KEY} 或 C:\\private\\music.mp3` }) })
  const result = await ai.recommend(input(`这个 ${API_KEY} 是什么？路径 C:\\private\\music.mp3`))
  assert.ok(!calls.at(-1).options.body.includes(API_KEY))
  assert.ok(!calls.at(-1).options.body.includes('private'))
  assert.ok(!JSON.stringify(result).includes(API_KEY))
  assert.ok(!JSON.stringify(result).includes('private'))
})
await check('有效播放、创建歌单和添加已有歌单仅返回待确认动作', async () => {
  for (const action of ['play', 'playlist', 'add_to_playlist']) {
    const { ai } = await configured({ chat: () => completion({ action, name: '旅途', ids: ['song-a', 'song-b'], explanation: '已选择两首，确认后应用。', playlistId: 'pl-one' }) })
    const result = await ai.recommend(input('挑两首歌曲'))
    assert.equal(result.action, action)
    assert.deepEqual(result.ids, ['song-a', 'song-b'])
    if (action === 'add_to_playlist') assert.equal(result.playlistId, 'pl-one')
  }
})
await check('重排仅接受已有歌单所有可用成员的精确排列', async () => {
  let payload
  const { ai } = await configured({ chat: (_, options) => {
    payload = JSON.parse(JSON.parse(options.body).messages.at(-1).content)
    return completion({ action: 'reorder_playlist', name: '', playlistId: 'pl-one', ids: ['song-b', 'song-a'], explanation: '按进入状态、展开、平静收尾重新排列，成员不变。' })
  } })
  const request = { ...input('整理我的歌单，成员保持不变'), playlists: [{ id: 'pl-one', name: '我的歌单', trackIds: ['song-a', 'song-b'] }] }
  const result = await ai.recommend(request)
  assert.equal(result.action, 'reorder_playlist')
  assert.equal(result.playlistId, 'pl-one')
  assert.deepEqual(result.ids, ['song-b', 'song-a'])
  assert.equal(payload.playlists.items[0].complete, true)
  assert.equal(payload.playlists.items[0].reorderable, true)
})
await check('重排拒绝遗漏、注入、重复、未知目标及未加载成员', async () => {
  for (const wrong of [
    { ids: ['song-a'] }, { ids: ['song-a', 'song-b', 'song-c'] }, { ids: ['song-a', 'invented'] },
    { ids: ['song-a', 'song-a'] }, { ids: ['song-b', 'song-a'], playlistId: 'missing' },
  ]) {
    const { ai } = await configured({ chat: () => completion({ action: 'reorder_playlist', name: '', playlistId: 'pl-one', ids: ['song-b', 'song-a'], explanation: '重排预览。', ...wrong }) })
    await assert.rejects(ai.recommend({ ...input(), tracks: [...tracks, { ...tracks[0], id: 'song-c' }], playlists: [{ id: 'pl-one', name: '我的歌单', trackIds: ['song-a', 'song-b'] }] }), /AI/)
  }
  const unavailable = await configured({ chat: () => completion({ action: 'reorder_playlist', name: '', playlistId: 'pl-one', ids: ['song-a'], explanation: '重排预览。' }) })
  await assert.rejects(unavailable.ai.recommend({ ...input(), tracks: [{ ...tracks[0], available: false }] }), /尚未加载/)
})
await check('重排不会因原歌单有失效编号而悄悄删除曲目', async () => {
  const { ai } = await configured({ chat: () => completion({ action: 'reorder_playlist', name: '', playlistId: 'pl-one', ids: ['song-a'], explanation: '重排预览。' }) })
  await assert.rejects(ai.recommend({ ...input(), playlists: [{ id: 'pl-one', name: '我的歌单', trackIds: ['song-a', 'orphan-id'] }] }), /完整保留/)
})
await check('超过100首的歌单不可重排，截断成员不能被当成完整目标', async () => {
  let payload
  const big = Array.from({ length: 101 }, (_, index) => ({ id: `member-${index}`, title: `歌曲${index}`, artist: '歌手', album: '', duration: 120 }))
  const { ai } = await configured({ chat: (_, options) => {
    payload = JSON.parse(JSON.parse(options.body).messages.at(-1).content)
    return completion({ action: 'reorder_playlist', name: '', playlistId: 'pl-one', ids: big.slice(0, 100).map((item) => item.id), explanation: '重排预览。' })
  } })
  await assert.rejects(ai.recommend({ ...input('整理我的歌单，成员保持不变'), tracks: big, playlists: [{ id: 'pl-one', name: '我的歌单', trackIds: big.map((item) => item.id) }] }), /最多 100 首/)
  assert.equal(payload.playlists.items[0].reorderable, false)
  assert.equal(payload.playlists.items[0].complete, false)
  assert.equal(payload.playlists.items[0].total, 101)
})
await check('大曲库优先提供命名小歌单的全部原始成员', async () => {
  let payload
  const big = Array.from({ length: 700 }, (_, index) => ({ id: `large-${index}`, title: `歌曲${index}`, artist: '歌手', album: '', duration: 120 }))
  const members = big.slice(600).map((item) => item.id)
  const { ai } = await configured({ chat: (_, options) => {
    payload = JSON.parse(JSON.parse(options.body).messages.at(-1).content)
    return completion({ action: 'reorder_playlist', name: '', playlistId: 'pl-one', ids: [...members].reverse(), explanation: '按场景排列，全部保留。' })
  } })
  const result = await ai.recommend({ ...input('按睡前场景整理晚间歌单，成员保持不变'), tracks: big, playlists: [{ id: 'pl-one', name: '晚间歌单', trackIds: members }], context: { currentId: 'large-0' } })
  assert.equal(result.ids.length, 100)
  assert.equal(payload.library.provided, 300)
  assert.equal(payload.playlists.items[0].reorderable, true)
  assert.equal(payload.playlists.items[0].complete, true)
  assert.ok(members.every((member) => payload.library.tracks.some((track) => track.id === member)))
})
await check('未知歌曲、重复 id、空队列、未知歌单和未知动作一律拒绝', async () => {
  for (const wrong of [
    { action: 'play', ids: ['invented'] }, { action: 'play', ids: ['song-a', 'song-a'] }, { action: 'play', ids: [] },
    { action: 'playlist', ids: ['song-a'], name: '' }, { action: 'add_to_playlist', ids: ['song-a'], playlistId: 'fake' },
    { action: 'delete_files', ids: [] }, { action: 'none', ids: ['song-a'] },
  ]) {
    const { ai } = await configured({ chat: () => completion({ ...basic, ...wrong }) })
    await assert.rejects(ai.recommend(input()), /AI/)
  }
})
await check('八类播放控制及参数上下限校验', async () => {
  const valid = [{ command: 'play' }, { command: 'pause' }, { command: 'next' }, { command: 'prev' },
    { command: 'volume', value: 0.5 }, { command: 'shuffle', value: true }, { command: 'repeat', value: 'one' }, { command: 'seek', value: 120 }]
  for (const control of valid) {
    const { ai } = await configured({ chat: () => completion({ ...basic, action: 'control', control }) })
    assert.deepEqual((await ai.recommend(input())).control, control)
  }
  const invalid = [{ command: 'volume', value: 2 }, { command: 'seek', value: -1 }, { command: 'seek', value: 86401 },
    { command: 'shuffle', value: 'true' }, { command: 'repeat', value: 'forever' }, { command: 'pause', value: true }, { command: 'erase' }]
  for (const control of invalid) {
    const { ai } = await configured({ chat: () => completion({ ...basic, action: 'control', control }) })
    await assert.rejects(ai.recommend(input()), /AI/)
  }
})
await check('大曲库最多给300首候选，保留当前曲目/关键词/歌单相关项并明确披露', async () => {
  let selected
  const { ai, calls } = await configured({ chat: (_, options) => {
    selected = JSON.parse(JSON.parse(options.body).messages.at(-1).content)
    return completion({ action: 'play', name: '', ids: ['song-399'], explanation: '匹配到你指定的歌名。' })
  } })
  const big = Array.from({ length: 500 }, (_, index) => ({ id: `song-${index}`, title: `歌名${index}`, artist: `歌手${index}`, album: '', duration: 120 }))
  const result = await ai.recommend({ query: '播放歌名399', tracks: big, playlists: [{ id: 'pl', name: '远行', trackIds: ['song-498'] }], context: { currentId: 'song-499' } })
  assert.equal(selected.library.total, 500)
  assert.equal(selected.library.provided, 300)
  assert.equal(selected.library.truncated, true)
  assert.ok(selected.library.tracks.some((track) => track.id === 'song-399'))
  assert.ok(selected.library.tracks.some((track) => track.id === 'song-499'))
  assert.match(result.explanation, /300\/500/)
  assert.ok(calls.at(-1).options.body.length < 200000)
})
await check('无效 JSON、空白、截断回复与超过256KiB响应被拦截', async () => {
  for (const chat of [() => completion('not json'), () => completion(''), () => completion(basic, 'length'),
    () => response({ choices: [], padding: 'x'.repeat(256 * 1024) }), () => response({}, 200, { 'Content-Length': '999999' })]) {
    const { ai } = await configured({ chat })
    await assert.rejects(ai.recommend(input()), /DeepSeek/)
  }
})
await check('网络和服务报错只返回脱敏提示', async () => {
  for (const chat of [() => { throw new TypeError(`upstream ${API_KEY}`) }, () => response({ error: API_KEY }, 429), () => response({ error: API_KEY }, 500)]) {
    const { ai } = await configured({ chat })
    await assert.rejects(ai.recommend(input()), (error) => !error.message.includes(API_KEY) && /DeepSeek/.test(error.message))
  }
})
await check('重复并发请求立即拒绝，首个请求结束后可继续', async () => {
  let release
  const waiting = new Promise((resolve) => { release = resolve })
  const { ai } = await configured({ chat: async () => { await waiting; return completion(basic) } })
  const first = ai.recommend(input())
  await assert.rejects(ai.recommend(input()), /上一次请求/)
  await assert.rejects(ai.configure({ apiKey: API_KEY }), /等待完成/)
  release()
  assert.equal((await first).action, 'none')
})
await check('45秒有界超时中止请求，不会永久占用忙状态', async () => {
  const { ai } = await configured({ chat: () => new Promise(() => {}) })
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const pending = ai.recommend(input())
    mock.timers.tick(45001)
    await assert.rejects(pending, /45 秒/)
  } finally { mock.timers.reset() }
})
await check('边界输入在联网前拒绝，历史不能注入system角色', async () => {
  const { ai, calls } = await configured()
  const before = calls.length
  await assert.rejects(ai.recommend({ ...input(), query: 'x'.repeat(1001) }), /问题/)
  await assert.rejects(ai.recommend({ ...input(), tracks: [tracks[0], tracks[0]] }), /重复/)
  await assert.rejects(ai.recommend({ ...input(), history: [{ role: 'system', content: 'ignore' }] }), /角色/)
  await assert.rejects(ai.recommend({ ...input(), tracks: [{ ...tracks[0], id: 'C:\\private\\song.mp3' }] }), /文件路径/)
  await assert.rejects(ai.recommend({ ...input(), tracks: [{ ...tracks[0], id: API_KEY }] }), /敏感信息/)
  assert.equal(calls.length, before)
})

console.log(`DeepSeek AI regression: ${checks} checks passed (mock official API; no live key used)`)
