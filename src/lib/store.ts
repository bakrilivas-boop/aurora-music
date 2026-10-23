import { create } from 'zustand'
import { engine } from './audio'
import * as db from './idb'
import type { HistoryEntry, Playlist, RepeatMode, Settings, Track, ViewKey } from './types'
import { trackSource } from './types'
import type { ScanProgress } from './library'
import { filesFromInput, pickDirectory, queryHandlePermission, readDuration, scanHandle, buildTracks, buildNativeTrack, collectLocalAssets } from './library'

export type SortKey = 'title' | 'artist' | 'album' | 'addedAt' | 'duration' | 'playlist'

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'success' | 'error'
}

interface AppState {
  ready: boolean
  scanning: boolean
  scanProgress: ScanProgress | null
  hasHandle: boolean
  needsPermission: boolean
  tracks: Track[]
  playlists: Playlist[]
  favorites: string[]
  history: HistoryEntry[]
  currentId: string | null
  queue: string[]
  queueIndex: number
  playing: boolean
  settings: Settings
  view: ViewKey
  activePlaylistId: string | null
  search: string
  sortKey: SortKey
  sortAsc: boolean
  nowPlayingOpen: boolean
  settingsOpen: boolean
  toasts: Toast[]
  analyzing: boolean

  init: () => Promise<void>
  importFolder: () => Promise<void>
  importFromInput: (input: HTMLInputElement) => Promise<void>
  rescan: (handle?: FileSystemDirectoryHandle) => Promise<void>
  grantPermission: () => Promise<void>
  removeAll: () => Promise<void>
  syncNativeLibrary: () => Promise<void>

  setView: (v: ViewKey, playlistId?: string) => void
  setSearch: (s: string) => void
  setSort: (k: SortKey) => void
  toggleNowPlaying: (open?: boolean) => void
  toggleSettings: (open?: boolean) => void

  playTrack: (id: string, queueIds?: string[]) => void
  playQueue: (ids: string[], startIndex: number, shuffle?: boolean) => void
  togglePlay: () => void
  next: (auto?: boolean) => void
  prev: () => void
  seek: (t: number) => void
  addToQueue: (id: string) => void
  removeFromQueue: (id: string) => void
  moveInQueue: (id: string, targetIndex: number) => void
  clearQueue: () => void

  setVolume: (v: number) => void
  toggleMute: () => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  updateSettings: (patch: Partial<Settings>) => void

  toggleFavorite: (id: string) => void
  addHistory: (id: string) => void

  createPlaylist: (name: string) => string
  deletePlaylist: (id: string) => void
  renamePlaylist: (id: string, name: string) => void
  addToPlaylist: (playlistId: string, trackId: string) => void
  removeFromPlaylist: (playlistId: string, trackId: string) => void
  reorderPlaylist: (playlistId: string, ids: string[], expectedIds: string[]) => boolean

  pushToast: (text: string, kind?: Toast['kind']) => void
  dismissToast: (id: number) => void
}

let toastSeq = 0
let saveTimer: ReturnType<typeof setTimeout> | null = null
let settingsTimer: ReturnType<typeof setTimeout> | null = null
let boundEngine = false
let analysisGeneration = 0
let initialization: Promise<void> | null = null
let nativeSync: Promise<void> | null = null
let nativeSyncAgain = false
let ignoredNative = new Set<string>()
const failedTracks = new Set<string>()

/** 设置写入做防抖，拖动音量/均衡器时不会频繁落库 */
function persistSettings(settings: Settings) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem('aurora-settings', JSON.stringify(settings)) } catch { /* Desktop also keeps a native checkpoint. */ }
  const saved = window.auroraDesktop?.settingsWrite?.(settings)
  if (saved && !saved.ok) usePlayer.getState().pushToast(saved.message || '设置保存失败，请检查本机配置目录', 'error')
  if (settingsTimer) clearTimeout(settingsTimer)
  settingsTimer = setTimeout(() => void db.kvSet('settings', settings), 350)
}

