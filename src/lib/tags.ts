export interface Picture {
  mime: string
  bytes: Uint8Array
}

export interface ParsedMeta {
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  year?: string
  genre?: string
  trackNo?: number
  duration?: number
  picture?: Picture
  lyrics?: string
  format: string
}

export interface AudioTagFile { name: string; size: number; slice: (start: number, end: number) => { arrayBuffer: () => Promise<ArrayBuffer> } }

export const AUDIO_EXT = ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'wma', 'ape', 'm4b', 'mp4', 'aiff', 'aif', 'alac']

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

export function isAudioFile(name: string): boolean {
  return AUDIO_EXT.includes(extOf(name))
}

export function isLyricFile(name: string): boolean {
  return extOf(name) === 'lrc' || extOf(name) === 'txt'
}

/* ------------------------------------------------------------------ */
/* 低层字节工具                                                        */
/* ------------------------------------------------------------------ */

const tdLatin = new TextDecoder('latin1')
const tdUtf8 = new TextDecoder('utf-8')
const tdUtf16le = new TextDecoder('utf-16le')
const tdUtf16be = new TextDecoder('utf-16be')

function dv(u8: Uint8Array): DataView {
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
}

function latin(bytes: Uint8Array, start: number, len: number): string {
  return tdLatin.decode(bytes.subarray(start, start + len))
}

function u24be(view: DataView, o: number): number {
  return (view.getUint8(o) << 16) | (view.getUint8(o + 1) << 8) | view.getUint8(o + 2)
}

function syncsafe(view: DataView, o: number): number {
  return (
    ((view.getUint8(o) & 0x7f) << 21) |
    ((view.getUint8(o + 1) & 0x7f) << 14) |
    ((view.getUint8(o + 2) & 0x7f) << 7) |
    (view.getUint8(o + 3) & 0x7f)
  )
}

function clean(s: string): string {
  return s.replace(/\u0000+$/g, '').replace(/\u0000/g, '').trim()
}

/** 解码一个「以 0x00(或 0x0000) 结尾」的字符串，返回文本与结束位置 */
function readTerminated(
  bytes: Uint8Array,
  offset: number,
  enc: number,
): { text: string; end: number } {
  let i = offset
  if (enc === 0 || enc === 3) {
    while (i < bytes.length && bytes[i] !== 0) i++
    const text = enc === 0 ? tdLatin.decode(bytes.subarray(offset, i)) : tdUtf8.decode(bytes.subarray(offset, i))
    return { text: clean(text), end: Math.min(i + 1, bytes.length) }
  }
  // UTF-16：按 2 字节对齐查找 00 00
  while (i + 1 < bytes.length && !(bytes[i] === 0 && bytes[i + 1] === 0)) i += 2
  const slice = bytes.subarray(offset, i)
  let text = ''
  if (enc === 1) {
    if (slice.length >= 2 && slice[0] === 0xff && slice[1] === 0xfe) text = tdUtf16le.decode(slice.subarray(2))
    else if (slice.length >= 2 && slice[0] === 0xfe && slice[1] === 0xff) text = tdUtf16be.decode(slice.subarray(2))
    else text = tdUtf16le.decode(slice)
  } else {
    text = tdUtf16be.decode(slice)
  }
  return { text: clean(text), end: Math.min(i + 2, bytes.length) }
}

function decodeTextFrame(bytes: Uint8Array, offset: number, len: number): string {
  if (len <= 0) return ''
  const enc = bytes[offset]
  const body = bytes.subarray(offset + 1, offset + len)
  if (enc === 0) return clean(tdLatin.decode(body))
  if (enc === 3) return clean(tdUtf8.decode(body))
  if (enc === 2) return clean(tdUtf16be.decode(stripBom(body, true)))
  return clean(tdUtf16le.decode(stripBom(body, false)))
}

function stripBom(b: Uint8Array, preferBe: boolean): Uint8Array {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2)
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return b.subarray(2)
  return b
}

/* ------------------------------------------------------------------ */
/* ID3v2 (MP3)                                                        */
/* ------------------------------------------------------------------ */

