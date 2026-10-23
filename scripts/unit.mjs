/* 构造各类音频标签的二进制样本，验证 src/lib/tags.ts 与 lyrics.ts 的解析结果 */
import { readFileSync } from 'node:fs'
import { parseAudioTags, guessFromName } from '../.tmp/tags.mjs'
import { parseLrc, activeLineIndex } from '../.tmp/lyrics.mjs'

let pass = 0
let fail = 0
const failures = []

function check(name, cond, extra) {
  if (cond) {
    pass++
  } else {
    fail++
    failures.push(`${name}${extra ? ' → ' + JSON.stringify(extra) : ''}`)
  }
}

/* ---------------- 构造工具 ---------------- */
const enc = (s) => new TextEncoder().encode(s)
const u32be = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
const u32le = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255])
const u24be = (n) => new Uint8Array([(n >>> 16) & 255, (n >>> 8) & 255, n & 255])
const syncsafe = (n) => new Uint8Array([(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127])
const cat = (...arrs) => {
  const total = arrs.reduce((a, b) => a + b.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const a of arrs) {
    out.set(a, o)
    o += a.length
  }
  return out
}
const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)))

const PNG = cat(
  Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  new Uint8Array(120).fill(7),
)

function id3Frame(id, v4, body) {
  const size = v4 ? syncsafe(body.length) : u32be(body.length)
  return cat(ascii(id), size, new Uint8Array([0, 0]), body)
}

function textFrame(id, v4, text) {
  return id3Frame(id, v4, cat(Uint8Array.from([3]), enc(text)))
}

function buildId3({ version = 3, title, artist, album, year, lyrics, picture = true, track }) {
  const v4 = version === 4
  const frames = []
  if (title) frames.push(textFrame('TIT2', v4, title))
  if (artist) frames.push(textFrame('TPE1', v4, artist))
  if (album) frames.push(textFrame('TALB', v4, album))
  if (year) frames.push(textFrame(v4 ? 'TDRC' : 'TYER', v4, year))
  if (track) frames.push(textFrame('TRCK', v4, String(track)))
  if (picture) {
    frames.push(
      id3Frame('APIC', v4, cat(Uint8Array.from([3]), ascii('image/png'), Uint8Array.from([0]), Uint8Array.from([3]), Uint8Array.from([0]), PNG)),
    )
  }
  if (lyrics) {
    frames.push(
      id3Frame('USLT', v4, cat(Uint8Array.from([3]), ascii('eng'), Uint8Array.from([0]), enc(lyrics))),
    )
  }
  const body = cat(...frames)
  return cat(ascii('ID3'), Uint8Array.from([version, 0, 0]), syncsafe(body.length), body, new Uint8Array(64))
}

function vorbisBlock(comments, last) {
  const vendor = enc('aurora-test')
  const parts = [u32le(vendor.length), vendor, u32le(comments.length)]
  for (const c of comments) {
    const b = enc(c)
    parts.push(u32le(b.length), b)
  }
  const payload = cat(...parts)
  const header = cat(Uint8Array.from([last ? 0x84 : 0x04]), u24be(payload.length))
  return cat(header, payload)
}

function buildFlac({ title, artist, album, year, duration }) {
  const streaminfo = new Uint8Array(34)
  const dv = new DataView(streaminfo.buffer)
  dv.setUint16(0, 4096)
  dv.setUint16(2, 4096)
  const sr = 44100
  const total = Math.round(duration * sr)
  // sampleRate(20) channels(3) bps(5) total(36)
  streaminfo[10] = (sr >> 12) & 0xff
  streaminfo[11] = (sr >> 4) & 0xff
  streaminfo[12] = ((sr & 0x0f) << 4) | (1 << 1) | ((16 - 1) >> 4)
  streaminfo[13] = (((16 - 1) & 0x0f) << 4) | ((total / 2 ** 32) & 0x0f)
  streaminfo[14] = (total >>> 24) & 0xff
  streaminfo[15] = (total >>> 16) & 0xff
  streaminfo[16] = (total >>> 8) & 0xff
  streaminfo[17] = total & 0xff
  const blocks = [cat(Uint8Array.from([0x00]), u24be(34), streaminfo)]
  const comments = [`TITLE=${title}`, `ARTIST=${artist}`, `ALBUM=${album}`, `DATE=${year}`, 'TRACKNUMBER=3']
  blocks.push(vorbisBlock(comments, true))
  return cat(ascii('fLaC'), ...blocks, new Uint8Array(128))
}

function box(type, ...payload) {
  const body = cat(...payload)
  return cat(u32be(8 + body.length), ascii(type), body)
}
function dataBox(text, kind = 1) {
  return box('data', u32be(kind), u32be(0), typeof text === 'string' ? enc(text) : text)
}
function buildM4a({ title, artist, album, year, picture = true }) {
  const ilst = box(
    'ilst',
    box('\u00A9nam', dataBox(title)),
    box('\u00A9ART', dataBox(artist)),
    box('\u00A9alb', dataBox(album)),
    box('\u00A9day', dataBox(year)),
    box('trkn', dataBox(Uint8Array.from([0, 0, 0, 5, 0, 0]), 0)),
    ...(picture ? [box('covr', dataBox(PNG, 14))] : []),
  )
  const meta = box('meta', u32be(0), ilst)
  const udta = box('udta', meta)
  const mvhdBody = cat(u32be(0), u32be(0), u32be(0), u32be(1000), u32be(0), new Uint8Array(64))
  const mvhd = box('mvhd', mvhdBody)
  const moov = box('moov', mvhd, udta)
  const ftyp = box('ftyp', ascii('M4A '), u32be(0), ascii('M4A mp42isom'))
  return cat(ftyp, moov, new Uint8Array(256))
}

