import { useCallback, useEffect, useRef, useState } from 'react'
import { engine } from './lib/audio'
import { analyzeDurations, usePlayer } from './lib/store'
import { buildTracks } from './lib/library'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { Views } from './components/Views'
import { PlayerBar } from './components/PlayerBar'
import { NowPlaying } from './components/NowPlaying'
import { SettingsModal } from './components/SettingsModal'
import { QueueDrawer, Toasts } from './components/Overlays'
import { DesktopBar } from './components/DesktopBar'
import { MetadataLoader } from './components/MetadataLoader'
import { AiAssistant } from './components/AiAssistant'
import { Downloads } from './components/Downloads'

/** 封面驱动的双缓冲氛围背景 */
function Aura({ src }: { src?: string }) {
  const [slots, setSlots] = useState<[string, string]>(['', ''])
  const [active, setActive] = useState(0)
  const activeRef = useRef(0)

  useEffect(() => {
    if (!src) { setSlots(['', '']); return }
    const idx = 1 - activeRef.current
    activeRef.current = idx
    setSlots((prev) => {
      const next = [prev[0], prev[1]] as [string, string]
      next[idx] = src
      return next
    })
    setActive(idx)
  }, [src])

  return (
    <div className="aura">
      <div className={`aura-layer${active === 0 ? ' on' : ''}`} style={slots[0] ? { backgroundImage: `url("${slots[0]}")` } : undefined} />
      <div className={`aura-layer${active === 1 ? ' on' : ''}`} style={slots[1] ? { backgroundImage: `url("${slots[1]}")` } : undefined} />
    </div>
  )
}

/** 开发期演示数据（仅 ?demo=1 且 DEV 构建时生效，生产构建会被移除） */
let demoLoaded = false

