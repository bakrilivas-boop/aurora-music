import { useEffect, useState } from 'react'
import { usePlayer } from '../lib/store'
import { engine } from '../lib/audio'
import { IconMusic } from './Icons'
import '../desktop.css'
import type { MetadataInput, MetadataResult } from '../lib/metadata'
import type { AiInfo, AiInput, AiRecommendation } from '../lib/ai'
import type { NativeTrackFile, Settings } from '../lib/types'

declare global {
  interface Window {
    auroraDesktop?: {
      info: () => Promise<{ version: string; maximized: boolean }>
      settingsRead: () => Partial<Settings>
      settingsWrite: (value: Settings) => { ok: boolean; message?: string }
      nativeLibrary: () => Promise<NativeTrackFile[]>
      onLibraryChanged: (callback: () => void) => () => void
      metadata: (input: MetadataInput) => Promise<MetadataResult>
      aiInfo: () => Promise<AiInfo>
      aiConfigure: (input: { apiKey: string }) => Promise<AiInfo>
      aiRecommend: (input: AiInput) => Promise<AiRecommendation>
      window: (action: 'minimize' | 'maximize' | 'close') => Promise<void>
      playback: (value: { title: string; artist: string; playing: boolean }) => void
      onState: (callback: (value: { maximized: boolean }) => void) => () => void
      onCommand: (callback: (action: string) => void) => () => void
    }
  }
}

export function DesktopBar() {
  const desktop = window.auroraDesktop
  const playing = usePlayer((s) => s.playing)
  const current = usePlayer((s) => s.tracks.find((t) => t.id === s.currentId))
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!desktop) return
    document.documentElement.classList.add('desktop-shell')
    void desktop.info().then((info) => setMaximized(info.maximized))
    const stopState = desktop.onState((state) => setMaximized(state.maximized))
    const stopCommands = desktop.onCommand((action) => {
      const s = usePlayer.getState()
      if (action === 'togglePlay') s.togglePlay()
      else if (action === 'next') s.next()
      else if (action === 'prev') s.prev()
      else if (action === 'import') void s.importFolder()
      else if (action === 'settings') s.toggleSettings(true)
    })
    return () => { stopState(); stopCommands() }
  }, [desktop])

  useEffect(() => {
    desktop?.playback({ title: current?.title || '', artist: current?.artist || '', playing })
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.metadata = current ? new MediaMetadata({ title: current.title, artist: current.artist, album: current.album, artwork: current.cover ? [{ src: current.cover }] : [] }) : null
    navigator.mediaSession.playbackState = current ? playing ? 'playing' : 'paused' : 'none'
  }, [desktop, current?.id, current?.title, current?.artist, current?.album, current?.cover, playing])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const actions: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: () => { if (engine.paused) usePlayer.getState().togglePlay() },
      pause: () => { if (!engine.paused) usePlayer.getState().togglePlay() },
      previoustrack: () => usePlayer.getState().prev(),
      nexttrack: () => usePlayer.getState().next(),
      seekto: (event) => { if (event.seekTime !== undefined) engine.seek(event.seekTime) },
      seekbackward: (event) => engine.seek(engine.currentTime - (event.seekOffset || 5)),
      seekforward: (event) => engine.seek(engine.currentTime + (event.seekOffset || 5)),
    }
    for (const [action, handler] of Object.entries(actions)) {
      try { navigator.mediaSession.setActionHandler(action as MediaSessionAction, handler) } catch { /* optional action */ }
    }
    let lastSecond = -1
    const stop = engine.onFrame((time, duration) => {
      if (!duration || Math.floor(time) === lastSecond) return
      lastSecond = Math.floor(time)
      try { navigator.mediaSession.setPositionState({ duration, playbackRate: 1, position: Math.min(duration, Math.max(0, time)) }) } catch { /* metadata loading */ }
    })
    return () => { stop(); for (const action of Object.keys(actions)) { try { navigator.mediaSession.setActionHandler(action as MediaSessionAction, null) } catch { /* optional */ } } }
  }, [])

  if (!desktop) return null
  return (
    <div className="desktop-bar" onDoubleClick={() => void desktop.window('maximize')}>
      <div className="desktop-brand"><IconMusic size={13} /><span>Aurora Music</span><span className="desktop-badge">本地音乐</span></div>
      <span className="desktop-status">{current ? (playing ? '正在播放' : '已暂停') + ' · ' + current.title : '每一首，都属于你'}</span>
      <div className="window-controls" onDoubleClick={(event) => event.stopPropagation()}>
        <button aria-label="最小化" title="最小化" onClick={() => void desktop.window('minimize')}><svg width="12" height="12"><path d="M1 6h10" /></svg></button>
        <button aria-label={maximized ? '还原窗口' : '最大化'} title={maximized ? '还原窗口' : '最大化'} onClick={() => void desktop.window('maximize')}><svg width="12" height="12">{maximized ? <path d="M4 1h7v7M1 4h7v7H1Z" /> : <path d="M1.5 1.5h9v9h-9Z" />}</svg></button>
        <button className="window-close" aria-label="关闭窗口" title="关闭窗口" onClick={() => void desktop.window('close')}><svg width="12" height="12"><path d="m2 2 8 8m0-8-8 8" /></svg></button>
      </div>
    </div>
  )
}
