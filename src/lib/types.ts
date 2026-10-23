export interface Track {
  id: string
  /** 相对「导入根目录」的路径，用于重扫时稳定匹配 */
  relPath: string
  filename: string
  title: string
  artist: string
  album: string
  year?: string
  genre?: string
  trackNo?: number
  /** 秒，0 表示未知 */
  duration: number
  format: string
  size: number
  addedAt: number
  /** 封面 blob url，仅运行时 */
  cover?: string
  /** 歌词原始文本（内嵌），仅运行时 */
  embeddedLyrics?: string
  /** 外挂 lrc 是否存在 */
  hasLrc?: boolean
  /** 运行时文件句柄，刷新后为 undefined */
  file?: File
  /** Desktop download file, served in ranges from the local app origin. */
  nativeId?: string
  nativeModified?: number
  nativeUrl?: string
  /** 时长是否已解析 */
  analyzed?: boolean
}

export interface NativeTrackFile { id: string; filename: string; size: number; lastModified: number }
export function trackSource(track?: Track | null): File | string | undefined { return track?.file || track?.nativeUrl }

export type ViewKey = 'home' | 'library' | 'albums' | 'artists' | 'favorites' | 'recent' | 'playlist'

export interface Playlist {
  id: string
  name: string
  trackIds: string[]
  createdAt: number
}

export interface HistoryEntry {
  id: string
  at: number
}

export type RepeatMode = 'off' | 'all' | 'one'

export interface EqBand {
  freq: number
  gain: number
}

export interface Settings {
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: RepeatMode
  eqEnabled: boolean
  eqGains: number[]
  showSpectrum: boolean
  accent: string
  autoAnalyze: boolean
  reducedMotion: boolean
  autoMetadata: boolean
}
