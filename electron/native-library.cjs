const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const AUDIO = new Set(['.mp3', '.flac', '.m4a', '.mp4', '.aac', '.ogg', '.opus', '.wav', '.m4b', '.alac', '.wma', '.ape', '.aiff', '.aif'])
const MIME = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav' }

/** Only indexes explicitly selected download directories; never accepts a renderer file path. */
function createNativeLibrary({ directories }) {
  let entries = new Map()
  function list() {
    const next = new Map()
    for (const selected of directories()) {
      try {
        const root = fs.realpathSync(selected)
        for (const item of fs.readdirSync(root, { withFileTypes: true })) {
          if (next.size >= 20000) break
          if (!item.isFile() || !AUDIO.has(path.extname(item.name).toLowerCase())) continue
          const file = path.join(root, item.name)
          const stat = fs.lstatSync(file)
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 16 || stat.size > 200 * 1024 * 1024 || fs.realpathSync(file) !== file) continue
          const id = createHash('sha256').update(process.platform === 'win32' ? file.toLowerCase() : file).digest('hex')
          next.set(id, { id, filename: item.name, size: stat.size, lastModified: stat.mtimeMs, file })
        }
      } catch { /* Disconnected or unreadable directories do not break other music. */ }
    }
    entries = next
    return [...entries.values()].map(({ file, ...item }) => item)
  }
  function serve(req, res, id, headers = {}) {
    const item = entries.get(id)
    let handle
    try {
      if (!item) throw new Error('missing')
      handle = fs.openSync(item.file, 'r')
      const stat = fs.fstatSync(handle)
      if (!stat.isFile() || stat.size !== item.size || stat.mtimeMs !== item.lastModified || fs.realpathSync(item.file) !== item.file) throw new Error('changed')
      let start = 0, end = stat.size - 1
      const range = req.headers.range
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range)
        if (!match || (!match[1] && !match[2])) throw new Error('range')
        if (!match[1]) start = Math.max(0, stat.size - Number(match[2]))
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])) }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= stat.size) throw new Error('range')
      }
      res.writeHead(range ? 206 : 200, { ...headers, 'Content-Type': MIME[path.extname(item.file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
        'Cross-Origin-Resource-Policy': 'same-origin', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}) })
      if (req.method === 'HEAD') { fs.closeSync(handle); handle = undefined; res.end(); return }
      const stream = fs.createReadStream(item.file, { fd: handle, autoClose: true, start, end })
      handle = undefined
      stream.on('error', () => res.destroy())
      res.on('close', () => stream.destroy())
      stream.pipe(res)
    } catch (error) {
      if (handle !== undefined) fs.closeSync(handle)
      const invalidRange = error.message === 'range'
      res.writeHead(invalidRange ? 416 : 404, { ...headers, ...(invalidRange && item ? { 'Content-Range': `bytes */${item.size}` } : {}) })
      res.end()
    }
  }
  return { list, serve }
}
module.exports = { createNativeLibrary }
