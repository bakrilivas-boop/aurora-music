const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const MAX_BYTES = 200 * 1024 * 1024
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'skipped'])
const QQ_HOSTS = new Set(['stream.qqmusic.qq.com', 'dl.stream.qqmusic.qq.com', 'isure.stream.qqmusic.qq.com', 'ws.stream.qqmusic.qq.com'])
class QueueError extends Error {}
const fail = (message) => { throw new QueueError(message) }
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value)

function validTrack(item) {
  if (!plain(item) || !['netease', 'qq'].includes(item.source)) fail('仅支持网易云和 QQ 音乐的公开曲目。')
  if (['url', 'downloadUrl', 'mediaUrl', 'headers', 'cookie', 'cookies', 'authorization'].some((key) => key in item)) fail('下载只能使用音乐来源返回的公开音源，不能指定链接或登录凭证。')
  const trackId = item.trackId ?? item.id
  if (typeof trackId !== 'string' || (item.id != null && item.trackId != null && item.id !== item.trackId)) fail('曲目编号无效。')
  const pattern = item.source === 'netease' ? /^\d{1,20}$/ : /^[A-Za-z0-9]{1,64}$/
  if (!pattern.test(trackId)) fail('曲目编号格式无效。')
  if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 240 || /[\x00-\x1f]/.test(item.title)) fail('歌名格式无效或过长。')
  if (typeof item.artist !== 'string' || item.artist.length > 240 || /[\x00-\x1f]/.test(item.artist)) fail('歌手格式无效或过长。')
  if (typeof item.duration !== 'number' || !Number.isFinite(item.duration) || item.duration < 0 || item.duration > 86400) fail('歌曲时长无效。')
  return { source: item.source, id: trackId, trackId, title: item.title.trim(), artist: item.artist.trim(), duration: item.duration, restricted: item.restricted === true }
}

function mediaUrl(value, previous) {
  if (typeof value !== 'string' || value.length > 4096) fail('公开音源链接无效。')
  let url
  try { url = new URL(value, previous) } catch { fail('公开音源链接无效。') }
  const host = url.hostname.toLowerCase()
  const netease = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*music\.126\.net$/.test(host)
  const qq = QQ_HOSTS.has(host) || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*qqmusic\.qq\.com$/.test(host)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || (!netease && !qq)) {
    fail('音源或跳转链接不属于允许的官方 HTTPS 音频 CDN，已阻止下载。')
  }
  url.hash = ''
  return url.href
}

function audioExtension(bytes) {
  if (bytes.length < 12) return null
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3' && bytes[3] >= 2 && bytes[3] <= 4) return 'mp3'
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return (bytes[1] & 6) === 0 ? 'aac' : 'mp3'
  if (bytes.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac'
  if (bytes.subarray(0, 4).toString('ascii') === 'OggS' && bytes[4] === 0) return 'ogg'
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp' && bytes.readUInt32BE(0) >= 8 && bytes.readUInt32BE(0) <= 4096) return 'm4a'
  return null
}

function filenameFor(track, suggested, extension, directory) {
  const fallback = `${track.artist ? track.artist + ' - ' : ''}${track.title}`
  const proposed = typeof suggested === 'string' && suggested.length <= 500 ? suggested : fallback
  let stem = proposed.replace(/\.[a-z0-9]{1,8}$/i, '').normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '')
  if (!stem) stem = `${track.source}-${track.trackId}`
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `_${stem}`
  const max = Math.min(160, 235 - directory.length - extension.length)
  if (max < 16) fail('保存文件夹路径过长，请选择更短的路径。')
  stem = stem.slice(0, max).replace(/[.\s]+$/g, '')
  return `${stem}.${extension}`
}