function scheduleSaveTracks(get: () => AppState) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void db.saveTracks(get().tracks)
  }, 900)
}

function shuffleOrder(ids: string[], current: string | null): string[] {
  if (ids.length <= 1) return ids.slice()
  const rest = ids.filter((id) => id !== current)
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[rest[i], rest[j]] = [rest[j], rest[i]]
  }
  return current ? [current, ...rest] : rest
}

export const usePlayer = create<AppState>()((set, get) => ({
  ready: false,
  scanning: false,
  scanProgress: null,
  hasHandle: false,
  needsPermission: false,
  tracks: [],
  playlists: [],
  favorites: [],
  history: [],
  currentId: null,
  queue: [],
  queueIndex: 0,
  playing: false,
  settings: db.DEFAULT_SETTINGS,
  view: 'home',
  activePlaylistId: null,
  search: '',
  sortKey: 'addedAt',
  sortAsc: false,
  nowPlayingOpen: false,
  settingsOpen: false,
  toasts: [],
  analyzing: false,

  init: () => initialization ??= (async () => {
    const savedSettings = (await db.kvGet<Partial<Settings>>('settings')) || {}
    let checkpoint: Partial<Settings> = {}
    try { if (typeof localStorage !== 'undefined') checkpoint = JSON.parse(localStorage.getItem('aurora-settings') || '{}') || {} } catch { /* Legacy IndexedDB remains a fallback. */ }
    const nativeSettings = window.auroraDesktop?.settingsRead?.() || {}
    const settings: Settings = { ...db.DEFAULT_SETTINGS, ...savedSettings, ...checkpoint, ...nativeSettings }
    if (window.auroraDesktop?.settingsWrite && !Object.keys(nativeSettings).length) window.auroraDesktop.settingsWrite(settings)
    const [tracks, playlists] = await Promise.all([db.loadTracks(), db.loadPlaylists()])
    const favorites = (await db.kvGet<string[]>('favorites')) || []
    const history = (await db.kvGet<HistoryEntry[]>('history')) || []
    const handle = await db.kvGet<FileSystemDirectoryHandle>('rootHandle')
    ignoredNative = new Set((await db.kvGet<string[]>('ignoredNative')) || [])

    engine.setVolume(settings.volume)
    engine.setMuted(settings.muted)
    engine.setEq(settings.eqGains, settings.eqEnabled)

    set({
      settings,
      tracks,
      playlists,
      favorites,
      history,
      hasHandle: !!handle,
      ready: true,
    })

    if (!boundEngine) {
      boundEngine = true
      engine.onPlaybackChange((playing) => set({ playing }))
      engine.onEnded(() => {
        failedTracks.clear()
        get().next(true)
      })
      engine.onError((error) => {
        if (error?.name === 'NotAllowedError') {
          get().pushToast('播放未获允许，请点击播放按钮重试', 'error')
          return
        }
        const { currentId, queue, queueIndex } = get()
        if (currentId) failedTracks.add(currentId)
        get().pushToast('当前曲目无法播放，已尝试切换下一首', 'error')
        playIndex((queueIndex + 1) % Math.max(1, queue.length), failedTracks)
      })
    }

    if (handle) {
      const granted = await queryHandlePermission(handle)
      if (granted) {
        void get().rescan(handle)
      } else {
        set({ needsPermission: true })
      }
    }
  })(),

  syncNativeLibrary: () => {
    if (!window.auroraDesktop?.nativeLibrary || !get().ready) return Promise.resolve()
    if (nativeSync) { nativeSyncAgain = true; return nativeSync }
    nativeSync = (async () => {
      do {
        nativeSyncAgain = false
        const generation = analysisGeneration
        const items = (await window.auroraDesktop!.nativeLibrary()).filter((item) => !ignoredNative.has(item.id))
        const old = new Map(get().tracks.filter((track) => track.nativeId).map((track) => [track.nativeId!, track]))
        for (let offset = 0; offset < items.length && generation === analysisGeneration; offset += 4) {
          const batch = await Promise.all(items.slice(offset, offset + 4).map(async (item) => {
            const cached = old.get(item.id)
            if (cached?.nativeUrl && cached.size === item.size && cached.nativeModified === item.lastModified) return cached
            try { return await buildNativeTrack(item, cached) } catch { return null }
          }))
          const parsed = batch.filter((track): track is Track => !!track)
          if (generation !== analysisGeneration) { releaseCovers(parsed, get().tracks); break }
          const additions = new Map(parsed.map((track) => [track.id, track]))
          const tracks = get().tracks.map((track) => additions.get(track.id) || track)
          const existing = new Set(tracks.map((track) => track.id))
          tracks.push(...parsed.filter((track) => !existing.has(track.id)))
          releaseCovers(get().tracks, tracks)
          set({ tracks })
        }
        if (generation === analysisGeneration) {
          const present = new Set(items.map((item) => item.id))
          set({ tracks: get().tracks.map((track) => track.nativeId && !present.has(track.nativeId) ? { ...track, nativeUrl: undefined } : track) })
          await db.saveTracks(get().tracks)
          void analyzeDurations()
        }
      } while (nativeSyncAgain)
    })().finally(() => { nativeSync = null })
    return nativeSync
  },

  grantPermission: async () => {
    const handle = await db.kvGet<FileSystemDirectoryHandle>('rootHandle')
    if (!handle) {
      set({ needsPermission: false })
      return
    }
    const granted = await queryHandlePermission(handle, true)
    if (granted) {
      set({ needsPermission: false })
      await get().rescan(handle)
    } else {
      get().pushToast('未获得文件夹访问权限', 'error')
    }
  },

  importFolder: async () => {
    if (get().scanning) return
    const handle = await pickDirectory()
    if (!handle) {
      get().pushToast('已取消选择文件夹', 'info')
      return
    }
    const generation = analysisGeneration
    set({ scanning: true, scanProgress: { done: 0, total: 0, phase: 'walk' } })
    try {
      await db.kvSet('rootHandle', handle)
      set({ hasHandle: true, needsPermission: false })
      const scanned = await scanHandle(handle, (p) => set({ scanProgress: p }))
      await commitScan(set, get, scanned, generation)
    } catch (e) {
      get().pushToast(`扫描失败：${(e as Error).message}`, 'error')
    } finally {
      set({ scanning: false, scanProgress: null })
    }
  },

  importFromInput: async (input: HTMLInputElement) => {
    const files = filesFromInput(input)
    if (!files.length) {
      get().pushToast('没有发现音频文件', 'error')
      return
    }
    const generation = analysisGeneration
    set({ scanning: true, scanProgress: { done: 0, total: files.length, phase: 'parse' } })
    try {
      const { lrcMap, coverMap } = collectLocalAssets(Array.from(input.files || []))
      const scanned = await buildTracks(files, lrcMap, (p) => set({ scanProgress: p }), coverMap)
      await commitScan(set, get, scanned, generation)
    } catch (e) {
      get().pushToast(`导入失败：${(e as Error).message}`, 'error')
    } finally {
      set({ scanning: false, scanProgress: null })
    }
  },

  rescan: async (handle?: FileSystemDirectoryHandle) => {
    const target = handle ?? (await db.kvGet<FileSystemDirectoryHandle>('rootHandle'))
    if (!target) {
      get().pushToast('还没有绑定音乐文件夹', 'info')
      return
    }
    if (get().scanning) return
    const generation = analysisGeneration
    set({ scanning: true, scanProgress: { done: 0, total: 0, phase: 'walk' } })
    try {
      const scanned = await scanHandle(target, (p) => set({ scanProgress: p }))
      await commitScan(set, get, scanned, generation)
    } catch (e) {
      get().pushToast(`扫描失败：${(e as Error).message}`, 'error')
    } finally {
      set({ scanning: false, scanProgress: null })
    }
  },

  removeAll: async () => {
    analysisGeneration++
    ignoredNative = new Set(get().tracks.filter((track) => track.nativeId).map((track) => track.nativeId!))
    if (window.auroraDesktop?.nativeLibrary) {
      try { for (const item of await window.auroraDesktop.nativeLibrary()) ignoredNative.add(item.id) } catch { /* Preserve known exclusions even if a drive is offline. */ }
    }
    await db.kvSet('ignoredNative', [...ignoredNative])
    engine.clear()
    releaseCovers(get().tracks)
    failedTracks.clear()
    set({
      tracks: [],
      currentId: null,
      queue: [],
      queueIndex: 0,
      playing: false,
      favorites: [],
      history: [],
      analyzing: false,
      nowPlayingOpen: false,
    })
    await db.kvDel('rootHandle')
    await db.saveTracks([])
    await db.kvSet('favorites', [])
    await db.kvSet('history', [])
    set({ hasHandle: false, needsPermission: false })
    get().pushToast('已清空音乐库', 'success')
  },

  setView: (v, playlistId) => set((state) => ({ view: v, activePlaylistId: playlistId ?? null, search: '',
    ...(v === 'playlist' ? { sortKey: 'playlist' as const, sortAsc: true } : state.sortKey === 'playlist' ? { sortKey: 'addedAt' as const, sortAsc: false } : {}),
  })),
  setSearch: (s) => set({ search: s }),
  setSort: (k) => {
    const { sortKey, sortAsc } = get()
    if (sortKey === k) set({ sortAsc: !sortAsc })
    else set({ sortKey: k, sortAsc: k === 'title' || k === 'artist' || k === 'playlist' })
  },
  toggleNowPlaying: (open) => set({ nowPlayingOpen: open ?? !get().nowPlayingOpen }),
  toggleSettings: (open) => set({ settingsOpen: open ?? !get().settingsOpen }),

  playTrack: (id, queueIds) => {
    const state = get()
    const track = state.tracks.find((t) => t.id === id)
    if (!track) return
    if (!track || !trackSource(track)) {
      get().pushToast('曲目文件未加载，请重新导入音乐文件夹', 'error')
      return
    }
    let queue = queueIds && queueIds.length ? queueIds.slice() : state.queue.length ? state.queue.slice() : state.tracks.map((t) => t.id)
    if (!queue.includes(id)) queue.unshift(id)
    if (state.settings.shuffle) queue = shuffleOrder(queue, id)
    const index = Math.max(0, queue.indexOf(id))
    failedTracks.clear()
    set({ currentId: id, queue, queueIndex: index, playing: false })
    engine.loadFile(trackSource(track)!, true)
    get().addHistory(id)
  },

  playQueue: (ids, startIndex, shuffle) => {
    const state = get()
    if (!ids.length) return
    const start = Number.isFinite(startIndex) ? Math.max(0, Math.min(ids.length - 1, Math.trunc(startIndex))) : 0
    const selectedId = ids[start]
    const track = state.tracks.find((t) => t.id === selectedId)
    if (!track || !trackSource(track)) {
      get().pushToast('该曲目文件未加载，请重新导入音乐文件夹', 'error')
      return
    }
    const settings = shuffle === undefined ? state.settings : { ...state.settings, shuffle }
    if (shuffle !== undefined) persistSettings(settings)
    let queue = ids.slice()
    if (settings.shuffle) queue = shuffleOrder(queue, selectedId)
    failedTracks.clear()
    set({ queue, queueIndex: queue.indexOf(selectedId), currentId: track.id, playing: false, settings })
    engine.loadFile(trackSource(track)!, true)
    get().addHistory(track.id)
  },

  togglePlay: () => {
    const state = get()
    if (!state.currentId) {
      if (state.tracks.length) {
        const first = state.tracks.find((t) => trackSource(t))
        if (first) get().playTrack(first.id)
        else get().pushToast('曲目文件未加载，请先导入音乐文件夹', 'error')
      }
      return
    }
    const track = state.tracks.find((t) => t.id === state.currentId)
    if (!track || !trackSource(track)) {
      get().pushToast('曲目文件未加载，请重新导入音乐文件夹', 'error')
      return
    }
    if (engine.paused) {
      failedTracks.clear()
      void engine.play()
    } else {
      engine.pause()
      set({ playing: false })
    }
  },

  next: (auto = false) => {
    const { queue, queueIndex, settings, currentId } = get()
    if (!queue.length) return
    if (auto && settings.repeat === 'one' && currentId) {
      engine.seek(0)
      void engine.play()
      return
    }
    // 随机模式已在建立队列时洗牌，按队列走可以避免重复抽到已播曲目。
    let index = queueIndex + 1
    if (index >= queue.length) {
      if (settings.repeat === 'all') index = 0
      else {
        engine.pause()
        set({ playing: false })
        return
      }
    }
    playIndex(index)
  },

  prev: () => {
    const { queue, queueIndex } = get()
    if (!queue.length) return
    if (engine.currentTime > 3) {
      engine.seek(0)
      return
    }
    const index = queueIndex - 1 < 0 ? queue.length - 1 : queueIndex - 1
    playIndex(index)
  },

  seek: (t) => engine.seek(t),

  addToQueue: (id) => {
    const { queue } = get()
    if (queue.includes(id)) {
      get().pushToast('已在播放队列中', 'info')
      return
    }
    set({ queue: [...queue, id] })
    get().pushToast('已加入播放队列', 'success')
  },

  removeFromQueue: (id) => {
    const { queue, queueIndex, currentId } = get()
    const idx = queue.indexOf(id)
    if (idx < 0) return
    const nextQueue = queue.filter((x) => x !== id)
    if (!nextQueue.length) {
      get().clearQueue()
      return
    }
    let nextIndex = queueIndex
    if (idx < queueIndex) nextIndex = Math.max(0, queueIndex - 1)
    if (currentId === id) {
      set({ queue: nextQueue, queueIndex: Math.min(nextIndex, Math.max(0, nextQueue.length - 1)) })
      if (nextQueue.length) playIndex(Math.min(nextIndex, nextQueue.length - 1))
    } else {
      set({ queue: nextQueue, queueIndex: nextIndex })
    }
  },

  moveInQueue: (id, targetIndex) => {
    const { queue, currentId } = get()
    const index = queue.indexOf(id)
    if (index < 0 || !Number.isFinite(targetIndex)) return
    const target = Math.max(0, Math.min(queue.length - 1, Math.trunc(targetIndex)))
    if (index === target) return
    const nextQueue = queue.slice()
    nextQueue.splice(index, 1)
    nextQueue.splice(target, 0, id)
    set({ queue: nextQueue, queueIndex: Math.max(0, currentId ? nextQueue.indexOf(currentId) : 0) })
  },

  clearQueue: () => {
    engine.clear()
    failedTracks.clear()
    set({ queue: [], queueIndex: 0, currentId: null, playing: false, nowPlayingOpen: false })
  },

  setVolume: (v) => {
    const vol = Math.max(0, Math.min(1, v))
    engine.setVolume(vol)
    if (vol > 0 && get().settings.muted) engine.setMuted(false)
    const settings = { ...get().settings, volume: vol, muted: vol > 0 ? false : get().settings.muted }
    set({ settings })
    persistSettings(settings)
  },

  toggleMute: () => {
    const muted = !get().settings.muted
    engine.setMuted(muted)
    const settings = { ...get().settings, muted }
    set({ settings })
    persistSettings(settings)
  },

  toggleShuffle: () => {
    const settings = { ...get().settings, shuffle: !get().settings.shuffle }
    set({ settings })
    persistSettings(settings)
    if (settings.shuffle && get().queue.length) {
      set({ queue: shuffleOrder(get().queue, get().currentId), queueIndex: 0 })
    }
    get().pushToast(settings.shuffle ? '随机播放已开启' : '随机播放已关闭', 'info')
  },

  cycleRepeat: () => {
    const order: RepeatMode[] = ['off', 'all', 'one']
    const next = order[(order.indexOf(get().settings.repeat) + 1) % order.length]
    const settings = { ...get().settings, repeat: next }
    set({ settings })
    persistSettings(settings)
  },

  updateSettings: (patch) => {
    const settings = { ...get().settings, ...patch }
    set({ settings })
    persistSettings(settings)
    if (patch.eqEnabled !== undefined || patch.eqGains !== undefined) {
      engine.setEq(settings.eqGains, settings.eqEnabled)
    }
    if (patch.volume !== undefined) engine.setVolume(settings.volume)
    if (patch.muted !== undefined) engine.setMuted(settings.muted)
  },

  toggleFavorite: (id) => {
    const fav = get().favorites
    const next = fav.includes(id) ? fav.filter((x) => x !== id) : [...fav, id]
    set({ favorites: next })
    void db.kvSet('favorites', next)
  },

  addHistory: (id) => {
    const entry: HistoryEntry = { id, at: Date.now() }
    const next = [entry, ...get().history.filter((h) => h.id !== id)].slice(0, 300)
    set({ history: next })
    void db.kvSet('history', next)
  },

  createPlaylist: (name) => {
    const playlist: Playlist = {
      id: `pl_${Date.now().toString(36)}`,
      name: name.trim() || '新建歌单',
      trackIds: [],
      createdAt: Date.now(),
    }
    const next = [...get().playlists, playlist]
    set({ playlists: next })
    void db.savePlaylists(next)
    get().pushToast(`已创建歌单「${playlist.name}」`, 'success')
    return playlist.id
  },

  deletePlaylist: (id) => {
    const next = get().playlists.filter((p) => p.id !== id)
    set({ playlists: next, activePlaylistId: get().activePlaylistId === id ? null : get().activePlaylistId })
    void db.savePlaylists(next)
  },

  renamePlaylist: (id, name) => {
    const next = get().playlists.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p))
    set({ playlists: next })
    void db.savePlaylists(next)
  },

  addToPlaylist: (playlistId, trackId) => {
    const next = get().playlists.map((p) => {
      if (p.id !== playlistId) return p
      if (p.trackIds.includes(trackId)) return p
      return { ...p, trackIds: [...p.trackIds, trackId] }
    })
    set({ playlists: next })
    void db.savePlaylists(next)
    get().pushToast('已添加到歌单', 'success')
  },

  removeFromPlaylist: (playlistId, trackId) => {
    const next = get().playlists.map((p) =>
      p.id === playlistId ? { ...p, trackIds: p.trackIds.filter((t) => t !== trackId) } : p,
    )
    set({ playlists: next })
    void db.savePlaylists(next)
  },

  reorderPlaylist: (playlistId, ids, expectedIds) => {
    const state = get()
    const playlist = state.playlists.find((item) => item.id === playlistId)
    if (!playlist || !ids.length || ids.length !== playlist.trackIds.length || expectedIds.length !== playlist.trackIds.length ||
      playlist.trackIds.some((id, index) => id !== expectedIds[index]) || new Set(ids).size !== ids.length) return false
    const members = new Set(playlist.trackIds)
    const known = new Set(state.tracks.map((track) => track.id))
    if (ids.some((id) => !members.has(id) || !known.has(id))) return false
    const next = state.playlists.map((item) => item.id === playlistId ? { ...item, trackIds: ids.slice() } : item)
    set({ playlists: next })
    void db.savePlaylists(next)
    return true
  },

  pushToast: (text, kind = 'info') => {
    const id = ++toastSeq
    set({ toasts: [...get().toasts.slice(-2), { id, text, kind }] })
    setTimeout(() => get().dismissToast(id), 2800)
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))

