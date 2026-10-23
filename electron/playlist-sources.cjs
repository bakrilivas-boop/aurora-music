// Public platform APIs only. No account cookies, third-party mirrors or audio requests.
// References: NeteaseCloudMusicApiEnhanced/api-enhanced module/{playlist_detail,song_download_url}.js
// and chongya369/qqmusic-api-py qqmusic/apis/songlists.py (musicu pagination).
const LIMIT = 1000
const MAX_REQUESTS = 10
const BODY_LIMIT = 2 * 1024 * 1024
const numericId = (value) => /^[1-9]\d{0,15}$/.test(String(value)) && Number.isSafeInteger(Number(value))
const qqId = (value) => /^[a-z\d]{10,20}$/i.test(String(value))
const text = (value, fallback = '') => typeof value === 'string' ? value.slice(0, 200).trim() || fallback : fallback

function parsePlaylistURL(input) {
  if (typeof input !== 'string' || input.length > 2000) throw new Error('请粘贴网易云音乐或 QQ 音乐的完整歌单链接')
  let url
  try { url = new URL(input.trim()) } catch { throw new Error('歌单链接格式不正确') }
  if (!['https:', 'http:'].includes(url.protocol) || url.port || url.username || url.password) throw new Error('不支持这个歌单链接')
  let id
  let source
  if (['music.163.com', 'y.music.163.com'].includes(url.hostname)) {
    if (url.hash.startsWith('#/')) url = new URL(url.hash.slice(1), 'https://music.163.com')
    if (!/^\/(?:m\/)?playlist\/?$/.test(url.pathname)) throw new Error('请使用网易云歌单链接，而不是歌曲或个人主页链接')
    id = url.searchParams.get('id')
    source = 'netease'
  } else if (['y.qq.com', 'i.y.qq.com'].includes(url.hostname)) {
    id = url.pathname.match(/^\/n\/(?:ryqq|yqq)\/playlist\/(\d+)(?:\.html)?\/?$/)?.[1]
    if (!id && (/^\/n\/(?:ryqq|yqq)\/playlist\/?$/.test(url.pathname) || /\/taoge(?:\/index)?\.html$/.test(url.pathname))) id = url.searchParams.get('disstid') || url.searchParams.get('id')
    source = 'qq'
  }
  if (!source || !numericId(id)) throw new Error('暂不支持此链接，请复制展开后的网易云或 QQ 音乐歌单地址')
  return { source, playlistId: String(id) }
}

function audioUrl(input, source) {
  try {
    const url = new URL(input)
    const allowed = source === 'netease' ? /^(?:[a-z\d-]+\.)*music\.126\.net$/i : /^(?:[a-z\d-]+\.)*stream\.qqmusic\.qq\.com$/i
    if (!['https:', 'http:'].includes(url.protocol) || url.port || url.username || url.password || !allowed.test(url.hostname)) return undefined
    url.protocol = 'https:'
    return url.href
  } catch { return undefined }
}

function neteaseTrack(song, privilege) {
  if (!song || !numericId(song.id)) return null
  return { id: String(song.id), source: 'netease', title: text(song.name, '未命名歌曲'), artist: (song.ar || song.artists || []).map((a) => text(a.name)).filter(Boolean).join('、').slice(0, 200) || '未知歌手', duration: Math.max(0, Number(song.dt || song.duration) / 1000 || 0), restricted: Number(song.fee || privilege?.fee || 0) !== 0 || !privilege || Number(privilege.dl) <= 0 || Number(privilege.st) < 0 || privilege.cp === 0 }
}

function qqTrack(song) {
  if (!song || !qqId(song.mid || song.songmid)) return null
  return { id: String(song.mid || song.songmid), source: 'qq', title: text(song.title || song.name || song.songname, '未命名歌曲'), artist: (song.singer || []).map((a) => text(a.name)).filter(Boolean).join('、').slice(0, 200) || '未知歌手', duration: Math.max(0, Number(song.interval) || 0), restricted: !song.pay || Number(song.pay.pay_down) !== 0 || Number(song.pay.pay_play) !== 0 }
}

