// Public metadata only: song names are sent; audio and local paths never leave the device.
// Endpoint reference: https://github.com/MakcRe/KuGouMusicApi/blob/main/module/lyric.js
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const JSON_LIMIT = 512 * 1024
const IMAGE_LIMIT = 2 * 1024 * 1024
const LYRIC_LIMIT = 128 * 1024
const TIMEOUT = 6000
const DAY = 86400000
const normalize = (value) => String(value || '').normalize('NFKC').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').toLocaleLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '')
const artists = (value) => String(value || '').split(/[,，、/&;；＋+]/).map(normalize).filter(Boolean).sort().join('|')

function validate(input) {
  if (!input || typeof input !== 'object') throw new Error('无效的歌曲信息')
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  const artist = typeof input.artist === 'string' ? input.artist.trim() : ''
  if (!title || !artist || title.length > 200 || artist.length > 200 || /[\x00-\x1f]/.test(title + artist)) throw new Error('请提供有效的歌名和歌手')
  const duration = Number(input.duration)
  if (!Number.isFinite(duration) || duration < 0 || duration > 86400) throw new Error('无效的歌曲时长')
  return { title, artist, duration, refresh: input.refresh === true }
}

function matches(track, title, artist, duration) {
  return normalize(track.title) === normalize(title) && artists(track.artist) === artists(artist) &&
    Number.isFinite(Number(duration)) && Math.abs(track.duration - Number(duration)) <= 3
}

function safeCoverUrl(raw) {
  try {
    const url = new URL(String(raw).replace('{size}', '500'))
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
      !['imge.kugou.com', 'imgessl.kugou.com'].includes(url.hostname) ||
      !/^\/stdmusic\/[\d/]+[\w-]+\.(jpg|jpeg|png|webp)$/i.test(url.pathname) || url.search || url.hash) return null
    url.protocol = 'https:'
    return url
  } catch { return null }
}

function imageMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  return null
}

