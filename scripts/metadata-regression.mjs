import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { createMetadata } = require('../electron/metadata.cjs')
const track = { title: '珍惜对你例外的人', artist: '心煜', duration: 218 }
const cacheDir = path.resolve('.qa', `metadata-${Date.now()}`)
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const line = '[00:01.00]metadata regression fixture'
let checks = 0
function check(name, fn) { fn(); checks++; console.log(`PASS ${name}`) }

function mock({ song = {}, lyric = {}, image, fail = false, keywordEmpty = false } = {}) {
  const calls = []
  return {
    calls,
    fetchImpl: async (raw, options) => {
      const url = new URL(raw)
      calls.push(url)
      assert.equal(options.redirect, 'manual')
      assert.equal(url.protocol, 'https:')
      if (fail) throw new Error('offline')
      if (url.hostname === 'songsearch.kugou.com') return json({ data: { lists: [{ SongName: track.title, SingerName: track.artist, Duration: 218, FileHash: 'a'.repeat(32), Image: 'https://imge.kugou.com/stdmusic/500/20261016/mock.jpg', ...song }] } })
      if (url.pathname === '/search') return json({ candidates: keywordEmpty && !url.searchParams.has('hash') ? [] : [{ song: track.title, singer: track.artist, duration: 218000, id: '1234', accesskey: 'PUBLICACCESS', ...lyric }] })
      if (url.pathname === '/download') return json({ content: Buffer.from(line).toString('base64') })
      if (url.hostname === 'imge.kugou.com') return image || new Response(Buffer.from([255, 216, 255, 0]))
      throw new Error('Unexpected metadata URL')
    },
  }
}

const happy = mock()
const service = createMetadata({ cacheDir, fetchImpl: happy.fetchImpl })
const [a, b] = await Promise.all([service.lookup(track), service.lookup(track)])
check('strict live-shaped match returns cover and synchronized lyrics', () => { assert.equal(a.matched, true); assert.match(a.cover, /^data:image\/jpeg;base64,/); assert.equal(a.lyrics, line) })
check('same-song requests share the in-flight operation', () => { assert.deepEqual(a, b); assert.equal(happy.calls.length, 4) })
const cached = mock({ fail: true })
const cachedResult = await createMetadata({ cacheDir, fetchImpl: cached.fetchImpl }).lookup(track)
check('disk cache works after a new process while offline', () => { assert.equal(cached.calls.length, 0); assert.equal(cachedResult.lyrics, line) })
const hashSource = mock({ keywordEmpty: true })
const hashResult = await createMetadata({ fetchImpl: hashSource.fetchImpl }).lookup({ ...track, duration: 218.540408 })
check('empty keyword lyrics fall back to a strictly matched song hash with fractional MP3 duration', () => { assert.equal(hashResult.lyrics, line); assert.equal(hashSource.calls.filter((url) => url.searchParams.has('hash')).length, 1) })

for (const [name, song, lyric] of [
  ['wrong artist', { SingerName: '其他歌手' }, { singer: '其他歌手' }],
  ['wrong title', { SongName: `${track.title} Live` }, { song: `${track.title} Live` }],
  ['wrong duration', { Duration: 260 }, { duration: 260000 }],
  ['unrequested version suffix', { Suffix: '伴奏' }, { song: `${track.title} 伴奏` }],
]) {
  const fixture = mock({ song, lyric })
  const result = await createMetadata({ fetchImpl: fixture.fetchImpl }).lookup(track)
  check(`rejects ${name}`, () => { assert.equal(result.matched, false); assert.equal(fixture.calls.length, 2) })
}

