// 备用音源解析：只按「平台歌曲编号」换回一条可下载的直链，不携带任何账号凭证。
// 官方匿名接口（playlist-sources.cjs）拿不到地址时才会走到这里。
// 默认接口与 GD 音乐台（https://music.gdstudio.xyz）兼容：
//   GET <endpoint>?types=url&source=netease|tencent&id=<trackId>&br=320 -> { url, br, size }
const DEFAULT_ENDPOINT = 'https://music-api.gdstudio.xyz/api.php'
const MAX_BODY = 128 * 1024
const TIMEOUT_MS = 12000
const MIN_INTERVAL = 700
const MAX_INTERVAL = 6000
const MAX_ATTEMPTS = 3
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const BR = 320
const SOURCE_MAP = { netease: 'netease', qq: 'tencent' }

const numericId = (value) => /^\d{1,20}$/.test(String(value))
const alnumId = (value) => /^[A-Za-z0-9]{1,64}$/.test(String(value))

function privateHost(host) {
  const name = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!name) return true
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name.endsWith('.internal')) return true
  if (name.includes(':')) return true // IPv6 字面量一律拒绝
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(name)) {
    const [a, b] = name.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  return false
}

/** 只接受公网 HTTPS 直链，避免配置被改写后让下载器去打内网。 */
function safeAudioUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) return undefined
  let url
  try { url = new URL(value.trim()) } catch { return undefined }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined
  if (privateHost(url.hostname)) return undefined
  url.hash = ''
  return url.href
}

function safeEndpoint(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 400) return undefined
  let url
  try { url = new URL(value.trim()) } catch { return undefined }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined
  if (privateHost(url.hostname)) return undefined
  url.hash = ''
  return url.href
}

