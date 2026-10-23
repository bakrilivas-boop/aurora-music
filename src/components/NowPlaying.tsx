import { useEffect, useMemo, useRef, useState } from 'react'
import { engine } from '../lib/audio'
import { activeLineIndex, lineProgress, parseLrc } from '../lib/lyrics'
import { usePlayer } from '../lib/store'
import { MetadataInfo } from './MetadataLoader'
import { Cover, CurrentTime, fmtTime, ProgressBar, Spectrum, TotalTime, useEngineFrame } from './common'
import {
  IconClose,
  IconHeart,
  IconMusic,
  IconNext,
  IconPause,
  IconPlay,
  IconPrev,
  IconRepeat,
  IconRepeatOne,
  IconShuffle,
} from './Icons'

export function NowPlaying() {
  const tracks = usePlayer((s) => s.tracks)
  const currentId = usePlayer((s) => s.currentId)
  const playing = usePlayer((s) => s.playing)
  const settings = usePlayer((s) => s.settings)
  const toggleNowPlaying = usePlayer((s) => s.toggleNowPlaying)
  const togglePlay = usePlayer((s) => s.togglePlay)
  const next = usePlayer((s) => s.next)
  const prev = usePlayer((s) => s.prev)
  const toggleShuffle = usePlayer((s) => s.toggleShuffle)
  const cycleRepeat = usePlayer((s) => s.cycleRepeat)
  const favorites = usePlayer((s) => s.favorites)
  const toggleFavorite = usePlayer((s) => s.toggleFavorite)

  const current = tracks.find((t) => t.id === currentId) ?? null
  const liked = current ? favorites.includes(current.id) : false

  const parsed = useMemo(() => {
    const raw = current?.embeddedLyrics || ''
    const p = parseLrc(raw)
    return { ...p, raw, synced: p.lines.length > 0 }
  }, [current?.id, current?.embeddedLyrics])

  const wrapRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [lineIdx, setLineIdx] = useState(-1)
  const idxRef = useRef(-1)

  useEngineFrame((t) => {
    if (!parsed.synced) return
    const idx = activeLineIndex(parsed.lines, t)
    if (idx !== idxRef.current) {
      const prev = listRef.current?.querySelector<HTMLElement>('.lyric-line.active .ly-fill')
      if (prev) prev.style.setProperty('--p', '0%')
      idxRef.current = idx
      setLineIdx(idx)
      return
    }
    const active = listRef.current?.querySelector<HTMLElement>('.lyric-line.active .ly-fill')
    if (active && idx >= 0) {
      const p = lineProgress(parsed.lines, idx, t)
      active.style.setProperty('--p', `${(p * 100).toFixed(1)}%`)
    }
  })

  useEffect(() => {
    idxRef.current = -1
    setLineIdx(-1)
  }, [current?.id])

  useEffect(() => {
    const list = listRef.current
    const wrap = wrapRef.current
    if (!list || !wrap) return
    const el = list.children[lineIdx] as HTMLElement | undefined
    if (!el) {
      list.style.transform = 'translateY(0px)'
      return
    }
    const offset = el.offsetTop - wrap.clientHeight / 2 + el.offsetHeight / 2
    list.style.transform = `translateY(${-offset}px)`
  }, [lineIdx, parsed.lines.length])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleNowPlaying(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleNowPlaying])

  if (!current) return null

  const bg = current.cover ? { backgroundImage: `url("${current.cover}")` } : undefined

  return (
    <div className="now-playing">
      <div className="np-bg" style={bg} />
      <div className="np-veil" />

      <div className="np-top">
        <span className="np-label">正在播放</span>
        {current.album && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>/ {current.album}</span>}
        <button className="np-close" onClick={() => toggleNowPlaying(false)} title="收起 (Esc)">
          <IconClose size={17} />
        </button>
      </div>

      <div className="np-body">
        <div className="np-stage">
          <div className="np-cover-wrap">
            <div className="np-glow" />
            <Cover src={current.cover} className="np-cover" iconSize={48} />
          </div>

          <div className="np-meta">
            <div className="np-title" title={current.title}>
              {current.title}
            </div>
            <div className="np-artist" title={current.artist}>
              {current.artist}
            </div>
            <div className="np-badge">
              <IconMusic size={11} />
              {current.format}
              {current.year ? ` · ${current.year}` : ''}
              {current.duration ? ` · ${fmtTime(current.duration)}` : ''}
            </div>
            <MetadataInfo id={current.id} />
          </div>

          {settings.showSpectrum && <Spectrum height={96} bars={54} />}
        </div>

        <div className="np-lyrics-wrap" ref={wrapRef}>
          {parsed.synced ? (
            <div className="np-lyrics" ref={listRef}>
              {parsed.lines.map((line, i) => (
                <div
                  key={`${line.time}-${i}`}
                  className={`lyric-line${i === lineIdx ? ' active' : ''}`}
                  onClick={() => engine.seek(line.time)}
                  title="点击跳转"
                >
                  <span className="ly-fill">{line.text || '♪'}</span>
                </div>
              ))}
            </div>
          ) : parsed.raw ? (
            <div className="lyric-plain">{parsed.raw}</div>
          ) : (
            <div className="lyric-empty">
              暂无歌词
              <br />
              <span style={{ fontSize: 12, opacity: 0.7 }}>
                可自动联网匹配，或把同名 .lrc 放在音频旁边后重新扫描
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="np-bottom">
        <div className="np-progress">
          <CurrentTime />
          <ProgressBar />
          <TotalTime track={current} />
        </div>
        <div className="np-controls">
          <button className={`ctrl${settings.shuffle ? ' on' : ''}`} onClick={toggleShuffle} title="随机播放">
            <IconShuffle size={18} />
          </button>
          <button className="ctrl" onClick={prev} title="上一首">
            <IconPrev size={20} />
          </button>
          <button className="ctrl-play" onClick={togglePlay} title={playing ? '暂停' : '播放'}>
            {playing ? <IconPause size={22} /> : <IconPlay size={22} />}
          </button>
          <button className="ctrl" onClick={() => next()} title="下一首">
            <IconNext size={20} />
          </button>
          <button
            className={`ctrl${settings.repeat !== 'off' ? ' on' : ''}`}
            onClick={cycleRepeat}
            title="循环模式"
          >
            {settings.repeat === 'one' ? <IconRepeatOne size={18} /> : <IconRepeat size={18} />}
          </button>
          <button
            className={`ctrl${liked ? ' on' : ''}`}
            onClick={() => toggleFavorite(current.id)}
            title="收藏"
            style={{ color: liked ? 'var(--danger)' : undefined }}
          >
            <IconHeart size={18} filled={liked} />
          </button>
        </div>
      </div>
    </div>
  )
}