const ID3_TEXT_MAP: Record<string, keyof ParsedMeta> = {
  TIT2: 'title', TT2: 'title',
  TPE1: 'artist', TP1: 'artist',
  TPE2: 'albumArtist', TP2: 'albumArtist',
  TALB: 'album', TAL: 'album',
  TYER: 'year', TDRC: 'year', TYE: 'year',
  TCON: 'genre', TCO: 'genre',
}

function parseId3(bytes: Uint8Array, base: number): { meta: ParsedMeta; end: number } {
  const view = dv(bytes)
  const major = view.getUint8(base + 3)
  const flags = view.getUint8(base + 5)
  const tagSize = syncsafe(view, base + 6)
  const meta: ParsedMeta = { format: 'mp3' }
  const start = base + 10
  const end = Math.min(bytes.length, start + tagSize)

  let p = start
  // 扩展头
  if (flags & 0x40) {
    if (major === 4) p += syncsafe(view, p)
    else p += view.getUint32(p) + 4
    if (p < start) p = start
  }

  const idLen = major === 2 ? 3 : 4
  const headerLen = major === 2 ? 6 : 10

  while (p + headerLen <= end) {
    const id = latin(bytes, p, idLen)
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break
    let size: number
    if (major === 2) size = u24be(view, p + 3)
    else if (major === 3) size = view.getUint32(p + 4)
    else size = syncsafe(view, p + 4)
    if (size <= 0 || p + headerLen + size > end + 8) break

    const body = p + headerLen
    const mapped = ID3_TEXT_MAP[id]
    if (mapped) {
      const txt = decodeTextFrame(bytes, body, size)
      if (txt) (meta as unknown as Record<string, unknown>)[mapped] = txt
    } else if (id === 'TRCK' || id === 'TRK') {
      const txt = decodeTextFrame(bytes, body, size)
      const n = parseInt(txt, 10)
      if (!Number.isNaN(n)) meta.trackNo = n
    } else if (id === 'APIC' || id === 'PIC') {
      try {
        meta.picture = meta.picture ?? parseApic(bytes, body, size, major === 2)
      } catch { /* 忽略损坏的封面帧 */ }
    } else if (id === 'USLT' || id === 'ULT') {
      try {
        const enc = bytes[body]
        let o = body + 1 + 3 // encoding + language
        const desc = readTerminated(bytes, o, enc)
        o = desc.end
        const ly = enc === 0 || enc === 3
          ? (enc === 0 ? tdLatin.decode(bytes.subarray(o, body + size)) : tdUtf8.decode(bytes.subarray(o, body + size)))
          : (enc === 2 ? tdUtf16be.decode(bytes.subarray(o, body + size)) : tdUtf16le.decode(stripBom(bytes.subarray(o, body + size), false)))
        const text = ly.replace(/\u0000/g, '').trim()
        if (text) meta.lyrics = text
      } catch { /* noop */ }
    } else if (id === 'TXXX') {
      // 部分软件把歌词放在 TXXX:LYRICS 中
      try {
        const enc = bytes[body]
        const desc = readTerminated(bytes, body + 1, enc)
        if (/lyric/i.test(desc.text)) {
          const o = desc.end
          const val = enc === 3 ? tdUtf8.decode(bytes.subarray(o, body + size))
            : enc === 0 ? tdLatin.decode(bytes.subarray(o, body + size))
            : enc === 2 ? tdUtf16be.decode(bytes.subarray(o, body + size))
            : tdUtf16le.decode(stripBom(bytes.subarray(o, body + size), false))
          const t = val.replace(/\u0000/g, '').trim()
          if (t) meta.lyrics = meta.lyrics || t
        }
      } catch { /* noop */ }
    }
    p = body + size
  }
  return { meta, end }
}

function parseApic(bytes: Uint8Array, offset: number, size: number, v22: boolean): Picture | undefined {
  const enc = bytes[offset]
  let p = offset + 1
  const lim = offset + size
  let mime = 'image/jpeg'
  if (v22) {
    // v2.2 PIC: encoding, 3 字符格式（JPG/PNG），然后 picture type
    const fmt = latin(bytes, p, 3).toUpperCase()
    p += 3
    mime = fmt.includes('PNG') ? 'image/png' : 'image/jpeg'
  } else {
    let e = p
    while (e < lim && bytes[e] !== 0) e++
    mime = latin(bytes, p, e - p) || 'image/jpeg'
    if (mime.includes('/') === false) mime = 'image/jpeg'
    p = e + 1
  }
  p += 1 // picture type
  const desc = readTerminated(bytes, p, enc)
  p = desc.end
  if (p >= lim) return undefined
  const data = bytes.slice(p, lim)
  if (data.length < 64) return undefined
  return { mime, bytes: data }
}