/** 播放队列中指定位置，遇到无文件曲目自动跳过 */
function playIndex(index: number, excluded = new Set<string>()): boolean {
  const { queue, tracks } = usePlayer.getState()
  if (!queue.length) return false
  let i = Math.max(0, Math.min(queue.length - 1, index))
  for (let guard = 0; guard < queue.length; guard++) {
    const track = tracks.find((t) => t.id === queue[i])
    if (track && trackSource(track) && !excluded.has(track.id)) {
      usePlayer.setState({ currentId: track.id, queueIndex: i, playing: false })
      engine.loadFile(trackSource(track)!, true)
      usePlayer.getState().addHistory(track.id)
      return true
    }
    i = (i + 1) % queue.length
  }
  engine.pause()
  usePlayer.setState({ playing: false })
  usePlayer.getState().pushToast('队列中所有曲目都不可用，请重新导入音乐文件夹', 'error')
  return false
}

function releaseCovers(tracks: Track[], keep: Track[] = []): void {
  const retained = new Set(keep.map((track) => track.cover))
  for (const track of tracks) {
    if (track.cover?.startsWith('blob:') && !retained.has(track.cover)) URL.revokeObjectURL(track.cover)
  }
}

async function commitScan(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
  scanned: Track[],
  generation: number,
): Promise<void> {
  if (generation !== analysisGeneration) {
    releaseCovers(scanned, get().tracks)
    return
  }
  if (!scanned.length) {
    get().pushToast('没有找到音频文件', 'error')
    return
  }
  const prev = new Map(get().tracks.map((t) => [t.id, t]))
  for (const t of scanned) {
    const old = prev.get(t.id)
    if (old) {
      t.addedAt = old.addedAt
      if (!t.duration && old.duration) {
        t.duration = old.duration
        t.analyzed = true
      }
    }
  }
  const scannedIds = new Set(scanned.map((track) => track.id))
  scanned.push(...get().tracks.filter((track) => track.nativeId && !scannedIds.has(track.id)))
  scanned.sort((a, b) => b.addedAt - a.addedAt)
  analysisGeneration++
  releaseCovers(get().tracks, scanned)
  set({ tracks: scanned, analyzing: false })
  void db.saveTracks(scanned)
  get().pushToast(`已导入 ${scanned.length} 首曲目`, 'success')
  void analyzeDurations()
  if (window.auroraDesktop?.nativeLibrary) void get().syncNativeLibrary()
}

