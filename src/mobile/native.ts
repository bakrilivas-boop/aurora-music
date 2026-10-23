import { Capacitor, registerPlugin } from '@capacitor/core'
import { App } from '@capacitor/app'
import { engine, installPlaybackEngine } from '../lib/audio'
import { usePlayer } from '../lib/store'
import * as db from '../lib/idb'
import { parseAudioTags, isAudioFile, extOf, guessFromName } from '../lib/tags'
import { readLyrics } from '../lib/library'
import type { Track } from '../lib/types'

interface MobileFile { id: string; name: string; relative: string; uri: string; size: number }
interface PlaybackState { id: string; playing: boolean; position: number; duration: number; queue?: string[]; error?: string }
interface AndroidBridge {
  pick(options: { folder: boolean }): Promise<{ files: MobileFile[]; cancelled?: boolean; failed?: number }>
  readRange(options: { uri: string; start: number; length: number }): Promise<{ data: string }>
  artwork(options: { id: string; data: string; mime: string }): Promise<{ uri: string }>
  queue(options: { items: { id: string; uri: string; title: string; artist: string; artwork?: string }[]; index: number; position: number; play: boolean; repeat: string; volume: number }): Promise<void>
  control(options: { action: string; value?: number | string }): Promise<void>
  state(): Promise<PlaybackState>
  addListener(event: string, cb: (value: any) => void): Promise<{ remove(): Promise<void> }>
}
export const Android = registerPlugin<AndroidBridge>('AuroraAudio')
export const isAndroid = Capacitor.getPlatform() === 'android'
export const fileUrl = (uri?: string) => uri ? Capacitor.convertFileSrc(uri) : undefined

function fromBase64(raw: string) {
  const value = atob(raw)
  return Uint8Array.from(value, c => c.charCodeAt(0))
}
function toBase64(bytes: Uint8Array) {
  let raw = ''
  for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(raw)
}
export function restoreMobileTrack(track: Track): Track {
  return track.mobileUri ? { ...track, nativeUrl: fileUrl(track.mobileUri), cover: fileUrl(track.mobileCover), embeddedLyrics: track.mobileLyrics } : track
}

export async function importAndroid(folder: boolean) {
  const store = usePlayer.getState()
  if (store.scanning) return
  usePlayer.setState({ scanning: true, scanProgress: { done: 0, total: 0, phase: 'walk' } })
  try {
    const result = await Android.pick({ folder })
    if (result.cancelled) return
    const audio = result.files.filter(f => isAudioFile(f.name))
    const lookup = new Map(result.files.map(f => [f.relative.toLowerCase(), f]))
    const read = async (f: MobileFile, start: number, end: number) => {
      const { data } = await Android.readRange({ uri: f.uri, start, length: Math.max(0, Math.min(end, f.size) - start) })
      return fromBase64(data)
    }
    const additions: Track[] = []
    let failed = result.failed || 0
    for (let i = 0; i < audio.length; i++) {
      const f = audio[i]
      usePlayer.setState({ scanProgress: { done: i, total: audio.length, phase: 'parse' } })
      try {
        const meta = await parseAudioTags({ name: f.name, size: f.size, slice: (start, end) => ({ arrayBuffer: async () => (await read(f, start, end)).buffer as ArrayBuffer }) })
        const name = guessFromName(f.name)
        const base = f.relative.replace(/\.[^.]+$/, '').toLowerCase()
        const dir = base.slice(0, base.lastIndexOf('/') + 1)
        const lyricFile = lookup.get(base + '.lrc') || lookup.get(base + '.txt')
        const lyrics = (lyricFile ? await readLyrics({ arrayBuffer: async () => (await read(lyricFile, 0, Math.min(lyricFile.size, 4 * 1024 * 1024))).buffer as ArrayBuffer }) : undefined) || meta.lyrics
        let cover: string | undefined
        if (meta.picture) {
          cover = (await Android.artwork({ id: f.id, data: toBase64(meta.picture.bytes), mime: meta.picture.mime })).uri
        } else {
          const picture = [base, dir + 'cover', dir + 'folder', dir + 'front'].flatMap(n => ['jpg', 'jpeg', 'png', 'webp'].map(e => lookup.get(`${n}.${e}`))).find(Boolean)
          if (picture && picture.size <= 16 * 1024 * 1024) cover = picture.uri
        }
        const old = store.tracks.find(t => t.id === `android_${f.id}`)
        additions.push(restoreMobileTrack({ id: `android_${f.id}`, mobileUri: f.uri, mobileCover: cover, mobileLyrics: lyrics,
          filename: f.name, relPath: f.relative, title: meta.title || name.title, artist: meta.artist || name.artist || '未知歌手',
          album: meta.album || '本地音乐', genre: meta.genre, year: meta.year, format: extOf(f.name).toUpperCase(),
          size: f.size, duration: meta.duration || old?.duration || 0, analyzed: !!meta.duration, addedAt: old?.addedAt || Date.now(), hasLrc: !!lyricFile }))
      } catch { failed++ }
    }
    const byId = new Map(usePlayer.getState().tracks.map(t => [t.id, t]))
    additions.forEach(t => byId.set(t.id, t))
    const tracks = [...byId.values()].sort((a, b) => b.addedAt - a.addedAt)
    usePlayer.setState({ tracks })
    await db.saveTracks(tracks)
    store.pushToast(additions.length ? `已导入 ${additions.length} 首${failed ? `，${failed} 个文件读取失败` : ''}` : failed ? '文件读取失败，请从手机本地存储重试' : '未找到歌曲，可选择音乐所在文件夹', additions.length ? 'success' : 'error')
  } catch (error) { store.pushToast((error as Error).message || '导入失败，请重试', 'error') }
  finally { usePlayer.setState({ scanning: false, scanProgress: null }) }
}

