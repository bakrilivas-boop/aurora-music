import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePlayer } from '../lib/store'
import { fmtTime } from './common'
import { IconClose, IconMusic, IconPlay, IconQueue, IconTrash } from './Icons'

export function QueueDrawer({ onClose }: { onClose: () => void }) {
  const queue = usePlayer((s) => s.queue)
  const currentId = usePlayer((s) => s.currentId)
  const tracks = usePlayer((s) => s.tracks)
  const playTrack = usePlayer((s) => s.playTrack)
  const removeFromQueue = usePlayer((s) => s.removeFromQueue)
  const moveInQueue = usePlayer((s) => s.moveInQueue)
  const clearQueue = usePlayer((s) => s.clearQueue)
  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks])
  const items = useMemo(() => queue.map((id) => byId.get(id)).filter((t): t is NonNullable<typeof t> => !!t), [queue, byId])
  const panel = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const drag = useRef<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [start, setStart] = useState(0)
  const [height, setHeight] = useState(540)
  const virtual = items.length > 100
  const first = virtual ? Math.min(start, Math.max(0, items.length - 1)) : 0
  const end = virtual ? Math.min(items.length, first + Math.ceil(height / 54) + 12) : items.length

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.querySelector<HTMLButtonElement>('button[title="关闭"]')?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    const resize = new ResizeObserver(() => setHeight(list.current?.clientHeight || 540))
    if (list.current) resize.observe(list.current)
    return () => { window.removeEventListener('keydown', onKey); resize.disconnect(); previous?.focus() }
  }, [onClose])

  return createPortal(
    <div className="queue-drawer" role="dialog" aria-label="播放队列" ref={panel}>
      <div className="q-head">
        <IconQueue size={16} /><h3>播放队列</h3>
        <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{items.length} 首</span>
        <button className="ctrl" style={{ marginLeft: 'auto' }} onClick={clearQueue} disabled={!items.length} title="清空播放队列"><IconTrash size={14} /></button>
        <button className="ctrl" onClick={onClose} title="关闭"><IconClose size={15} /></button>
      </div>
      <div className="queue-hint">拖动调整顺序 · 聚焦曲目后 Alt + ↑ / ↓ 也可排序</div>
      <div className="q-list" ref={list} role="list" onScroll={(e) => setStart(Math.max(0, Math.floor(e.currentTarget.scrollTop / 54) - 6))}>
        {!items.length && <div className="empty-hint" style={{ padding: '32px 12px', textAlign: 'center' }}>队列为空，播放任意曲目后会出现在这里</div>}
        {first > 0 && <div aria-hidden="true" style={{ height: first * 54 }} />}
        {items.slice(first, end).map((track, offset) => {
          const index = first + offset
          return (
            <div key={track.id} className={'q-item' + (track.id === currentId ? ' playing' : '') + (over === track.id ? ' drag-over' : '')}
              draggable tabIndex={0} role="listitem" aria-label={track.title + '，队列第 ' + (index + 1) + ' 首'}
              onDoubleClick={() => playTrack(track.id, queue)}
              onKeyDown={(e) => {
                if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); moveInQueue(track.id, index + (e.key === 'ArrowUp' ? -1 : 1)) }
                else if (e.key === 'Enter' && e.target === e.currentTarget) playTrack(track.id, queue)
              }}
              onDragStart={(e) => { drag.current = track.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', track.id) }}
              onDragOver={(e) => { if (drag.current) { e.preventDefault(); setOver(track.id) } }}
              onDrop={(e) => { e.preventDefault(); if (drag.current) moveInQueue(drag.current, index); drag.current = null; setOver(null) }}
              onDragEnd={() => { drag.current = null; setOver(null) }}>
              <span className="q-idx">{index + 1}</span>
              <div className="t-cover" style={{ width: 30, height: 30, borderRadius: 8, ...(track.cover ? { backgroundImage: 'url("' + track.cover + '")' } : {}) }}>{!track.cover && <IconMusic size={13} />}</div>
              <span className="q-title" title={track.title}>{track.title}</span>
              <span className="q-artist" title={track.artist}>{track.artist}</span>
              <span style={{ fontSize: 10.5, color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' }}>{track.duration ? fmtTime(track.duration) : '--:--'}</span>
              <button className="t-btn" style={{ opacity: 1 }} title="从队列移除" onClick={() => removeFromQueue(track.id)}><IconTrash size={13} /></button>
              <button className="t-btn" style={{ opacity: 1 }} title="播放" onClick={() => playTrack(track.id, queue)}><IconPlay size={12} /></button>
            </div>
          )
        })}
        {end < items.length && <div aria-hidden="true" style={{ height: (items.length - end) * 54 }} />}
      </div>
    </div>, document.body,
  )
}

export function Toasts() {
  const toasts = usePlayer((s) => s.toasts)
  return createPortal(
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => <div key={t.id} className={'toast ib ' + t.kind}><span className="t-dot" />{t.text}</div>)}
    </div>, document.body,
  )
}
