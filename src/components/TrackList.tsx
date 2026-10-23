import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePlayer } from '../lib/store'
import { trackSource, type Track } from '../lib/types'
import { fmtTime, Cover } from './common'
import {
  IconArrowDown,
  IconArrowUp,
  IconHeart,
  IconMusic,
  IconPause,
  IconPlay,
  IconPlus,
  IconQueue,
  IconTrash,
} from './Icons'
import { formatBytes } from '../lib/library'

interface Props {
  tracks: Track[]
  queueIds?: string[]
  onRemove?: (id: string) => void
  removeLabel?: string
}

interface MenuState {
  x: number
  y: number
  track: Track
  subOpen: boolean
}

const COLUMNS: { key: 'title' | 'artist' | 'album' | 'duration' | null; label: string; className?: string }[] = [
  { key: null, label: '#' },
  { key: 'title', label: '标题' },
  { key: 'artist', label: '艺术家' },
  { key: 'album', label: '专辑' },
  { key: 'duration', label: '时长' },
  { key: null, label: '' },
]

export function TrackList({ tracks, queueIds, onRemove, removeLabel = '从歌单移除' }: Props) {
  const currentId = usePlayer((s) => s.currentId)
  const playing = usePlayer((s) => s.playing)
  const playTrack = usePlayer((s) => s.playTrack)
  const togglePlay = usePlayer((s) => s.togglePlay)
  const favorites = usePlayer((s) => s.favorites)
  const toggleFavorite = usePlayer((s) => s.toggleFavorite)
  const addToQueue = usePlayer((s) => s.addToQueue)
  const addToPlaylist = usePlayer((s) => s.addToPlaylist)
  const playlists = usePlayer((s) => s.playlists)
  const createPlaylist = usePlayer((s) => s.createPlaylist)
  const sortKey = usePlayer((s) => s.sortKey)
  const sortAsc = usePlayer((s) => s.sortAsc)
  const setSort = usePlayer((s) => s.setSort)
  const pushToast = usePlayer((s) => s.pushToast)

  const [menu, setMenu] = useState<MenuState | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 60 })
  const virtual = tracks.length > 150

  // Only mount nearby rows; the outer content pane remains the single scroll container.
  useLayoutEffect(() => {
    if (!virtual) return
    const viewport = viewportRef.current
    const host = viewport?.closest('.content')
    if (!viewport || !host) return
    let frame = 0
    const measure = () => {
      const offset = host.getBoundingClientRect().top - viewport.getBoundingClientRect().top
      const start = Math.min(Math.max(0, tracks.length - 1), Math.max(0, Math.floor(offset / 58) - 8))
      const end = Math.min(tracks.length, Math.max(start + 1, Math.ceil((offset + host.clientHeight) / 58) + 8))
      setRange((old) => old.start === start && old.end === end ? old : { start, end })
    }
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure() }) }
    measure()
    host.addEventListener('scroll', onScroll, { passive: true })
    const resize = new ResizeObserver(onScroll)
    resize.observe(host)
    return () => { host.removeEventListener('scroll', onScroll); resize.disconnect(); cancelAnimationFrame(frame) }
  }, [virtual, tracks])

  useEffect(() => {
    if (!menu) return
    const onDown = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onDown, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onDown, true)
    }
  }, [menu])

  const favSet = useMemo(() => new Set(favorites), [favorites])
  const ids = useMemo(() => queueIds ?? tracks.map((t) => t.id), [queueIds, tracks])
  const start = virtual ? Math.min(range.start, Math.max(0, tracks.length - 1)) : 0
  const end = virtual ? Math.max(start + 1, Math.min(range.end, tracks.length)) : tracks.length

  const handlePlay = (track: Track, index: number) => {
    if (!trackSource(track)) {
      pushToast('曲目文件未加载，请重新导入音乐文件夹', 'error')
      return
    }
    if (track.id === currentId) {
      togglePlay()
    } else {
      playTrack(track.id, ids)
      void index
    }
  }

  return (
    <>
      <div className="track-table" role="table" aria-label="歌曲列表" aria-rowcount={tracks.length + 1}>
        <div className="track-head">
          {COLUMNS.map((c, i) => (
            <div
              key={i}
              className={`th${c.key ? '' : ' no-sort'}${c.key && sortKey === c.key ? ' sorted' : ''}`}
              onClick={() => c.key && setSort(c.key)}
              role={c.key ? 'button' : undefined}
              tabIndex={c.key ? 0 : undefined}
              aria-label={c.key ? '按' + c.label + '排序' : undefined}
              onKeyDown={(e) => { if (c.key && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); setSort(c.key) } }}
              style={i === 4 ? { justifyContent: 'flex-end' } : undefined}
            >
              {c.label}
              {c.key && sortKey === c.key && (sortAsc ? <IconArrowUp size={11} /> : <IconArrowDown size={11} />)}
            </div>
          ))}
        </div>

        <div ref={viewportRef} className="track-viewport">
        {start > 0 && <div aria-hidden="true" style={{ height: start * 58 }} />}
        {tracks.slice(start, end).map((track, offset) => {
          const index = start + offset
          const isCurrent = track.id === currentId
          const isPlaying = isCurrent && playing
          return (
            <div
              key={track.id}
              className={`track-row${isCurrent ? ' playing' : ''}`}
              tabIndex={0}
              role="row"
              aria-rowindex={index + 2}
              aria-current={isCurrent ? 'true' : undefined}
              aria-label={track.title + '，' + track.artist}
              onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); handlePlay(track, index) } }}
              onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('button')) handlePlay(track, index) }}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: Math.min(e.clientX, window.innerWidth - 220), y: Math.min(e.clientY, window.innerHeight - 340), track, subOpen: false })
              }}
            >
              <div className="t-idx" onClick={() => handlePlay(track, index)}>
                {isPlaying ? (
                  <div className="t-eq">
                    <i />
                    <i />
                    <i />
                  </div>
                ) : (
                  <>
                    <span className="t-idx-num">{index + 1}</span>
                    <span className="t-idx-play">{isCurrent ? <IconPause size={13} /> : <IconPlay size={13} />}</span>
                  </>
                )}
              </div>

              <div className="t-main">
                <Cover src={track.cover} seed={track.artist + track.title} className="t-cover" iconSize={16} />
                <div className="t-text">
                  <span className="t-title">
                    {track.title}
                    {!trackSource(track) && (
                      <span className="badge-fmt" style={{ color: 'var(--danger)', borderColor: 'rgba(255,93,115,.3)' }}>
                        未加载
                      </span>
                    )}
                  </span>
                  <span className="t-sub">
                    {track.format}
                    {track.year ? ` · ${track.year}` : ''}
                    {track.size ? ` · ${formatBytes(track.size)}` : ''}
                  </span>
                </div>
              </div>

              <span className="t-artist" title={track.artist}>
                {track.artist}
              </span>
              <span className="t-album" title={track.album}>
                {track.album}
              </span>
              <span className="t-dur">{track.duration ? fmtTime(track.duration) : '--:--'}</span>

              <div className="t-act">
                <button
                  className={`t-btn${favSet.has(track.id) ? ' liked' : ''}`}
                  title={favSet.has(track.id) ? '取消收藏' : '收藏'}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleFavorite(track.id)
                  }}
                >
                  <IconHeart size={14} />
                </button>
                <button
                  className="t-btn"
                  title="更多"
                  style={{ opacity: 0.85 }}
                  onClick={(e) => {
                    e.stopPropagation()
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    setMenu({
                      x: Math.min(rect.left - 150, window.innerWidth - 220),
                      y: Math.min(rect.bottom + 6, window.innerHeight - 340),
                      track,
                      subOpen: false,
                    })
                  }}
                >
                  <IconQueue size={14} />
                </button>
              </div>
            </div>
          )
        })}
        {end < tracks.length && <div aria-hidden="true" style={{ height: (tracks.length - end) * 58 }} />}
        </div>
      </div>

      {menu &&
        createPortal(
          <div
            className="context-menu"
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button
              className="cm-item"
              onClick={() => {
                handlePlay(menu.track, 0)
                setMenu(null)
              }}
            >
              <IconPlay size={14} />
              播放
            </button>
            <button
              className="cm-item"
              onClick={() => {
                addToQueue(menu.track.id)
                setMenu(null)
              }}
            >
              <IconPlus size={14} />
              加入播放队列
            </button>
            <button
              className="cm-item"
              onClick={() => {
                toggleFavorite(menu.track.id)
                setMenu(null)
              }}
            >
              <IconHeart size={14} />
              {favSet.has(menu.track.id) ? '取消收藏' : '收藏'}
            </button>

            <div className="cm-sep" />
            <div className="cm-label">添加到歌单</div>
            {playlists.map((pl) => (
              <button
                key={pl.id}
                className="cm-item"
                onClick={() => {
                  addToPlaylist(pl.id, menu.track.id)
                  setMenu(null)
                }}
              >
                <IconMusic size={14} />
                {pl.name}
              </button>
            ))}
            <button
              className="cm-item"
              onClick={() => {
                const id = createPlaylist('新建歌单')
                addToPlaylist(id, menu.track.id)
                setMenu(null)
              }}
            >
              <IconPlus size={14} />
              新建歌单并添加
            </button>

            <div className="cm-sep" />
            <button
              className="cm-item"
              onClick={() => {
                const t = menu.track
                pushToast(
                  `${t.title} · ${t.artist} · ${t.format}${t.duration ? ` · ${fmtTime(t.duration)}` : ''} · ${formatBytes(t.size)}`,
                  'info',
                )
                setMenu(null)
              }}
            >
              <IconQueue size={14} />
              文件信息
            </button>
            {onRemove && (
              <button
                className="cm-item danger"
                onClick={() => {
                  onRemove(menu.track.id)
                  setMenu(null)
                }}
              >
                <IconTrash size={14} />
                {removeLabel}
              </button>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
