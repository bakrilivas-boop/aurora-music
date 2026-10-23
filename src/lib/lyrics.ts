export interface LyricLine {
  time: number // 秒
  text: string
}

export interface ParsedLyrics {
  lines: LyricLine[]
  offset: number
}

const TIME_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

/**
 * 解析 LRC / 内嵌同步歌词。
 * 支持 [mm:ss.xx] 与 [mm:ss:xx]、一行多时间标签、[offset:xxx]、增强格式 <mm:ss.xx>。
 */
export function parseLrc(raw: string): ParsedLyrics {
  const result: ParsedLyrics = { lines: [], offset: 0 }
  if (!raw) return result

  const text = raw.replace(/\r\n?/g, '\n')
  const meta: Record<string, string> = {}
  const buckets: LyricLine[] = []

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    // 元信息行：[ti:...] [ar:...] [offset:...]
    const metaMatch = line.match(/^\[(ti|ar|al|by|offset|re|ve|kana):(.*)\]$/i)
    if (metaMatch) {
      meta[metaMatch[1].toLowerCase()] = metaMatch[2].trim()
      continue
    }

    TIME_RE.lastIndex = 0
    const stamps: number[] = []
    let m: RegExpExecArray | null
    let lastEnd = 0
    while ((m = TIME_RE.exec(line))) {
      if (m.index > lastEnd && line.slice(lastEnd, m.index).trim()) break
      const min = parseInt(m[1], 10)
      const sec = parseInt(m[2], 10)
      const fracRaw = m[3] ?? '0'
      const frac = parseInt(fracRaw.padEnd(3, '0').slice(0, 3), 10) / 1000
      stamps.push(min * 60 + sec + frac)
      lastEnd = TIME_RE.lastIndex
    }
    if (!stamps.length) continue

    let content = line.slice(lastEnd).trim()
    // 增强歌词 {mm:ss.xx} 与 <mm:ss.xx> 清掉，保留文字
    content = content.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '')
    content = content.replace(/\{\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\}/g, '').trim()
    for (const t of stamps) buckets.push({ time: t, text: content })
  }

  const offsetSec = meta.offset ? Number(meta.offset) / 1000 : 0
  result.offset = offsetSec

  const seen = new Set<string>()
  const dedup: LyricLine[] = []
  for (const l of buckets) {
    const key = `${l.time.toFixed(2)}|${l.text}`
    if (seen.has(key)) continue
    seen.add(key)
    dedup.push(l)
  }
  dedup.sort((a, b) => a.time - b.time)
  result.lines = dedup
  return result
}

export function isSyncedLyrics(raw: string): boolean {
  return raw ? /\d{1,3}:\d{1,2}/.test(raw) && /\[|\{/.test(raw) : false
}

/** 二分查找当前行索引 */
export function activeLineIndex(lines: LyricLine[], time: number): number {
  if (!lines.length) return -1
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].time <= time + 0.05) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/** 当前行内的播放进度 0~1，用于逐字/填充效果 */
export function lineProgress(lines: LyricLine[], index: number, time: number): number {
  if (index < 0 || index >= lines.length) return 0
  const start = lines[index].time
  const end = index + 1 < lines.length ? lines[index + 1].time : start + 4
  if (end <= start) return 1
  return Math.min(1, Math.max(0, (time - start) / (end - start)))
}