/* ------------------------------------------------------------------ */
/* FLAC                                                               */
/* ------------------------------------------------------------------ */

function parseVorbisComments(bytes: Uint8Array, offset: number): Record<string, string> {
  const view = dv(bytes)
  const out: Record<string, string> = {}
  let p = offset
  const vendorLen = view.getUint32(p, true)
  p += 4 + vendorLen
  if (p + 4 > bytes.length) return out
  const count = view.getUint32(p, true)
  p += 4
  for (let i = 0; i < count && p + 4 <= bytes.length; i++) {
    const len = view.getUint32(p, true)
    p += 4
    if (p + len > bytes.length) break
    const entry = tdUtf8.decode(bytes.subarray(p, p + len))
    p += len
    const eq = entry.indexOf('=')
    if (eq > 0) {
      const key = entry.slice(0, eq).toLowerCase()
      const val = entry.slice(eq + 1).trim()
      if (val && !(key in out)) out[key] = val
    }
  }
  return out
}

function parseFlac(bytes: Uint8Array): ParsedMeta {
  const meta: ParsedMeta = { format: 'flac' }
  const view = dv(bytes)
  let p = 4
  let guard = 0
  while (p + 4 <= bytes.length && guard++ < 128) {
    const header = view.getUint8(p)
    const last = (header & 0x80) !== 0
    const type = header & 0x7f
    const len = u24be(view, p + 1)
    const start = p + 4
    if (start + len > bytes.length) break // 元数据块超出读取窗口

    if (type === 0 && len >= 18) {
      // STREAMINFO
      const b = bytes.subarray(start, start + 18)
      const sr = ((b[10] << 12) | (b[11] << 4) | (b[12] >> 4)) & 0xfffff
      const totalHi = b[13] & 0x0f
      const total = totalHi * 2 ** 32 + ((b[14] << 24) >>> 0) + (b[15] << 16) + (b[16] << 8) + b[17]
      if (sr > 0 && total > 0) meta.duration = total / sr
    } else if (type === 4) {
      const c = parseVorbisComments(bytes, start)
      if (c.title) meta.title = c.title
      if (c.artist) meta.artist = c.artist
      if (c.album) meta.album = c.album
      if (c.albumartist) meta.albumArtist = c.albumartist
      if (c.date) meta.year = (c.date.match(/\d{4}/) || [])[0] || c.date
      if (c.genre) meta.genre = c.genre
      if (c.tracknumber) meta.trackNo = parseInt(c.tracknumber, 10) || undefined
      if (c.lyrics || c.unsyncedlyrics) meta.lyrics = (c.lyrics || c.unsyncedlyrics)!.trim()
    } else if (type === 6 && len > 32) {
      // PICTURE
      let q = start
      const type_ = view.getUint32(q)
      q += 4
      const mimeLen = view.getUint32(q)
      q += 4
      const mime = latin(bytes, q, mimeLen)
      q += mimeLen
      const descLen = view.getUint32(q)
      q += 4 + descLen
      q += 16 // width/height/depth/colors
      const dataLen = view.getUint32(q)
      q += 4
      if (dataLen > 0 && q + dataLen <= start + len) {
        const data = bytes.slice(q, q + dataLen)
        if (data.length > 64) {
          const pic = { mime: mime || 'image/jpeg', bytes: data }
          if (type_ === 3 || !meta.picture) meta.picture = pic
        }
      }
    }
    if (last) break
    p = start + len
  }
  return meta
}

/* ------------------------------------------------------------------ */
/* MP4 / M4A                                                          */
/* ------------------------------------------------------------------ */

