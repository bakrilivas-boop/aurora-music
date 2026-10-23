import type { Playlist, Settings, Track } from './types'

const DB_NAME = 'aurora-music'
const DB_VER = 1

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv')
      if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const s = t.objectStore(store)
        const req = fn(s)
        t.oncomplete = () => resolve(req.result)
        req.onerror = () => reject(req.error)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error || new Error('本地存储事务被中止'))
      }),
  )
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  try {
    return await tx<T | undefined>('kv', 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>)
  } catch {
    return undefined
  }
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  try {
    await tx('kv', 'readwrite', (s) => s.put(value, key) as IDBRequest<unknown>)
  } catch {
    /* 忽略配额/序列化错误 */
  }
}

export async function kvDel(key: string): Promise<void> {
  try {
    await tx('kv', 'readwrite', (s) => s.delete(key) as IDBRequest<undefined>)
  } catch {
    /* noop */
  }
}

/** 只持久化可序列化字段，去掉 File / blob URL */
function sanitize(t: Track): Track {
  const { file, cover, embeddedLyrics, nativeUrl, ...rest } = t
  void file
  void cover
  void embeddedLyrics
  void nativeUrl
  return rest as Track
}

export async function saveTracks(tracks: Track[]): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction('tracks', 'readwrite')
      const s = t.objectStore('tracks')
      s.clear()
      for (const tr of tracks) s.put(sanitize(tr))
      t.oncomplete = () => resolve()
      t.onerror = () => reject(t.error)
    })
  } catch {
    /* noop */
  }
}

export async function loadTracks(): Promise<Track[]> {
  try {
    const arr = await tx<Track[]>('tracks', 'readonly', (s) => s.getAll())
    return (arr || []).sort((a, b) => b.addedAt - a.addedAt)
  } catch {
    return []
  }
}

export async function savePlaylists(list: Playlist[]): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction('playlists', 'readwrite')
      const s = t.objectStore('playlists')
      s.clear()
      for (const p of list) s.put(p)
      t.oncomplete = () => resolve()
      t.onerror = () => reject(t.error)
    })
  } catch {
    /* noop */
  }
}

export async function loadPlaylists(): Promise<Playlist[]> {
  try {
    const arr = await tx<Playlist[]>('playlists', 'readonly', (s) => s.getAll())
    return (arr || []).sort((a, b) => a.createdAt - b.createdAt)
  } catch {
    return []
  }
}

export const DEFAULT_SETTINGS: Settings = {
  volume: 0.8,
  muted: false,
  shuffle: false,
  repeat: 'all',
  eqEnabled: false,
  eqGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  showSpectrum: true,
  accent: '#a291ff',
  autoAnalyze: true,
  reducedMotion: false,
  autoMetadata: true,
}

export async function clearLibrary(): Promise<void> {
  await saveTracks([])
  await kvDel('rootHandle')
}
