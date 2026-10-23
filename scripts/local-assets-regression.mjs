import assert from 'node:assert/strict'
import { build } from 'esbuild'

await build({ entryPoints: ['src/lib/library.ts'], bundle: true, format: 'esm', platform: 'neutral', outfile: '.tmp/local-assets-library.mjs' })
const { buildTracks, collectLocalAssets, filesFromInput, scanHandle } = await import('../.tmp/local-assets-library.mjs')

let checks = 0
const urls = []
function file(name, bytes = new Uint8Array(20)) {
  const f = new File([bytes], name.split('/').at(-1))
  Object.defineProperty(f, 'webkitRelativePath', { value: name })
  return f
}
async function tracks(files) {
  const { lrcMap, coverMap } = collectLocalAssets(files)
  const result = await buildTracks(filesFromInput({ files }), lrcMap, undefined, coverMap)
  urls.push(...result.map(t => t.cover).filter(Boolean))
  return result
}
async function coverBytes(track) {
  return Buffer.from(await (await fetch(track.cover)).arrayBuffer())
}
function tagged({ lyrics, picture } = {}) {
  const frames = []
  function frame(id, body) {
    const head = Buffer.alloc(10)
    head.write(id)
    head.writeUInt32BE(body.length, 4)
    frames.push(head, body)
  }
  if (lyrics) frame('USLT', Buffer.concat([Buffer.from([3]), Buffer.from('eng\0'), Buffer.from(lyrics)]))
  if (picture) frame('APIC', Buffer.concat([Buffer.from([3]), Buffer.from('image/png\0'), Buffer.from([3, 0]), picture]))
  const body = Buffer.concat(frames)
  const head = Buffer.from([73, 68, 51, 3, 0, 0, (body.length >> 21) & 127, (body.length >> 14) & 127, (body.length >> 7) & 127, body.length & 127])
  return Buffer.concat([head, body])
}
function pass(name) { checks++; console.log(`PASS ${name}`) }

try {
  const specific = Buffer.alloc(80, 1), generic = Buffer.alloc(80, 2), embedded = Buffer.alloc(80, 3)
  let [track] = await tracks([file('Album/Song.mp3'), file('Album/Song.WEBP', specific), file('Album/cover.jpg', generic)])
  assert.deepEqual(await coverBytes(track), specific)
  assert.equal((await fetch(track.cover)).headers.get('content-type'), 'image/webp')
  pass('same-name artwork wins over generic artwork, with case-insensitive extension and MIME fallback')

  ;[track] = await tracks([file('Song.mp3'), file('folder.png', generic), file('front.jpg', specific), file('cover.jpeg', embedded)])
  assert.deepEqual(await coverBytes(track), embedded)
  pass('generic artwork follows cover, folder, front priority')

  ;[track] = await tracks([file('Album/Song.mp3'), file('cover.jpg', generic)])
  assert.equal(track.cover, undefined)
  pass('parent artwork never leaks into a child directory')

  ;[track] = await tracks([file('Song.mp3', tagged({ picture: embedded })), file('Song.png', specific)])
  assert.deepEqual(await coverBytes(track), embedded)
  pass('embedded artwork wins over sidecar artwork')

  ;[track] = await tracks([file('Song.mp3', tagged({ lyrics: '内嵌歌词' })), file('Song.lrc', '\ufeff  \r\n')])
  assert.equal(track.embeddedLyrics, '内嵌歌词')
  pass('blank sidecar lyrics preserve embedded lyrics')

  const lyric = '[00:01.00]中文'
  const le = Buffer.concat([Buffer.from([255, 254]), Buffer.from(lyric, 'utf16le')])
  const be = Buffer.from(le)
  be.swap16()
  const gb = Buffer.concat([Buffer.from('[00:01.00]'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4])])
  for (const bytes of [Buffer.from('\ufeff' + lyric), le, be, gb]) {
    ;[track] = await tracks([file('Song.mp3'), file('Song.lrc', bytes)])
    assert.equal(track.embeddedLyrics, lyric)
  }
  pass('UTF-8 BOM, UTF-16LE/BE BOM, and GB18030 lyrics decode correctly')

  function directory(name, entries) {
    return { name, kind: 'directory', async *values() { yield* entries } }
  }
  function entry(f) { return { kind: 'file', name: f.name, async getFile() { return f } } }
  const audio = file('Album/Song.mp3'), art = file('Album/folder.png', specific), lrc = file('Album/Song.lrc', lyric)
  const handle = directory('Root', [entry(file('cover.jpg', generic)), directory('Album', [entry(audio), entry(art), entry(lrc)])])
  const scanned = await scanHandle(handle)
  urls.push(...scanned.map(t => t.cover).filter(Boolean))
  assert.equal(scanned[0].embeddedLyrics, lyric)
  assert.deepEqual(await coverBytes(scanned[0]), specific)
  pass('directory handle import uses the same local artwork and lyric behavior as file input')
  console.log(`${checks} local asset regression checks passed`)
} finally {
  urls.forEach(url => URL.revokeObjectURL(url))
}