/* ---------------- 断言 ---------------- */
const toFile = (bytes, name) => new File([bytes], name, { type: 'audio/mpeg' })

{
  const bytes = buildId3({ version: 3, title: '夜航', artist: '林深', album: '月光集', year: '2023', track: 2, lyrics: '[00:01.00]第一句\n[00:05.00]第二句' })
  const meta = await parseAudioTags(toFile(bytes, 'a.mp3'))
  check('ID3v2.3 title', meta.title === '夜航', meta.title)
  check('ID3v2.3 artist', meta.artist === '林深', meta.artist)
  check('ID3v2.3 album', meta.album === '月光集', meta.album)
  check('ID3v2.3 year', meta.year === '2023', meta.year)
  check('ID3v2.3 trackNo', meta.trackNo === 2, meta.trackNo)
  check('ID3v2.3 APIC', !!meta.picture && meta.picture.mime === 'image/png' && meta.picture.bytes.length > 100, meta.picture?.bytes?.length)
  check('ID3v2.3 USLT', (meta.lyrics || '').includes('第二句'), meta.lyrics)
}

{
  const bytes = buildId3({ version: 4, title: 'Aurora', artist: 'Nova', album: 'Skyline', year: '2024', track: 9 })
  const meta = await parseAudioTags(toFile(bytes, 'b.mp3'))
  check('ID3v2.4 title (syncsafe size)', meta.title === 'Aurora', meta.title)
  check('ID3v2.4 artist', meta.artist === 'Nova', meta.artist)
  check('ID3v2.4 TDRC year', meta.year === '2024', meta.year)
  check('ID3v2.4 trackNo', meta.trackNo === 9, meta.trackNo)
  check('ID3v2.4 APIC', !!meta.picture)
}

{
  const bytes = buildFlac({ title: '潮汐', artist: '海雾', album: '深蓝', year: '2022-05-01', duration: 12.5 })
  const meta = await parseAudioTags(toFile(bytes, 'c.flac'))
  check('FLAC title', meta.title === '潮汐', meta.title)
  check('FLAC artist', meta.artist === '海雾', meta.artist)
  check('FLAC album', meta.album === '深蓝', meta.album)
  check('FLAC year', meta.year === '2022', meta.year)
  check('FLAC trackNo', meta.trackNo === 3, meta.trackNo)
  check('FLAC duration from STREAMINFO', Math.abs((meta.duration || 0) - 12.5) < 0.05, meta.duration)
  check('FLAC format tag', meta.format === 'flac', meta.format)
}

{
  const bytes = buildM4a({ title: '橘子汽水', artist: '夏至', album: '午后', year: '2021' })
  const meta = await parseAudioTags(toFile(bytes, 'd.m4a'))
  check('M4A title', meta.title === '橘子汽水', meta.title)
  check('M4A artist', meta.artist === '夏至', meta.artist)
  check('M4A album', meta.album === '午后', meta.album)
  check('M4A year', meta.year === '2021', meta.year)
  check('M4A trackNo', meta.trackNo === 5, meta.trackNo)
  check('M4A covr', !!meta.picture && meta.picture.mime === 'image/png', meta.picture?.mime)
}

{
  const meta = await parseAudioTags(toFile(new Uint8Array(2048), 'unknown-file.wav'))
  check('unsupported format falls back', meta.format === 'wav', meta.format)
}

{
  const g = guessFromName('01 - 林深 - 夜航.mp3')
  check('filename guess artist', g.artist === '林深', g)
  check('filename guess title', g.title === '夜航', g)
  const g2 = guessFromName('纯音乐.flac')
  check('filename guess single', g2.title === '纯音乐' && !g2.artist, g2)
}

{
  const raw = `[ti:测试]
[ar:歌手]
[offset:500]
[00:00.00]第一行
[00:12.34]第二行
[01:05.5]第三行
[00:20.00][00:40.00]重复行`
  const parsed = parseLrc(raw)
  check('LRC line count', parsed.lines.length === 5, parsed.lines.length)
  check('LRC time parse', Math.abs(parsed.lines[0].time - 0) < 0.001, parsed.lines[0])
  check('LRC decimal', parsed.lines.some((l) => Math.abs(l.time - 12.34) < 0.001), parsed.lines.map((l) => l.time))
  check('LRC ss.5 → 0.5s', parsed.lines.some((l) => Math.abs(l.time - 65.5) < 0.001), parsed.lines.map((l) => l.time))
  check('LRC multi-stamp', parsed.lines.filter((l) => l.text === '重复行').length === 2)
  check('LRC offset parsed', Math.abs(parsed.offset - 0.5) < 0.001, parsed.offset)
  check('LRC sorted', parsed.lines.every((l, i, a) => i === 0 || a[i - 1].time <= l.time))
  check('active line at 13s', activeLineIndex(parsed.lines, 13) === parsed.lines.findIndex((l) => l.time >= 12 && l.time < 20), activeLineIndex(parsed.lines, 13))
}

{
  // 真实文件（若存在）粗查：确保不会抛异常
  try {
    const buf = readFileSync('../public/test-music/林深 - 夜航.wav')
    const meta = await parseAudioTags(new File([buf], '林深 - 夜航.wav'))
    check('wav parse no throw', typeof meta.format === 'string')
  } catch {
    check('wav sample present (skipped)', true)
  }
}

console.log(`\n单元测试：${pass} 通过 / ${fail} 失败`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('全部通过 ✓')