function findBox(bytes: Uint8Array, start: number, end: number, type: string): { start: number; end: number } | null {
  const view = dv(bytes)
  let p = start
  let guard = 0
  while (p + 8 <= end && guard++ < 4096) {
    let size = view.getUint32(p)
    const t = latin(bytes, p + 4, 4)
    let headerLen = 8
    if (size === 1) {
      // 64 位长度
      const hi = view.getUint32(p + 8)
      const lo = view.getUint32(p + 12)
      size = hi * 2 ** 32 + lo
      headerLen = 16
    } else if (size === 0) {
      size = end - p
    }
    if (size < headerLen) break
    if (t === type) return { start: p + headerLen, end: Math.min(p + size, end) }
    p += size
  }
  return null
}

function parseIlst(bytes: Uint8Array): ParsedMeta {
  const meta: ParsedMeta = { format: 'm4a' }
  const view = dv(bytes)
  let p = 0
  const end = bytes.length
  let guard = 0
  while (p + 8 <= end && guard++ < 512) {
    let size = view.getUint32(p)
    const t = latin(bytes, p + 4, 4)
    let hl = 8
    if (size === 1) {
      size = view.getUint32(p + 12) + view.getUint32(p + 8) * 2 ** 32
      hl = 16
    }
    if (size < hl) break
    const bodyStart = p + hl
    const bodyEnd = Math.min(p + size, end)

    // data box
    const data = findBox(bytes, bodyStart, bodyEnd, 'data')
    if (data) {
      const flagsView = dv(bytes.subarray(data.start, data.end))
      const kind = flagsView.getUint32(0) & 0xffffff
      const payload = bytes.subarray(data.start + 8, data.end)
      if (t === '\u00A9nam') meta.title = tdUtf8.decode(payload).trim()
      else if (t === '\u00A9ART') meta.artist = tdUtf8.decode(payload).trim()
      else if (t === 'aART') meta.albumArtist = tdUtf8.decode(payload).trim()
      else if (t === '\u00A9alb') meta.album = tdUtf8.decode(payload).trim()
      else if (t === '\u00A9day') meta.year = (tdUtf8.decode(payload).match(/\d{4}/) || [])[0]
      else if (t === '\u00A9gen') meta.genre = tdUtf8.decode(payload).trim()
      else if (t === '\u00A9lyr') meta.lyrics = tdUtf8.decode(payload).trim()
      else if (t === 'trkn') {
        if (payload.length >= 4) meta.trackNo = (payload[2] << 8) | payload[3]
      } else if (t === 'covr') {
        if (!meta.picture && payload.length > 64) {
          const mime = kind === 14 ? 'image/png' : 'image/jpeg'
          meta.picture = { mime, bytes: payload }
        }
      }
    }
    p = bodyEnd
  }
  return meta
}

/* ------------------------------------------------------------------ */
/* OGG (Vorbis / Opus)                                                */
/* ------------------------------------------------------------------ */

function parseOgg(bytes: Uint8Array): ParsedMeta {
  const meta: ParsedMeta = { format: 'ogg' }
  const text = latin(bytes, 0, Math.min(bytes.length, 1024 * 256))
  let tagOffset = -1
  const opus = text.indexOf('OpusTags')
  if (opus >= 0) tagOffset = opus + 8
  else {
    const vorbis = text.indexOf('\u0003vorbis')
    if (vorbis >= 0) tagOffset = vorbis + 7
  }
  if (tagOffset < 0) return meta
  const c = parseVorbisComments(bytes, tagOffset)
  if (c.title) meta.title = c.title
  if (c.artist) meta.artist = c.artist
  if (c.album) meta.album = c.album
  if (c.date) meta.year = (c.date.match(/\d{4}/) || [])[0] || undefined
  if (c.genre) meta.genre = c.genre
  if (c.tracknumber) meta.trackNo = parseInt(c.tracknumber, 10) || undefined
  if (c.lyrics || c.unsyncedlyrics) meta.lyrics = (c.lyrics || c.unsyncedlyrics)!.trim()
  return meta
}

/* ------------------------------------------------------------------ */
/* 入口                                                               */
/* ------------------------------------------------------------------ */

async function readSlice(file: AudioTagFile, start: number, end: number): Promise<Uint8Array> {
  const blob = file.slice(start, Math.min(end, file.size))
  return new Uint8Array(await blob.arrayBuffer())
}