function inside(directory, file) {
  const relative = path.relative(directory, path.resolve(file))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) && path.dirname(relative) === '.'
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(new QueueError('任务已中止。'))
  return new Promise((resolve, reject) => {
    const abort = () => reject(new QueueError('任务已中止。'))
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function createDownloadQueue({ sources, fetchImpl = globalThis.fetch, onUpdate = () => {}, attemptRestricted = false }) {
  if (typeof sources?.resolve !== 'function') throw new Error('下载队列需要可用的公开音源解析器。')
  let directory = ''
  const tasks = []
  const running = new Map()
  const runningPromises = new Set()
  let closing = false
  let pendingPump = false
  let progressTimer
  let lastUpdate = 0

  function snapshot() {
    return { directory, tasks: tasks.map(({ id, track, status, receivedBytes, totalBytes, filename, message }) => ({
      id, source: track.source, trackId: track.trackId, title: track.title, artist: track.artist, status, receivedBytes, totalBytes,
      ...(filename ? { filename } : {}), ...(message ? { message } : {}),
    })), active: running.size, completed: tasks.filter((task) => task.status === 'completed').length }
  }
  function emit(force = false) {
    const remaining = 100 - (Date.now() - lastUpdate)
    if (!force && remaining > 0) {
      if (!progressTimer) progressTimer = setTimeout(() => { progressTimer = undefined; emit(true) }, remaining)
      return
    }
    clearTimeout(progressTimer)
    progressTimer = undefined
    lastUpdate = Date.now()
    try { onUpdate(snapshot()) } catch { /* UI subscribers cannot break a download. */ }
  }
  function schedule() {
    if (pendingPump) return
    pendingPump = true
    queueMicrotask(() => {
      pendingPump = false
      if (closing) return
      while (running.size < 2) {
        const task = tasks.find((item) => item.status === 'queued')
        if (!task) break
        const controller = new AbortController()
        running.set(task.id, controller)
        task.status = 'resolving'
        emit(true)
        const promise = run(task, controller).finally(() => { running.delete(task.id); runningPromises.delete(promise); emit(true); schedule() })
        runningPromises.add(promise)
      }
    })
  }
  async function downloadResponse(url, controller, touch) {
    let next = mediaUrl(url)
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await abortable(fetchImpl(next, { method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { Accept: 'audio/*,application/octet-stream;q=0.8', 'Accept-Encoding': 'identity' }, signal: controller.signal }), controller.signal)
      touch()
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers?.get('location')
        if (response.body?.cancel) await abortable(response.body.cancel(), controller.signal)
        if (redirects === 3) fail('音源跳转超过 3 次，已停止下载。')
        next = mediaUrl(location, next)
        continue
      }
      if (response.status !== 200 || !response.ok) fail(response.status === 206 ? '音源只返回了部分内容，已阻止保存不完整音频。' : `公开音源下载失败（HTTP ${Number(response.status) || 0}）。`)
      return response
    }
    fail('公开音源跳转失败。')
  }
  async function run(task, controller) {
    let activityTimer
    let timedOut = false
    let handle
    let part
    let owned
    let reader
    const touch = () => {
      clearTimeout(activityTimer)
      activityTimer = setTimeout(() => { timedOut = true; controller.abort() }, 60000)
    }
    function cleanupPart() {
      if (!part || !owned || !inside(task.directory, part)) return
      try {
        const current = fs.lstatSync(part)
        if (current.isFile() && !current.isSymbolicLink() && current.ino === owned.ino && current.dev === owned.dev) fs.unlinkSync(part)
      } catch { /* Only this attempt's private .part can be removed; a leftover can be removed manually. */ }
      owned = undefined
    }
    try {
      touch()
      const resolved = await abortable(sources.resolve({ ...task.track }, { signal: controller.signal }), controller.signal)
      touch()
      if (!plain(resolved)) fail('公开音源解析返回无效数据，请重试。')
      if (resolved.preview || resolved.reason) {
        task.status = 'skipped'
        task.message = typeof resolved.reason === 'string' && resolved.reason.trim()
          ? resolved.reason.trim().replace(/https?:\/\/\S+/g, '[链接已省略]').slice(0, 240)
          : '音源仅提供试听，已跳过。'
        return
      }
      if (!resolved.url) { task.status = 'skipped'; task.message = '暂无可公开下载的完整音源，已跳过。'; return }
      if (!(task.track.duration > 0) || typeof resolved.duration !== 'number' || !Number.isFinite(resolved.duration) || resolved.duration <= 0) {
        task.status = 'skipped'; task.message = '缺少可核对的完整时长，已跳过该音源。'; return
      }
      if (Math.abs(resolved.duration - task.track.duration) > 3) {
        task.status = 'skipped'; task.message = '公开音源时长与曲目不符（相差超过 3 秒），已跳过试听或不同版本。'; return
      }
      const response = await downloadResponse(resolved.url, controller, touch)
      const mime = (response.headers?.get('content-type') || '').split(';')[0].trim().toLowerCase()
      if (mime && !mime.startsWith('audio/') && !['application/octet-stream', 'binary/octet-stream', 'application/ogg', 'video/mp4'].includes(mime)) fail('音源返回的内容类型不是音频，已阻止保存。')
      const length = response.headers?.get('content-length')
      if (length != null && !/^\d{1,12}$/.test(length)) fail('音源返回了无效文件大小。')
      const expected = length == null ? 0 : Number(length)
      if (expected > MAX_BYTES) fail('单首音频超过 200 MiB，已停止下载。')
      task.totalBytes = expected
      reader = response.body?.getReader()
      if (!reader) fail('公开音源没有可读取的音频内容。')
      task.status = 'downloading'
      emit(true)
      const header = []
      let headerSize = 0
      let destination
      while (true) {
        const chunk = await abortable(reader.read(), controller.signal)
        if (chunk.done) break
        touch()
        if (!(chunk.value instanceof Uint8Array)) fail('音源返回了无效二进制数据。')
        task.receivedBytes += chunk.value.byteLength
        if (task.receivedBytes > MAX_BYTES) fail('单首音频超过 200 MiB，已停止下载。')
        if (!destination) {
          header.push(chunk.value)
          headerSize += chunk.value.byteLength
          if (headerSize < 12) { emit(); continue }
          const bytes = Buffer.concat(header.map((bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 12))), 12)
          const extension = audioExtension(bytes)
          if (!extension) fail('文件头不是有效的 MP3、FLAC、M4A、AAC 或 Ogg 音频，已阻止保存。')
          task.filename = filenameFor(task.track, resolved.filename, extension, task.directory)
          destination = path.resolve(task.directory, task.filename)
          if (!inside(task.directory, destination)) fail('保存路径超出所选文件夹，已阻止写入。')
          if (fs.existsSync(destination)) { task.status = 'skipped'; task.message = '文件夹中已存在同名文件，已保留原文件并跳过。'; return }
          part = path.join(task.directory, `.aurora-${randomUUID()}.part`)
          if (!inside(task.directory, part)) fail('临时文件路径无效。')
          handle = await fs.promises.open(part, 'wx', 0o600)
          owned = await handle.stat()
          for (const buffered of header) await writeAll(handle, buffered)
          header.length = 0
        } else await writeAll(handle, chunk.value)
        emit()
      }
      if (!destination || task.receivedBytes < 16) fail('音源内容为空或过短，未保存音频。')
      if (expected && expected !== task.receivedBytes) fail('音频传输不完整，未保存文件，请重试。')
      await handle.sync()
      await handle.close()
      handle = undefined
      if (controller.signal.aborted) throw new QueueError('任务已中止。')
      const current = fs.lstatSync(part)
      if (!current.isFile() || current.isSymbolicLink() || current.ino !== owned.ino || current.dev !== owned.dev) fail('临时音频文件发生变化，已阻止保存。')
      try {
        // Same-directory hard link publishes atomically and fails if a destination already exists.
        fs.linkSync(part, destination)
      } catch (error) {
        if (error.code === 'EEXIST') { task.status = 'skipped'; task.message = '同名文件已由另一任务保存，已保留原文件。'; return }
        fail('无法安全保存音频文件，请检查文件夹权限和文件系统是否支持硬链接。')
      }
      cleanupPart()
      task.status = 'completed'
      task.message = resolved.mirrored ? '已通过备用音源解析保存完整音频。' : '已保存完整音频。'
    } catch (error) {
      task.status = controller.signal.aborted && !timedOut ? 'cancelled' : 'failed'
      task.message = timedOut ? '音源连续 60 秒没有响应，已停止下载，可稍后重试。'
        : task.status === 'cancelled' ? '已取消下载。'
          : error instanceof QueueError ? error.message : '公开音源解析或下载失败，请检查网络后重试。'
    } finally {
      clearTimeout(activityTimer)
      controller.abort()
      if (reader) { try { void reader.cancel().catch(() => {}) } catch { /* Already closed or aborted. */ } }
      if (handle) { try { await handle.close() } catch { /* Preserve owned path guard below. */ } }
      cleanupPart()
      emit(true)
    }
  }
  async function writeAll(handle, bytes) {
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset)
      if (!bytesWritten) fail('音频文件写入失败，请检查磁盘空间。')
      offset += bytesWritten
    }
  }
  function requireDirectory() { if (closing) fail('下载队列正在关闭。'); if (!directory) fail('请先选择下载保存文件夹。') }
  return {
    snapshot,
    setDirectory(selected) {
      if (closing) fail('下载队列正在关闭。')
      if (tasks.some((task) => !TERMINAL.has(task.status)) || running.size) fail('请等待下载完成或取消所有任务后再更改保存文件夹。')
      if (typeof selected !== 'string' || !path.isAbsolute(selected) || selected.includes('\0') || selected.length > 210) fail('请选择有效且路径较短的保存文件夹。')
      try {
        const canonical = fs.realpathSync(selected)
        if (!fs.statSync(canonical).isDirectory()) fail('所选路径不是文件夹。')
        fs.accessSync(canonical, fs.constants.W_OK)
        directory = canonical
      } catch (error) { if (error instanceof QueueError) throw error; fail('无法写入所选文件夹，请重新选择。') }
      emit(true)
      return snapshot()
    },
    enqueue(items) {
      requireDirectory()
      if (!Array.isArray(items) || !items.length || items.length > 1000) fail('每次请选择 1 至 1,000 首歌曲。')
      const validated = items.map(validTrack)
      const known = new Set(tasks.filter((task) => task.directory === directory).map((task) => `${task.track.source}:${task.track.trackId}`))
      const additions = []
      for (const track of validated) {
        const key = `${track.source}:${track.trackId}`
        if (known.has(key)) continue
        known.add(key)
        additions.push(track)
      }
      if (tasks.length + additions.length > 1000) fail('下载队列累计最多保留 1,000 个任务，请重新打开软件后再添加。')
      const retryRestricted = typeof attemptRestricted === 'function' ? attemptRestricted() === true : attemptRestricted === true
      for (const track of additions) {
        // 开了备用音源解析时，受限歌曲照常入队，交给解析器兜底；只有解析也失败才跳过。
        const skip = track.restricted && !retryRestricted
        tasks.push({ id: randomUUID(), track, directory, status: skip ? 'skipped' : 'queued', receivedBytes: 0, totalBytes: 0,
          ...(skip ? { message: '来源未提供完整公开下载权限，已跳过。' } : {}) })
      }
      emit(true)
      schedule()
      return snapshot()
    },
    cancel(taskId) {
      const task = tasks.find((item) => item.id === taskId)
      if (!task) fail('没有找到这个下载任务。')
      if (TERMINAL.has(task.status)) return snapshot()
      task.status = 'cancelled'
      task.message = '已取消下载。'
      running.get(taskId)?.abort()
      emit(true)
      schedule()
      return snapshot()
    },
    retry(taskId) {
      requireDirectory()
      const task = tasks.find((item) => item.id === taskId)
      if (!task || !['failed', 'cancelled'].includes(task.status)) fail('只能重试失败或取消的下载任务。')
      if (running.has(taskId)) fail('任务正在取消，请稍后再重试。')
      task.directory = directory
      task.status = 'queued'
      task.receivedBytes = task.totalBytes = 0
      delete task.message
      delete task.filename
      emit(true)
      schedule()
      return snapshot()
    },
    async close() {
      closing = true
      for (const task of tasks) {
        if (TERMINAL.has(task.status)) continue
        task.status = 'cancelled'
        task.message = '软件退出，已取消下载。'
      }
      for (const controller of running.values()) controller.abort()
      emit(true)
      await Promise.allSettled([...runningPromises])
      clearTimeout(progressTimer)
      progressTimer = undefined
      return snapshot()
    },
  }
}

module.exports = { createDownloadQueue }