function createMetadata({ cacheDir, fetchImpl = globalThis.fetch } = {}) {
  const pending = new Map()
  const memory = new Map()

  async function request(url, limit, json = true) {
    const controller = new AbortController()
    let timer
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('资料源连接超时')) }, TIMEOUT)
    })
    try {
      return await Promise.race([deadline, (async () => {
        const res = await fetchImpl(String(url), { signal: controller.signal, redirect: 'manual', headers: { 'User-Agent': 'AuroraMusic/1.2 (local music metadata)', Accept: json ? 'application/json' : 'image/jpeg,image/png,image/webp' } })
        if (!res.ok || (Number(res.headers.get('content-length')) || 0) > limit) throw new Error('资料源暂不可用')
        let size = 0
        const chunks = []
        const reader = res.body?.getReader()
        if (!reader) throw new Error('资料源返回为空')
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > limit) { await reader.cancel(); throw new Error('资料超过大小限制') }
            chunks.push(Buffer.from(value))
          }
        } finally { reader.releaseLock() }
        const bytes = Buffer.concat(chunks)
        return json ? JSON.parse(bytes.toString('utf8')) : bytes
      })()])
    } finally { clearTimeout(timer); controller.abort() }
  }

  async function songMatch(track) {
    const url = new URL('https://songsearch.kugou.com/song_search_v2')
    url.search = new URLSearchParams({ keyword: `${track.artist} ${track.title}`, page: '1', pagesize: '10', platform: 'WebFilter' }).toString()
    const result = await request(url, JSON_LIMIT)
    return (Array.isArray(result.data?.lists) ? result.data.lists : []).slice(0, 10).find((item) =>
      matches(track, item.SongName, item.SingerName, item.Duration) &&
      (!item.Suffix || normalize(track.title).includes(normalize(item.Suffix))))
  }

  async function cover(candidate) {
    const image = safeCoverUrl(candidate?.Image || candidate?.trans_param?.union_cover)
    if (!image) return undefined
    const bytes = await request(image, IMAGE_LIMIT, false)
    const mime = imageMime(bytes)
    return mime ? `data:${mime};base64,${bytes.toString('base64')}` : undefined
  }

  async function lyrics(track, songPromise) {
    const url = new URL('https://lyrics.kugou.com/search')
    url.search = new URLSearchParams({ ver: '1', man: 'yes', client: 'pc', keyword: `${track.artist} ${track.title}`, duration: String(Math.round(track.duration * 1000)) }).toString()
    const pick = (result) => (Array.isArray(result.candidates) ? result.candidates : []).slice(0, 20).find((item) =>
      matches(track, item.song, item.singer, Number(item.duration) / 1000) && /^\d{1,20}$/.test(String(item.id)) && /^[a-z0-9]{1,128}$/i.test(String(item.accesskey)))
    let candidate = pick(await request(url, JSON_LIMIT))
    if (!candidate) {
      const song = await songPromise.catch(() => null)
      if (/^[a-f\d]{32}$/i.test(song?.FileHash || '')) {
        // Some songs are absent from keyword lyric search but available by their matched public song hash.
        url.searchParams.delete('keyword')
        url.searchParams.set('hash', song.FileHash)
        candidate = pick(await request(url, JSON_LIMIT))
      }
    }
    if (!candidate) return undefined
    const download = new URL('https://lyrics.kugou.com/download')
    download.search = new URLSearchParams({ ver: '1', client: 'pc', id: String(candidate.id), accesskey: String(candidate.accesskey), fmt: 'lrc', charset: 'utf8' }).toString()
    const data = await request(download, JSON_LIMIT)
    if (typeof data.content !== 'string' || data.content.length > LYRIC_LIMIT * 1.4 || !/^[a-z\d+/=\s]+$/i.test(data.content)) return undefined
    const bytes = Buffer.from(data.content, 'base64')
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '').trim()
    return bytes.length <= LYRIC_LIMIT && /\[\d{1,3}:\d{2}(?:[.:]\d+)?\]/.test(text) && !text.includes('\u0000') && !text.includes('\uFFFD') ? text : undefined
  }

  function cleanResult(value) {
    if (!value || typeof value !== 'object') return null
    const result = { matched: false, source: '酷狗音乐' }
    if (typeof value.cover === 'string' && value.cover.length < IMAGE_LIMIT * 1.4 && /^data:image\/(jpeg|png|webp);base64,[a-z\d+/=]+$/i.test(value.cover)) result.cover = value.cover
    if (typeof value.lyrics === 'string' && Buffer.byteLength(value.lyrics) <= LYRIC_LIMIT && /\[\d{1,3}:\d{2}(?:[.:]\d+)?\]/.test(value.lyrics)) result.lyrics = value.lyrics
    result.matched = Boolean(result.cover || result.lyrics)
    result.message = result.cover && result.lyrics ? '已自动补全封面与歌词' : result.cover ? '已补全封面，暂未找到可靠歌词' : result.lyrics ? '已补全歌词，暂未找到可靠封面' : '未找到歌名、歌手和时长一致的资料，可添加本地封面或 .lrc 文件'
    return result
  }

  async function cached(key) {
    if (memory.has(key)) return memory.get(key)
    if (!cacheDir) return null
    try {
      const file = path.join(cacheDir, `${key}.json`)
      if ((await fs.stat(file)).size > IMAGE_LIMIT * 1.5 + LYRIC_LIMIT) return null
      const entry = JSON.parse(await fs.readFile(file, 'utf8'))
      if (entry.version !== 1 || !Number.isFinite(entry.expires)) return null
      const result = cleanResult(entry.result)
      if (!result) return null
      const valid = { expires: entry.expires, result }
      memory.set(key, valid)
      if (memory.size > 100) memory.delete(memory.keys().next().value)
      return valid
    } catch { return null }
  }

  async function lookup(input) {
    const track = validate(input)
    if (!track.duration) return { matched: false, message: '正在读取歌曲时长，完成后自动匹配封面和歌词' }
    const key = createHash('sha256').update(JSON.stringify([normalize(track.title), artists(track.artist), Math.round(track.duration)])).digest('hex')
    if (pending.has(key)) return pending.get(key)
    const job = (async () => {
      const previous = await cached(key)
      if (!track.refresh && previous?.expires > Date.now()) return previous.result
      const songPromise = songMatch(track)
      const [art, lrc] = await Promise.allSettled([songPromise.then(cover), lyrics(track, songPromise)])
      const result = cleanResult({
        cover: (art.status === 'fulfilled' ? art.value : undefined) || previous?.result.cover,
        lyrics: (lrc.status === 'fulfilled' ? lrc.value : undefined) || previous?.result.lyrics,
      })
      const failed = art.status === 'rejected' || lrc.status === 'rejected'
      if (failed) result.message = result.matched ? '资料源暂不可用，已使用本地缓存或已匹配的资料' : '资料源暂不可用，稍后重试；也可添加本地封面或 .lrc 文件'
      const ttl = result.cover && result.lyrics ? 30 * DAY : result.matched ? 30 * 60000 : failed ? 60000 : 15 * 60000
      const entry = { version: 1, expires: Date.now() + ttl, result }
      memory.set(key, entry)
      // A bounded memory cache; all successful entries remain available on disk.
      if (memory.size > 100) memory.delete(memory.keys().next().value)
      if (cacheDir) {
        try { await fs.mkdir(cacheDir, { recursive: true }); await fs.writeFile(path.join(cacheDir, `${key}.json`), JSON.stringify(entry), 'utf8') } catch { /* metadata remains usable when the cache directory is read-only */ }
      }
      return result
    })()
    pending.set(key, job)
    try { return await job } finally { pending.delete(key) }
  }

  return { lookup }
}

module.exports = { createMetadata }
