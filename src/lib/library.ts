import { extOf, isAudioFile, isLyricFile, parseAudioTags, guessFromName } from './tags'
import type { NativeTrackFile, Track } from './types'

export interface ScanProgress {
  done: number
  total: number
  phase: 'walk' | 'parse'
}

interface FoundFile {
  file: File
  relPath: string
  dir: string
}

const MAX_DEPTH = 12
const PARSE_CONCURRENCY = 4
const COVER_EXT = ['jpg', 'jpeg', 'png', 'webp']

function collectLocalAsset(file: File, relPath: string, lrcMap: Map<string, File>, coverMap: Map<string, File>): void {
  const key = relPath.toLowerCase()
  if (isLyricFile(file.name)) lrcMap.set(key.replace(/\.[^.]+$/, ''), file)
  else if (COVER_EXT.includes(extOf(file.name))) coverMap.set(key, file)
}

export function collectLocalAssets(files: Iterable<File>): { lrcMap: Map<string, File>; coverMap: Map<string, File> } {
  const lrcMap = new Map<string, File>()
  const coverMap = new Map<string, File>()
  for (const file of files) {
    const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    collectLocalAsset(file, relPath, lrcMap, coverMap)
  }
  return { lrcMap, coverMap }
}

export async function readLyrics(file: Pick<File, 'arrayBuffer'>): Promise<string | undefined> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let text: string
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le').decode(bytes)
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be').decode(bytes)
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      try {
        text = new TextDecoder('gb18030').decode(bytes)
      } catch {
        text = new TextDecoder('utf-8').decode(bytes)
      }
    }
  }
  return text.trim() || undefined
}

/** Chrome/Edge：使用 File System Access API 选目录并持久化句柄 */
export function supportsFileSystemAccess(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as unknown as { showDirectoryPicker?: (o?: unknown) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker
  if (!picker) return null
  try {
    const handle = await picker({ mode: 'read', id: 'aurora-music-library' })
    return handle
  } catch {
    return null
  }
}

export async function queryHandlePermission(
  handle: FileSystemDirectoryHandle,
  request = false,
): Promise<boolean> {
  const h = handle as unknown as {
    queryPermission?: (d: { mode: 'read' }) => Promise<PermissionState>
    requestPermission?: (d: { mode: 'read' }) => Promise<PermissionState>
  }
  try {
    if (request) {
      if (h.requestPermission) return (await h.requestPermission({ mode: 'read' })) === 'granted'
      return false
    }
    if (h.queryPermission) return (await h.queryPermission({ mode: 'read' })) === 'granted'
    return true
  } catch {
    return false
  }
}

type DirHandle = FileSystemDirectoryHandle & {
  values: () => AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>
}

async function walk(
  dir: FileSystemDirectoryHandle,
  relPath: string,
  depth: number,
  out: FoundFile[],
  lrcMap: Map<string, File>,
  coverMap: Map<string, File>,
): Promise<void> {
  if (depth > MAX_DEPTH) return
  const d = dir as DirHandle
  if (typeof d.values !== 'function') return
  for await (const entry of d.values()) {
    if (entry.kind === 'directory') {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      await walk(entry as FileSystemDirectoryHandle, `${relPath}${entry.name}/`, depth + 1, out, lrcMap, coverMap)
    } else {
      const fh = entry as FileSystemFileHandle
      if (isAudioFile(fh.name)) {
        try {
          const file = await fh.getFile()
          out.push({ file, relPath: `${relPath}${file.name}`, dir: relPath })
        } catch {
          /* 单个文件读失败不影响整体 */
        }
      } else if (isLyricFile(fh.name) || COVER_EXT.includes(extOf(fh.name))) {
        try {
          const file = await fh.getFile()
          collectLocalAsset(file, `${relPath}${fh.name}`, lrcMap, coverMap)
        } catch {
          /* noop */
        }
      }
    }
  }
}

/** 兼容不支持 File System Access 的浏览器：<input webkitdirectory> 拿到的文件列表 */
export function filesFromInput(input: HTMLInputElement): { file: File; relPath: string; dir: string }[] {
  const list = Array.from(input.files || [])
  return list
    .filter((f) => isAudioFile(f.name))
    .map((f) => {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
      const idx = rel.lastIndexOf('/')
      return { file: f, relPath: rel, dir: idx >= 0 ? rel.slice(0, idx + 1) : '' }
    })
}

function makeId(relPath: string, size: number): string {
  // 简单稳定散列，避免长路径作为 key
  let h = 5381
  for (let i = 0; i < relPath.length; i++) h = ((h << 5) + h + relPath.charCodeAt(i)) | 0
  return `${(h >>> 0).toString(36)}-${size.toString(36)}`
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>, onTick?: (i: number) => void): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  let done = 0
  const workers = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      try {
        results[i] = await fn(items[i], i)
      } catch (e) {
        results[i] = undefined as unknown as R
        void e
      }
      done++
      onTick?.(done)
    }
  })
  await Promise.all(workers)
  return results
}