async function readMp4(file: AudioTagFile): Promise<ParsedMeta> {
  const head = await readSlice(file, 0, Math.min(file.size, 1024 * 512))
  const view = dv(head)
  let p = 0
  let moov: { start: number; end: number } | null = null
  while (p + 8 <= head.length) {
    let size = view.getUint32(p)
    const t = latin(head, p + 4, 4)
    let hl = 8
    if (size === 1) {
      size = view.getUint32(p + 12) + view.getUint32(p + 8) * 2 ** 32
      hl = 16
    } else if (size === 0) {
      size = file.size - p
    }
    if (size < hl) break
    if (t === 'moov') {
      moov = { start: p, end: p + size }
      break
    }
    p += size
  }
  if (!moov) return { format: 'm4a' }
  const size = moov.end - moov.start
  const cap = Math.min(size, 32 * 1024 * 1024)
  const moovBytes = await readSlice(file, moov.start, moov.start + cap)
  // moovBytes 含 moov 自身的 box header，解析子 box 时跳过
  const mhView = dv(moovBytes)
  const moovHeaderLen = mhView.getUint32(0) === 1 ? 16 : 8
  const udta = findBox(moovBytes, moovHeaderLen, moovBytes.length, 'udta')
  if (!udta) return { format: 'm4a' }
  const metaBox = findBox(moovBytes, udta.start, udta.end, 'meta')
  if (!metaBox) return { format: 'm4a' }
  // meta 是 full box，跳过 4 字节 version/flags
  const ilst = findBox(moovBytes, metaBox.start + 4, metaBox.end, 'ilst')
  if (!ilst) return { format: 'm4a' }
  const slice = moovBytes.subarray(ilst.start, ilst.end)
  const out = parseIlst(slice)
  // 时长从 mvhd 里取
  try {
    const mvhd = findBox(moovBytes, moovHeaderLen, moovBytes.length, 'mvhd')
    if (mvhd) {
      const v = dv(moovBytes.subarray(mvhd.start, mvhd.end))
      const ver = v.getUint8(0)
      const timescale = ver === 1 ? v.getUint32(20) : v.getUint32(12)
      const duration = ver === 1 ? v.getUint32(24) * 2 ** 32 + v.getUint32(28) : v.getUint32(16)
      if (timescale > 0) out.duration = duration / timescale
    }
  } catch { /* noop */ }
  return out
}

export async function parseAudioTags(file: AudioTagFile): Promise<ParsedMeta> {
  const ext = extOf(file.name)
  const head = await readSlice(file, 0, Math.min(file.size, 10))
  const isId3 = head.length >= 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33

  try {
    if (ext === 'm4a' || ext === 'm4b' || ext === 'mp4' || ext === 'aac' || ext === 'alac') {
      return await readMp4(file)
    }
    if (ext === 'flac' || (head.length >= 4 && latin(head, 0, 4) === 'fLaC')) {
      // 元数据区一般在文件头部；读前 16MB 足以覆盖绝大多数内嵌封面
      const bytes = await readSlice(file, 0, Math.min(file.size, 16 * 1024 * 1024))
      return parseFlac(bytes)
    }
    if (ext === 'ogg' || ext === 'opus' || (head.length >= 4 && latin(head, 0, 4) === 'OggS')) {
      const bytes = await readSlice(file, 0, Math.min(file.size, 1024 * 512))
      return parseOgg(bytes)
    }
    if (isId3 || ext === 'mp3') {
      if (!isId3) return { format: 'mp3' }
      const view = dv(head)
      const tagSize = syncsafe(view, 6)
      const want = Math.min(file.size, 10 + tagSize + 32)
      const bytes = await readSlice(file, 0, want)
      return parseId3(bytes, 0).meta
    }
  } catch {
    /* 解析失败时退回文件名推断 */
  }
  return { format: ext || 'audio' }
}

/** 从文件名推断「艺术家 - 标题」 */
export function guessFromName(filename: string): { title: string; artist?: string } {
  const base = filename.replace(/\.[^.]+$/, '').replace(/^\d+[\s._-]+/, '').trim()
  const m = base.split(/\s+-\s+|\s+–\s+/)
  if (m.length >= 2) return { artist: m[0].trim(), title: m.slice(1).join(' - ').trim() }
  return { title: base }
}