/** 后台补齐时长（标签里没有时长的格式），3 路并发 */
export async function analyzeDurations(): Promise<void> {
  const state = usePlayer.getState()
  if (state.analyzing || !state.settings.autoAnalyze) return
  const missing = state.tracks.filter((t) => trackSource(t) && (!t.analyzed || !t.duration))
  if (!missing.length) return
  const generation = analysisGeneration
  usePlayer.setState({ analyzing: true })
  let dirty = false
  let cursor = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const pending = new Map<string, { file: File | string; duration: number }>()
  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = null
    if (generation !== analysisGeneration || !pending.size) return
    const tracks = usePlayer.getState().tracks.map((track) => {
      const update = pending.get(track.id)
      return update && trackSource(track) === update.file ? { ...track, duration: update.duration, analyzed: true } : track
    })
    pending.clear()
    usePlayer.setState({ tracks })
    dirty = true
  }
  const worker = async () => {
    for (;;) {
      const track = missing[cursor++]
      if (!track || !trackSource(track) || generation !== analysisGeneration) return
      const d = await readDuration(trackSource(track)!).catch(() => 0)
      if (generation !== analysisGeneration) return
      if (d > 0) {
        pending.set(track.id, { file: trackSource(track)!, duration: d })
        if (pending.size >= 20) flush()
        else if (!timer) timer = setTimeout(flush, 200)
      }
    }
  }
  await Promise.all([worker(), worker(), worker()])

  flush()
  if (generation !== analysisGeneration) return
  usePlayer.setState({ analyzing: false })
  if (dirty) void db.saveTracks(usePlayer.getState().tracks)
}

/** 当前曲目对象 */
export function useCurrentTrack(): Track | null {
  return usePlayer((s) => s.tracks.find((t) => t.id === s.currentId) ?? null)
}