export async function buildTracks(
  found: FoundFile[],
  lrcMap: Map<string, File>,
  onProgress?: (p: ScanProgress) => void,
  coverMap: Map<string, File> = new Map(),
): Promise<Track[]> {
  onProgress?.({ done: 0, total: found.length, phase: 'parse' })
  const now = Date.now()
  const tracks = await mapLimit(
    found,
    PARSE_CONCURRENCY,
    async (item): Promise<Track> => {
      const meta = await parseAudioTags(item.file)
      const guessed = guessFromName(item.file.name)
      const baseName = item.file.name.replace(/\.[^.]+$/, '').toLowerCase()
      const dirKey = item.dir.toLowerCase()
      const baseKey = `${dirKey}${baseName}`
      const lrcFile = lrcMap.get(baseKey)
      let externalLyrics: string | undefined
      if (lrcFile) {
        try {
          externalLyrics = await readLyrics(lrcFile)
        } catch {
          /* noop */
        }
      }
      let cover: string | undefined
      if (meta.picture) {
        try {
          const blob = new Blob([meta.picture.bytes as unknown as BlobPart], { type: meta.picture.mime })
          cover = URL.createObjectURL(blob)
        } catch {
          cover = undefined
        }
      }
      if (!cover) {
        const names = [baseName, 'cover', 'folder', 'front']
        const coverFile = names.flatMap((name) => COVER_EXT.map((ext) => coverMap.get(`${dirKey}${name}.${ext}`))).find(Boolean)
        if (coverFile) {
          const mime = coverFile.type || `image/${extOf(coverFile.name) === 'jpg' ? 'jpeg' : extOf(coverFile.name)}`
          cover = URL.createObjectURL(new Blob([coverFile], { type: mime }))
        }
      }
      return {
        id: makeId(item.relPath, item.file.size),
        relPath: item.relPath,
        filename: item.file.name,
        title: meta.title || guessed.title,
        artist: meta.artist || guessed.artist || '未知艺术家',
        album: meta.album || '未知专辑',
        year: meta.year,
        genre: meta.genre,
        trackNo: meta.trackNo,
        duration: meta.duration && isFinite(meta.duration) ? meta.duration : 0,
        format: (meta.format || extOf(item.file.name) || 'audio').toUpperCase(),
        size: item.file.size,
        addedAt: now,
        cover,
        embeddedLyrics: externalLyrics ?? meta.lyrics,
        hasLrc: !!lrcFile,
        file: item.file,
        analyzed: !!(meta.duration && isFinite(meta.duration)),
      }
    },
    (done) => onProgress?.({ done, total: found.length, phase: 'parse' }),
  )
  return tracks.filter(Boolean)
}

export async function scanHandle(
  handle: FileSystemDirectoryHandle,
  onProgress?: (p: ScanProgress) => void,
): Promise<Track[]> {
  const found: FoundFile[] = []
  const lrcMap = new Map<string, File>()
  const coverMap = new Map<string, File>()
  onProgress?.({ done: 0, total: 0, phase: 'walk' })
  await walk(handle, '', 0, found, lrcMap, coverMap)
  return buildTracks(found, lrcMap, onProgress, coverMap)
}

/** 用 <audio> 读取真实时长（标签里没有时长时兜底） */
export function readDuration(file: File | string): Promise<number> {
  return new Promise((resolve) => {
    const url = typeof file === 'string' ? file : URL.createObjectURL(file)
    const audio = document.createElement('audio')
    let settled = false
    const finish = (d: number) => {
      if (settled) return
      settled = true
      audio.removeAttribute('src')
      audio.load()
      if (typeof file !== 'string') URL.revokeObjectURL(url)
      resolve(isFinite(d) && d > 0 ? d : 0)
    }
    const timer = setTimeout(() => finish(0), 12000)
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => {
      clearTimeout(timer)
      finish(audio.duration)
    }
    audio.onerror = () => {
      clearTimeout(timer)
      finish(0)
    }
    audio.src = url
  })
}

export function formatBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

export async function buildNativeTrack(item: NativeTrackFile, old?: Track): Promise<Track> {
  if (!/^[a-f\d]{64}$/.test(item.id) || !Number.isFinite(item.size) || item.size < 16 || !Number.isFinite(item.lastModified)) throw new Error('本地歌曲资料无效')
  const url = `/native-audio/${item.id}?v=${item.size}-${item.lastModified}`
  const meta = await parseAudioTags({ name: item.filename, size: item.size, slice: (start, end) => ({ arrayBuffer: async () => {
    if (end <= start) return new ArrayBuffer(0)
    if (end - start > 32 * 1024 * 1024) throw new Error('歌曲标签超过解析大小限制')
    const response = await fetch(url, { headers: { Range: `bytes=${start}-${Math.min(end, item.size) - 1}` } })
    if (response.status !== 206) throw new Error('本地音乐文件暂时不可读')
    return response.arrayBuffer()
  } }) })
  const guessed = guessFromName(item.filename)
  const unchanged = old?.nativeModified === item.lastModified && old.size === item.size
  const duration = meta.duration || (unchanged ? old?.duration : 0) || 0
  const cover = meta.picture ? URL.createObjectURL(new Blob([meta.picture.bytes as unknown as BlobPart], { type: meta.picture.mime })) : unchanged ? old?.cover : undefined
  return { id: `native_${item.id}`, nativeId: item.id, nativeModified: item.lastModified, nativeUrl: url,
    filename: item.filename, relPath: item.filename, size: item.size, title: meta.title || guessed.title,
    artist: meta.artist || guessed.artist || '未知艺术家', album: meta.album || '下载的音乐', genre: meta.genre, year: meta.year, trackNo: meta.trackNo,
    addedAt: old?.addedAt || Date.now(), duration, analyzed: duration > 0, format: (meta.format || extOf(item.filename)).toUpperCase(),
    cover, embeddedLyrics: meta.lyrics || (unchanged ? old?.embeddedLyrics : undefined) }
}