for (const imageUrl of ['http://127.0.0.1/private.jpg', 'https://imge.kugou.com.evil.test/stdmusic/500/a.jpg', 'https://imge.kugou.com/stdmusic/500/a.svg', 'https://user:pass@imge.kugou.com/stdmusic/500/a.jpg']) {
  const fixture = mock({ song: { Image: imageUrl } })
  const result = await createMetadata({ fetchImpl: fixture.fetchImpl }).lookup(track)
  check('rejects untrusted artwork URL', () => { assert.equal(result.cover, undefined); assert.equal(fixture.calls.length, 3) })
}
const svg = mock({ image: new Response('<svg/>', { headers: { 'content-type': 'image/jpeg' } }) })
const svgResult = await createMetadata({ fetchImpl: svg.fetchImpl }).lookup(track)
check('validates image bytes instead of trusting MIME', () => assert.equal(svgResult.cover, undefined))
const large = mock({ image: new Response('x', { headers: { 'content-length': String(3 * 1024 * 1024) } }) })
const largeResult = await createMetadata({ fetchImpl: large.fetchImpl }).lookup(track)
check('bounds artwork response size while preserving valid lyrics', () => { assert.equal(largeResult.cover, undefined); assert.equal(largeResult.lyrics, line) })

const noMatches = mock({ song: { Duration: 900 }, lyric: { duration: 900000 } })
const negativeService = createMetadata({ fetchImpl: noMatches.fetchImpl })
await negativeService.lookup(track)
await negativeService.lookup(track)
check('negative lookup is cached to avoid repeated calls', () => assert.equal(noMatches.calls.length, 2))
await negativeService.lookup({ ...track, refresh: true })
check('explicit retry refreshes the bounded negative cache', () => assert.equal(noMatches.calls.length, 4))

const entryPath = path.join(cacheDir, (await fs.readdir(cacheDir))[0])
const entry = JSON.parse(await fs.readFile(entryPath, 'utf8'))
entry.expires = Date.now() - 1
await fs.writeFile(entryPath, JSON.stringify(entry))
const stale = await createMetadata({ cacheDir, fetchImpl: mock({ fail: true }).fetchImpl }).lookup(track)
check('expired positive cache survives a source outage', () => { assert.equal(stale.lyrics, line); assert.match(stale.message, /缓存/) })
const emptyRefresh = mock({ song: { Duration: 900 }, lyric: { duration: 900000 } })
const preserved = await createMetadata({ cacheDir, fetchImpl: emptyRefresh.fetchImpl }).lookup({ ...track, refresh: true })
check('a successful but empty source response cannot erase previously verified cached lyrics', () => assert.equal(preserved.lyrics, line))

const validation = mock()
const validService = createMetadata({ fetchImpl: validation.fetchImpl })
for (const invalid of [null, {}, { ...track, title: 'x'.repeat(201) }, { ...track, duration: -1 }, { ...track, duration: Infinity }, { ...track, artist: '\n' }]) await assert.rejects(validService.lookup(invalid))
const waiting = await validService.lookup({ ...track, duration: 0 })
check('invalid inputs and unknown duration do not make network calls', () => { assert.equal(validation.calls.length, 0); assert.equal(waiting.matched, false) })

const start = Date.now()
const timeout = await createMetadata({ fetchImpl: () => new Promise(() => {}) }).lookup(track)
check('deadline also handles a fetch implementation ignoring AbortSignal', () => { assert.equal(timeout.matched, false); assert.ok(Date.now() - start < 7500); assert.match(timeout.message, /暂不可用/) })

if (process.argv.includes('--live')) {
  const live = await createMetadata({ cacheDir: path.resolve('.qa', 'metadata-live') }).lookup({ ...track, duration: 218.540408, refresh: true })
  assert.ok(live.cover && live.lyrics, 'The named real song should have artwork and lyrics')
  const report = { matched: live.matched, source: live.source, coverBytes: Buffer.from(live.cover.split(',')[1], 'base64').length, lyricCharacters: live.lyrics.length, timestampCount: (live.lyrics.match(/\[\d+:\d+(?:\.\d+)?\]/g) || []).length }
  await fs.writeFile(path.resolve('.qa', 'metadata-live-result.json'), JSON.stringify(report, null, 2))
  console.log('LIVE', JSON.stringify(report))
  checks++
}
console.log(`Metadata regressions: ${checks} passed`)