function filename(track, extension) {
  const name = `${track.artist} - ${track.title}`.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 150)
  return `${name || '歌曲'}.${extension}`
}

function createPlaylistSources({ fetchImpl = globalThis.fetch, mirror = null } = {}) {
  // 备用音源解析器（见 music-mirror.cjs）：只在官方匿名接口给不出地址时兜底。
  const fallback = mirror && typeof mirror.resolve === 'function' ? mirror : null
  async function request(url, { signal } = {}) {
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    if (signal?.aborted) throw signal.reason || new Error('已取消')
    signal?.addEventListener('abort', abort, { once: true })
    let timer
    let onAbort
    const deadline = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason || new Error('已取消'))
      controller.signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => controller.abort(new Error('音乐平台连接超时，请稍后重试')), 8000)
    })
    try {
      return await Promise.race([deadline, (async () => {
        const response = await fetchImpl(String(url), { signal: controller.signal, redirect: 'manual', credentials: 'omit', headers: { Referer: new URL(url).hostname.endsWith('163.com') ? 'https://music.163.com/' : 'https://y.qq.com/', 'User-Agent': 'AuroraMusic/1.3', Accept: 'application/json' } })
        if (!response.ok || Number(response.headers.get('content-length')) > BODY_LIMIT) throw new Error('平台拒绝请求或资料过大，请使用公开歌单')
        const reader = response.body?.getReader()
        if (!reader) throw new Error('音乐平台没有返回歌单资料')
        const chunks = []
        let size = 0
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > BODY_LIMIT) { await reader.cancel(); throw new Error('歌单资料超过大小限制') }
            chunks.push(Buffer.from(value))
          }
        } finally { reader.releaseLock() }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
      })()])
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      controller.signal.removeEventListener('abort', onAbort)
      controller.abort()
    }
  }

  async function musicu(module, method, param, options) {
    const data = { comm: { uin: 0, format: 'json', ct: 24, cv: 0 }, req_0: { module, method, param } }
    const url = new URL('https://u.y.qq.com/cgi-bin/musicu.fcg')
    url.searchParams.set('data', JSON.stringify(data))
    const result = await request(url, options)
    if (result.code !== 0 || result.req_0?.code !== 0 || !result.req_0.data) throw new Error('QQ 音乐暂时无法读取此资料，可能需要登录或歌单未公开')
    return result.req_0.data
  }

  async function list(input, options) {
    const { source, playlistId } = parsePlaylistURL(input)
    const found = new Map()
    let total = 0
    let name = '歌单'
    let complete = false
    const warnings = []
    if (source === 'netease') {
      const result = await request(`https://music.163.com/api/v6/playlist/detail?id=${playlistId}&n=1000&s=0`, options)
      if (result.code !== 200 || !result.playlist) throw new Error('网易云暂时无法读取此歌单，可能需要登录或歌单未公开')
      const playlist = result.playlist
      name = text(playlist.name, '网易云歌单')
      total = Math.max(0, Number(playlist.trackCount) || 0, playlist.trackIds?.length || 0)
      const privileges = new Map((Array.isArray(result.privileges) ? result.privileges : []).map((p) => [String(p.id), p]))
      const add = (song, privilege) => { const item = neteaseTrack(song, privilege); if (item && found.size < LIMIT) found.set(item.id, item) }
      for (const song of (Array.isArray(playlist.tracks) ? playlist.tracks : []).slice(0, LIMIT)) add(song, privileges.get(String(song.id)))
      const ids = (Array.isArray(playlist.trackIds) ? playlist.trackIds : []).map((t) => String(t.id)).filter((id) => numericId(id) && !found.has(id)).slice(0, LIMIT - found.size)
      for (let begin = 0, calls = 1; begin < ids.length && calls < MAX_REQUESTS; begin += 100, calls++) {
        const batch = ids.slice(begin, begin + 100)
        const url = new URL('https://music.163.com/api/v3/song/detail')
        url.searchParams.set('c', JSON.stringify(batch.map((id) => ({ id: Number(id) }))))
        const page = await request(url, options)
        if (page.code !== 200 || !Array.isArray(page.songs)) { warnings.push('平台未返回部分歌曲资料'); break }
        const permissions = new Map((page.privileges || []).map((p) => [String(p.id), p]))
        for (const song of page.songs) if (batch.includes(String(song.id))) add(song, permissions.get(String(song.id)))
      }
      if (!total && found.size) total = found.size
      complete = found.size === total
    } else {
      let begin = 0
      for (let calls = 0; calls < MAX_REQUESTS && found.size < LIMIT; calls++) {
        const page = await musicu('music.srfDissInfo.aiDissInfo', 'uniform_get_Dissinfo', { disstid: Number(playlistId), song_begin: begin, song_num: Math.min(100, LIMIT - found.size) }, options)
        name = text(page.dirinfo?.title, 'QQ 音乐歌单')
        const songs = Array.isArray(page.songlist) ? page.songlist : []
        total = Math.max(total, Number(page.total_song_num) || Number(page.dirinfo?.songnum) || 0)
        const before = found.size
        for (const song of songs) { const item = qqTrack(song); if (item && found.size < LIMIT) found.set(item.id, item) }
        begin += songs.length
        if (!page.hasmore || !songs.length || found.size === before) { complete = total > 0 ? found.size === total : !page.hasmore; break }
      }
      if (!total && complete) total = found.size
      if (total && found.size === total) complete = true
    }
    if (!complete) warnings.push(`已读取 ${found.size} 首，平台报告共 ${total || '未知'} 首；单次最多读取 1000 首且最多请求 10 页，当前列表可能不完整`)
    if ([...found.values()].some((track) => track.restricted)) warnings.push(fallback
      ? '部分歌曲受会员、付费、版权或登录限制，下载时会自动改用备用音源解析重试，仍失败会写明原因'
      : '部分歌曲受会员、付费、版权或登录限制，下载时会保留限制并显示原因')
    return { source, playlistId, name, tracks: [...found.values()], total, complete, enhanced: !!fallback, warnings }
  }

  function mirrorTrack(input) {
    const track = {
      id: String(input.id),
      source: input.source,
      title: typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 200) : '歌曲',
      artist: typeof input.artist === 'string' && input.artist.trim() ? input.artist.trim().slice(0, 200) : '未知歌手',
      duration: Math.max(0, Number(input.duration) || 0),
    }
    return track
  }

  /** 官方匿名接口没有地址时，用备用音源解析再试一次；失败也保留官方给出的原因。 */
  async function resolveMirror(input, official, options) {
    const reason = (official && official.reason) || '平台未提供可用的公开音源'
    if (!fallback) return official
    const track = mirrorTrack(input)
    let result
    try {
      result = await fallback.resolve({ source: track.source, id: track.id, duration: track.duration, title: track.title, artist: track.artist }, options)
    } catch (error) {
      if (options?.signal?.aborted) throw error
      return { reason: `${reason}；备用音源解析失败（${String(error?.message || error).slice(0, 80)}）` }
    }
    if (!result || result.ok !== true || !result.url) return { reason: `${reason}；${(result && result.reason) || '备用音源未返回可用地址'}` }
    const safe = audioUrl(result.url, track.source) || (/^https:\/\//.test(result.url) ? result.url : undefined)
    if (!safe) return { reason: `${reason}；备用音源返回了不安全的音频地址` }
    const extension = (new URL(safe).pathname.match(/\.(mp3|m4a|flac|aac|ogg)$/i)?.[1] || 'mp3').toLowerCase()
    const duration = track.duration > 0 ? track.duration : Math.round(Number(result.estimatedDuration) || 0)
    return { url: safe, filename: filename(track, extension), duration, preview: false, mirrored: true, endpoint: result.endpoint }
  }

  async function resolve(input, options) {
    if (!input || !['netease', 'qq'].includes(input.source) || !(input.source === 'netease' ? numericId(input.id) : qqId(input.id))) throw new Error('无效的歌曲来源或编号')
    const official = await resolveOfficial(input, options)
    if (official.url || !fallback) return official
    return resolveMirror(input, official, options)
  }

  async function resolveOfficial(input, options) {
    if (input.source === 'netease') {
      const detailUrl = new URL('https://music.163.com/api/v3/song/detail')
      detailUrl.searchParams.set('c', JSON.stringify([{ id: Number(input.id) }]))
      const detail = await request(detailUrl, options)
      const song = detail.songs?.find((s) => String(s.id) === String(input.id))
      const privilege = detail.privileges?.find((p) => String(p.id) === String(input.id))
      const track = neteaseTrack(song, privilege)
      if (detail.code !== 200 || !track) return { reason: '网易云未提供此歌曲的公开资料，可能需要登录' }
      if (track.restricted) return { reason: '此曲受会员、付费、版权或平台下载权限限制，请在网易云官方客户端处理' }
      const url = new URL('https://music.163.com/api/song/enhance/player/url')
      url.searchParams.set('ids', JSON.stringify([Number(input.id)]))
      url.searchParams.set('br', '128000')
      const result = await request(url, options)
      const item = result.data?.find((s) => String(s.id) === String(input.id))
      if (result.code !== 200 || item?.code !== 200 || !item.url) return { reason: '网易云未提供可用的匿名公开地址，可能需要登录或版权授权' }
      if (item.freeTrialInfo || item.freeTrialPrivilege?.listenType || Number(item.fee) !== 0 || !item.time || !track.duration || Math.abs(item.time / 1000 - track.duration) > 3) return { preview: true, reason: '平台仅提供试听或无法确认完整时长，已跳过下载' }
      const safe = audioUrl(item.url, 'netease')
      if (!safe || !['mp3', 'm4a', 'flac'].includes(item.type)) return { reason: '平台返回了不受支持的音频地址或格式' }
      return { url: safe, filename: filename(track, item.type), duration: track.duration, preview: false }
    }
    const detail = await musicu('music.pf_song_detail_svr', 'get_song_detail_yqq', { song_mid: String(input.id) }, options)
    const song = detail.track_info
    const track = qqTrack(song)
    if (!track || track.id !== String(input.id)) return { reason: 'QQ 音乐未提供匹配的歌曲资料' }
    if (track.restricted) return { reason: '此曲受会员、付费或下载权限限制，请在 QQ 音乐官方客户端处理' }
    const result = await musicu('vkey.GetVkeyServer', 'CgiGetVkey', { guid: String(Date.now()).slice(-10), songmid: [track.id], songtype: [0], uin: '0', loginflag: 0, platform: '20' }, options)
    const item = result.midurlinfo?.find((s) => s.songmid === track.id)
    if (!item?.purl) return { reason: 'QQ 音乐未提供匿名公开地址，请在官方客户端登录后下载' }
    if (/RS02|try|preview/i.test(item.filename || item.purl) || !track.duration) return { preview: true, reason: 'QQ 音乐仅提供试听或无法确认完整曲目，已跳过下载' }
    const base = (Array.isArray(result.sip) ? result.sip : []).find((s) => audioUrl(s, 'qq'))
    const safe = base && audioUrl(new URL(item.purl, base).href, 'qq')
    if (!safe || !/\.(mp3|m4a)(?:\?|$)/i.test(safe)) return { reason: 'QQ 音乐返回了不受支持的音频地址' }
    const extension = new URL(safe).pathname.endsWith('.mp3') ? 'mp3' : 'm4a'
    return { url: safe, filename: filename(track, extension), duration: track.duration, preview: false }
  }

  return { list, resolve }
}

module.exports = { createPlaylistSources, parsePlaylistURL }
