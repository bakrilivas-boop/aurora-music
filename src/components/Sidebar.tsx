import { useEffect, useRef, useState } from 'react'
import { usePlayer } from '../lib/store'
import type { ViewKey } from '../lib/types'
import {
  IconDisc,
  IconFolder,
  IconHeart,
  IconLibrary,
  IconMic,
  IconMusic,
  IconPlus,
  IconSettings,
  IconSpark,
  IconTrash,
  IconClock,
} from './Icons'

const NAV: { key: ViewKey; label: string; icon: (p: { size?: number }) => JSX.Element }[] = [
  { key: 'home', label: '首页', icon: IconSpark },
  { key: 'library', label: '歌曲库', icon: IconLibrary },
  { key: 'albums', label: '专辑', icon: IconDisc },
  { key: 'artists', label: '艺术家', icon: IconMic },
  { key: 'favorites', label: '我的收藏', icon: IconHeart },
  { key: 'recent', label: '最近播放', icon: IconClock },
]

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const view = usePlayer((s) => s.view)
  const setView = usePlayer((s) => s.setView)
  const tracks = usePlayer((s) => s.tracks)
  const favorites = usePlayer((s) => s.favorites)
  const playlists = usePlayer((s) => s.playlists)
  const activePlaylistId = usePlayer((s) => s.activePlaylistId)
  const createPlaylist = usePlayer((s) => s.createPlaylist)
  const deletePlaylist = usePlayer((s) => s.deletePlaylist)
  const toggleSettings = usePlayer((s) => s.toggleSettings)
  const settingsOpen = usePlayer((s) => s.settingsOpen)
  const importFolder = usePlayer((s) => s.importFolder)
  const scanning = usePlayer((s) => s.scanning)

  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (creating) inputRef.current?.focus()
  }, [creating])

  const commit = () => {
    if (draft.trim()) createPlaylist(draft)
    setDraft('')
    setCreating(false)
  }

  return (
    <aside className={`sidebar${open ? ' open' : ''}`}>
      <div className="brand">
        <div className="brand-mark">
          <IconSpark size={19} />
        </div>
        <div className="brand-text">
          <strong>Aurora Music</strong>
          <span>离线音乐播放器</span>
        </div>
      </div>

      <div className="nav-label">我的音乐</div>
      <nav className="nav" aria-label="音乐库导航">
        {NAV.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            className={`nav-item${view === key ? ' active' : ''}`}
            aria-current={view === key ? 'page' : undefined}
            onClick={() => {
              setView(key)
              onClose()
            }}
          >
            <Icon size={17} />
            <span>{label}</span>
            {key === 'library' && <span className="count">{tracks.length}</span>}
            {key === 'favorites' && favorites.length > 0 && <span className="count">{favorites.length}</span>}
          </button>
        ))}
      </nav>

      <div className="nav-label" style={{ display: 'flex', alignItems: 'center' }}>
        <span>我的歌单</span>
        <button
          className="row-act"
          style={{ marginLeft: 'auto', opacity: 1 }}
          title="新建歌单"
          onClick={() => setCreating(true)}
        >
          <IconPlus size={14} />
        </button>
      </div>

      <div className="playlist-scroll">
        {creating && (
          <div className="playlist-row" style={{ background: 'var(--panel)' }}>
            <IconMusic size={14} />
            <input
              ref={inputRef}
              className="text-input"
              style={{ height: 26, fontSize: 12.5, padding: '0 8px' }}
              placeholder="歌单名称，回车确认"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
                if (e.key === 'Escape') {
                  setCreating(false)
                  setDraft('')
                }
              }}
              onBlur={commit}
            />
          </div>
        )}

        {playlists.map((pl) => (
          <div
            key={pl.id}
            className={`playlist-row${view === 'playlist' && activePlaylistId === pl.id ? ' active' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => {
              setView('playlist', pl.id)
              onClose()
            }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
              e.preventDefault()
              setView('playlist', pl.id)
              onClose()
            }}
          >
            <IconMusic size={14} />
            <span className="trunc">{pl.name}</span>
            <span className="count" style={{ fontSize: 10.5 }}>
              {pl.trackIds.length}
            </span>
            <button
              className="row-act"
              title="删除歌单"
              onClick={(e) => {
                e.stopPropagation()
                deletePlaylist(pl.id)
              }}
            >
              <IconTrash size={13} />
            </button>
          </div>
        ))}

        {!playlists.length && !creating && (
          <div className="empty-hint" style={{ padding: '10px 12px', fontSize: 11.5 }}>
            还没有歌单，点击上方 + 新建
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <div className="library-status"><span /> 本地音乐库 <strong>{tracks.length} 首</strong></div>
        <button className="nav-item" onClick={() => void importFolder()} disabled={scanning}>
          <IconFolder size={17} />
          <span>{scanning ? '正在扫描…' : '导入音乐文件夹'}</span>
        </button>
        <button
          className={`nav-item${settingsOpen ? ' active' : ''}`}
          onClick={() => toggleSettings()}
        >
          <IconSettings size={17} />
          <span>设置与均衡器</span>
        </button>
      </div>
    </aside>
  )
}