function createMusicMirror({ fetchImpl = globalThis.fetch, endpoint = DEFAULT_ENDPOINT, enabled = true } = {}) {
  let current = safeEndpoint(endpoint) || DEFAULT_ENDPOINT
  let active = enabled !== false
  // 接口自身有频率限制（约 5 分钟 50 次），这里做自适应节流 + 限流重试：
  // 命中 429/5xx 就放缓间隔，成功后再逐步提速，避免整单歌曲被批量 503。
  let intervalMs = MIN_INTERVAL
  let lastStart = 0
  let gate = Promise.resolve()

  function pause(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason || new Error('已取消'))
      const onAbort = () => { clearTimeout(timer); reject(signal.reason || new Error('已取消')) }
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  function waitTurn(signal) {
    const turn = gate.then(async () => {
      const wait = lastStart + intervalMs - Date.now()
      if (wait > 0) await pause(wait, signal)
      lastStart = Date.now()
    })
    gate = turn.catch(() => {})
    return turn
  }

  function requestUrl(source, id) {
    const url = new URL(current)
    url.searchParams.set('types', 'url')
    url.searchParams.set('source', SOURCE_MAP[source])
    url.searchParams.set('id', String(id))
    url.searchParams.set('br', String(BR))
    return url
  }

  async function fetchText(url, options) {
    const controller = new AbortController()
    const outer = options?.signal
    const abort = () => controller.abort(outer?.reason)
    if (outer?.aborted) throw outer.reason || new Error('已取消')
    outer?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('备用音源解析超时，请稍后重试')), TIMEOUT_MS)
    try {
      const response = await fetchImpl(url.href, {
        signal: controller.signal, redirect: 'follow', credentials: 'omit',
        headers: { 'User-Agent': 'AuroraMusic/1.4', Accept: 'application/json,text/plain' },
      })
      if (!response.ok) {
        const error = new Error(`备用音源接口返回 HTTP ${Number(response.status) || 0}`)
        error.status = Number(response.status) || 0
        error.retryAfter = Number(response.headers?.get('retry-after')) || 0
        throw error
      }
      const declared = Number(response.headers?.get('content-length'))
      if (Number.isFinite(declared) && declared > MAX_BODY) throw new Error('备用音源接口返回内容过大')
      const raw = typeof response.text === 'function' ? await response.text() : ''
      if (raw.length > MAX_BODY) throw new Error('备用音源接口返回内容过大')
      return raw
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', abort)
      controller.abort()
    }
  }

  function parseBody(raw) {
    const body = String(raw || '').trim()
    if (!body) return { reason: '备用音源接口没有返回内容' }
    if (body.startsWith('{') || body.startsWith('[')) {
      let value
      try { value = JSON.parse(body) } catch { return { reason: '备用音源接口返回了无法解析的数据' } }
      const item = Array.isArray(value) ? value[0] : value
      if (!item || typeof item !== 'object') return { reason: '备用音源接口返回了无法识别的数据' }
      if (typeof item.detail === 'string' && item.detail && !item.url) return { reason: `备用音源接口提示：${item.detail.slice(0, 120)}` }
      const url = safeAudioUrl(item.url)
      if (!url) return { reason: typeof item.url === 'string' && item.url ? '备用音源返回了不安全的音频地址' : '备用音源未提供此歌曲的可用地址' }
      const br = Number(item.br) > 0 ? Number(item.br) : BR
      const size = Number(item.size) > 0 ? Number(item.size) : 0
      return { url, br, size }
    }
    if (/^https?:\/\//i.test(body)) {
      const url = safeAudioUrl(body)
      return url ? { url, br: BR, size: 0 } : { reason: '备用音源返回了不安全的音频地址' }
    }
    return { reason: '备用音源接口返回了无法识别的数据' }
  }

  return {
    get enabled() { return active },
    get endpoint() { return current },
    info() { return { enabled: active, endpoint: current } },
    configure({ enabled: nextEnabled, endpoint: nextEndpoint } = {}) {
      if (nextEndpoint !== undefined) {
        const parsed = safeEndpoint(nextEndpoint)
        if (!parsed) throw new Error('备用音源接口地址必须是公网 HTTPS 地址')
        current = parsed
      }
      if (nextEnabled !== undefined) active = nextEnabled !== false
      return this.info()
    },
    /** 返回 { ok:true, url, br, size, estimatedDuration } 或 { ok:false, reason }。 */
    async resolve(input = {}, options = {}) {
      const source = input.source
      const id = String(input.id ?? '')
      if (!active) return { ok: false, reason: '未启用备用音源解析' }
      if (!SOURCE_MAP[source]) return { ok: false, reason: '备用音源不支持此音乐平台' }
      if (source === 'netease' ? !numericId(id) : !alnumId(id)) return { ok: false, reason: '歌曲编号无效，未调用备用音源' }
      let raw
      for (let attempt = 0; ; attempt++) {
        try {
          await waitTurn(options?.signal)
          raw = await fetchText(requestUrl(source, id), options)
          intervalMs = Math.max(MIN_INTERVAL, Math.round(intervalMs * 0.9))
          break
        } catch (error) {
          if (options?.signal?.aborted) return { ok: false, reason: String(options.signal.reason?.message || '已取消') }
          const status = Number(error?.status) || 0
          intervalMs = Math.min(MAX_INTERVAL, Math.round(intervalMs * 2 + 200))
          if (RETRY_STATUS.has(status) && attempt + 1 < MAX_ATTEMPTS) {
            const backoff = Math.min(5000, error.retryAfter > 0 ? error.retryAfter * 1000 : 700 * (attempt + 1))
            try { await pause(backoff, options?.signal) } catch { return { ok: false, reason: '已取消' } }
            continue
          }
          return { ok: false, reason: RETRY_STATUS.has(status) ? `备用音源接口繁忙（HTTP ${status}），已重试 ${attempt + 1} 次` : error?.message || '备用音源解析失败' }
        }
      }
      const parsed = parseBody(raw)
      if (!parsed.url) return { ok: false, reason: parsed.reason }
      const estimatedDuration = parsed.size > 0 ? (parsed.size * 8) / (parsed.br * 1000) : 0
      const expected = Number(input.duration) > 0 ? Number(input.duration) : 0
      if (expected > 0 && estimatedDuration > 0 && Math.abs(estimatedDuration - expected) > Math.max(10, expected * 0.08)) {
        return { ok: false, reason: `备用音源时长 ${Math.round(estimatedDuration)} 秒与曲目 ${Math.round(expected)} 秒不符，可能是不同版本` }
      }
      return { ok: true, url: parsed.url, br: parsed.br, size: parsed.size, estimatedDuration }
    },
  }
}

module.exports = { createMusicMirror, safeAudioUrl, safeEndpoint, DEFAULT_ENDPOINT }