export default function App() {
  const init = usePlayer((s) => s.init)
  const ready = usePlayer((s) => s.ready)
  const currentId = usePlayer((s) => s.currentId)
  const cover = usePlayer((s) => s.tracks.find((t) => t.id === s.currentId)?.cover)
  const nowPlayingOpen = usePlayer((s) => s.nowPlayingOpen)
  const settings = usePlayer((s) => s.settings)
  const view = usePlayer((s) => s.view)
  const activePlaylistId = usePlayer((s) => s.activePlaylistId)
  const contentRef = useRef<HTMLElement>(null)
  const [queueOpen, setQueueOpen] = useState(false)
  const closeQueue = useCallback(() => setQueueOpen(false), [])
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => { contentRef.current?.scrollTo({ top: 0 }) }, [view, activePlaylistId])

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    const desktop = window.auroraDesktop
    if (!ready || !desktop?.nativeLibrary) return
    const sync = () => { void usePlayer.getState().syncNativeLibrary().catch(() => usePlayer.getState().pushToast('下载歌曲自动入库暂未完成，请检查保存目录', 'error')) }
    sync()
    const unsubscribe = desktop.onLibraryChanged(sync)
    window.addEventListener('focus', sync)
    return () => { unsubscribe(); window.removeEventListener('focus', sync) }
  }, [ready])

  // 开发期演示数据（仅 ?demo=1 且 DEV 构建时生效，生产构建会被移除）
  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (!new URLSearchParams(location.search).has('demo')) return
    if (demoLoaded) return
    demoLoaded = true
    void (async () => {
      await new Promise<void>((resolve) => {
        if (usePlayer.getState().ready) return resolve()
        const unsub = usePlayer.subscribe((s) => {
          if (s.ready) {
            unsub()
            resolve()
          }
        })
      })
      const names = ['林深 - 夜航.wav', '海雾 - 潮汐.wav', '夏至 - 橘子汽水.wav', 'Nova - Aurora.wav', '陈默 - 城市清晨.wav']
      const found: { file: File; relPath: string; dir: string }[] = []
      const lrcMap = new Map<string, File>()
      for (const name of names) {
        try {
          const res = await fetch(`/test-music/${encodeURIComponent(name)}`)
          if (!res.ok) continue
          const blob = await res.blob()
          found.push({ file: new File([blob], name, { type: 'audio/wav' }), relPath: name, dir: '' })
          const base = name.replace(/\.wav$/, '')
          const lres = await fetch(`/test-music/${encodeURIComponent(base + '.lrc')}`)
          if (lres.ok) lrcMap.set(base.toLowerCase(), new File([await lres.blob()], base + '.lrc'))
        } catch {
          /* 忽略 */
        }
      }
      if (!found.length) return
      const tracks = await buildTracks(found, lrcMap)
      usePlayer.setState({ tracks })
      void analyzeDurations()
    })()
  }, [])

  // 主色注入
  useEffect(() => {
    document.documentElement.style.setProperty('--accent', settings.accent)
  }, [settings.accent])

  // 全局快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el as HTMLElement | null)?.isContentEditable
      if (typing) return

      const state = usePlayer.getState()
      if (state.settingsOpen || el?.closest('button, [role="button"], [role="row"], [role="slider"], [role="dialog"], [role="menu"]')) return
      switch (e.key) {
        case ' ':
          e.preventDefault()
          state.togglePlay()
          break
        case 'ArrowRight':
          if (state.currentId) {
            e.preventDefault()
            engine.seek(engine.currentTime + 5)
          }
          break
        case 'ArrowLeft':
          if (state.currentId) {
            e.preventDefault()
            engine.seek(Math.max(0, engine.currentTime - 5))
          }
          break
        case 'ArrowUp':
          e.preventDefault()
          state.setVolume(Math.min(1, state.settings.volume + 0.05))
          break
        case 'ArrowDown':
          e.preventDefault()
          state.setVolume(Math.max(0, state.settings.volume - 0.05))
          break
        case 'm':
        case 'M':
          state.toggleMute()
          break
        case 'l':
        case 'L':
          if (state.currentId) state.toggleNowPlaying()
          break
        case 's':
        case 'S':
          state.toggleShuffle()
          break
        case 'f':
        case 'F':
          if ((e.ctrlKey || e.metaKey) === false && state.currentId) state.toggleFavorite(state.currentId)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 不支持 File System Access API 的浏览器：回退到 <input webkitdirectory>
  useEffect(() => {
    if ('showDirectoryPicker' in window) return
    usePlayer.setState({
      importFolder: async () => {
        const input = document.createElement('input')
        input.type = 'file'
        input.multiple = true
        ;(input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true
        input.style.display = 'none'
        input.onchange = () => {
          const target = input
          void usePlayer.getState().importFromInput(target).finally(() => target.remove())
        }
        document.body.appendChild(input)
        input.click()
      },
    })
  }, [])

  return (
    <><DesktopBar /><MetadataLoader /><AiAssistant /><Downloads /><div className="app">
      <Aura src={cover} />
      <div className="aura-mask" />

      {sidebarOpen && <button className="sidebar-backdrop" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />}
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <main className="main">
        <TopBar onOpenSidebar={() => setSidebarOpen((v) => !v)} />
        {!ready ? (
          <div className="content" style={{ display: 'grid', placeItems: 'center' }}>
            <div style={{ display: 'grid', gap: 12, justifyItems: 'center', color: 'var(--text-3)' }}>
              <div className="spinner" style={{ width: 22, height: 22 }} />
              正在载入音乐库…
            </div>
          </div>
        ) : (
          <section className="content" ref={contentRef}>
            <div className="view-surface" key={`${view}:${activePlaylistId ?? ''}`}><Views /></div>
          </section>
        )}
      </main>

      <PlayerBar onOpenQueue={() => setQueueOpen(true)} />

      {nowPlayingOpen && currentId && <NowPlaying />}
      {queueOpen && <QueueDrawer onClose={closeQueue} />}
      <SettingsModal />
      <Toasts />
    </div></>
  )
}