class AndroidEngine {
  readonly el = engine.el
  private snapshot: PlaybackState = { id: '', playing: false, position: 0, duration: 0 }
  private frames = new Set<(t: number, d: number) => void>()
  private playback = new Set<(playing: boolean) => void>()
  private errors = new Set<(error?: Error) => void>()
  private pending: Promise<unknown> = Promise.resolve()
  constructor() {
    void Android.addListener('playback', state => this.accept(state))
    // Native playback and queue advancement continue while the WebView is suspended.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void Android.state().then(s => this.accept(s)) })
    setInterval(() => { if (!document.hidden && this.snapshot.id) void Android.state().then(s => this.accept(s)).catch(() => {}) }, 250)
    usePlayer.subscribe((s, old) => {
      if (s.ready && !old.ready) void Android.state().then(state => this.accept(state)).catch(() => {})
      if (s.queue !== old.queue && s.currentId === old.currentId && s.currentId) this.sendQueue(false)
      if (s.settings.repeat !== old.settings.repeat) this.run(() => Android.control({ action: 'repeat', value: s.settings.repeat }))
    })
  }
  private run(fn: () => Promise<unknown>) {
    this.pending = this.pending.then(fn).catch(error => { this.errors.forEach(cb => cb(error)); })
    return this.pending
  }
  private accept(state: PlaybackState) {
    const playingChanged = this.snapshot.playing !== state.playing
    this.snapshot = state
    const s = usePlayer.getState()
    if (state.id && !s.queue.includes(state.id) && s.tracks.some(t => t.id === state.id)) {
      const queue = (state.queue || [state.id]).filter(id => s.tracks.some(t => t.id === id))
      usePlayer.setState({ queue, currentId: state.id, queueIndex: queue.indexOf(state.id), playing: state.playing })
    }
    if (state.id && s.queue.includes(state.id) && state.id !== s.currentId) {
      usePlayer.setState({ currentId: state.id, queueIndex: s.queue.indexOf(state.id) })
      s.addHistory(state.id)
    }
    if (playingChanged) this.playback.forEach(cb => cb(state.playing))
    this.frames.forEach(cb => cb(state.position, state.duration))
    if (state.error) { s.pushToast(state.error, 'error') }
  }
  private sendQueue(start: boolean) {
    const s = usePlayer.getState()
    const items = s.queue.map(id => s.tracks.find(t => t.id === id)).filter((t): t is Track => !!t?.mobileUri)
      .map(t => ({ id: t.id, uri: t.mobileUri!, title: t.title, artist: t.artist, artwork: t.mobileCover }))
    const index = items.findIndex(t => t.id === s.currentId)
    if (index < 0) return
    const position = start ? 0 : this.snapshot.position
    this.run(() => Android.queue({ items, index, position, play: start || this.snapshot.playing, repeat: s.settings.repeat, volume: s.settings.muted ? 0 : s.settings.volume }))
  }
  loadFile(_file: File | string, autoplay = true) { this.sendQueue(autoplay) }
  async play() { await this.run(() => Android.control({ action: 'play' })) }
  pause() { this.run(() => Android.control({ action: 'pause' })) }
  clear() { this.run(() => Android.control({ action: 'clear' })); this.snapshot = { id: '', playing: false, position: 0, duration: 0 } }
  seek(value: number) { this.run(() => Android.control({ action: 'seek', value })) }
  setVolume(value: number) { this.run(() => Android.control({ action: 'volume', value })) }
  setMuted(m: boolean) { this.setVolume(m ? 0 : usePlayer.getState().settings.volume) }
  setEq() {}
  getAnalyser() { return null }
  getContext() { return null }
  get paused() { return !this.snapshot.playing }
  get currentTime() { return this.snapshot.position }
  get duration() { return this.snapshot.duration }
  syncState() {}
  onFrame(cb: (t: number, d: number) => void) { this.frames.add(cb); cb(this.currentTime, this.duration); return () => { this.frames.delete(cb) } }
  onPlaybackChange(cb: (playing: boolean) => void) { this.playback.add(cb); return () => { this.playback.delete(cb) } }
  onError(cb: (error?: Error) => void) { this.errors.add(cb); return () => { this.errors.delete(cb) } }
  onEnded(_cb: () => void) { return () => {} }
}

export function initializeMobile() {
  if (!isAndroid) return
  installPlaybackEngine(new AndroidEngine())
  void App.addListener('backButton', () => window.dispatchEvent(new Event('aurora-back')))
}
