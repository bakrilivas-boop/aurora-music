import { useEffect, useRef, useState } from 'react'
import { usePlayer, type SortKey } from '../lib/store'
import { IconArrowDown, IconArrowUp, IconFolder, IconMenu, IconRefresh, IconSearch, IconSettings, IconSpark } from './Icons'

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'addedAt', label: '最近添加' },
  { key: 'title', label: '标题' },
  { key: 'artist', label: '艺术家' },
  { key: 'album', label: '专辑' },
  { key: 'duration', label: '时长' },
]

export function TopBar({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const search = usePlayer((s) => s.search)
  const setSearch = usePlayer((s) => s.setSearch)
  const sortKey = usePlayer((s) => s.sortKey)
  const sortAsc = usePlayer((s) => s.sortAsc)
  const setSort = usePlayer((s) => s.setSort)
  const importFolder = usePlayer((s) => s.importFolder)
  const rescan = usePlayer((s) => s.rescan)
  const scanning = usePlayer((s) => s.scanning)
  const hasHandle = usePlayer((s) => s.hasHandle)
  const toggleSettings = usePlayer((s) => s.toggleSettings)
  const view = usePlayer((s) => s.view)

  const inputRef = useRef<HTMLInputElement>(null)
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
      if (e.key === 'Escape' && document.activeElement === inputRef.current) {
        setSearch('')
        inputRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSearch])

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const showSort = view === 'library' || view === 'favorites' || view === 'recent' || view === 'playlist'
  const sortOptions = view === 'playlist' ? [{ key: 'playlist' as const, label: '歌单顺序' }, ...SORTS] : SORTS

  return (
    <header className="topbar">
      <button className="btn icon-only ghost mobile-nav-btn" onClick={onOpenSidebar} title="菜单">
        <IconMenu size={16} />
      </button>

      <div className="search-box">
        <IconSearch size={15} />
        <input
          ref={inputRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索歌曲、艺术家或专辑…"
          aria-label="搜索音乐"
          spellCheck={false}
        />
        {search ? (
          <button className="row-act" style={{ opacity: 1 }} onClick={() => setSearch('')} title="清空">
            ✕
          </button>
        ) : (
          <span className="kbd-hint">Ctrl F</span>
        )}
      </div>

      {showSort && (
        <div style={{ position: 'relative' }} ref={menuRef}>
          <button className="btn" onClick={() => setMenu((v) => !v)}>
            {sortOptions.find((s) => s.key === sortKey)?.label}
            {sortAsc ? <IconArrowUp size={13} /> : <IconArrowDown size={13} />}
          </button>
          {menu && (
            <div className="context-menu" style={{ position: 'absolute', top: 42, left: 0 }}>
              <div className="cm-label">排序方式</div>
              {sortOptions.map((s) => (
                <button
                  key={s.key}
                  className="cm-item"
                  onClick={() => {
                    setSort(s.key)
                    setMenu(false)
                  }}
                >
                  {s.label}
                  {sortKey === s.key && (
                    <span style={{ marginLeft: 'auto', opacity: 0.7 }}>{sortAsc ? '↑' : '↓'}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="top-actions">
        <button className="btn" onClick={() => window.dispatchEvent(new Event('aurora:downloads-open'))}><IconArrowDown size={14} />获取歌曲</button>
        <button className="btn ai-trigger" aria-label="AI 音乐助手" title="DeepSeek 音乐助手 (Ctrl K)" onClick={() => window.dispatchEvent(new Event('aurora:ai-open'))}><IconSpark size={15} /><span>AI 助手</span></button>
        {hasHandle && (
          <button className="btn ghost icon-only" title="重新扫描文件夹" onClick={() => void rescan()} disabled={scanning}>
            <IconRefresh size={16} />
          </button>
        )}
        <button className="btn primary" data-import-folder onClick={() => void importFolder()} disabled={scanning}>
          <IconFolder size={15} />
          {scanning ? '扫描中…' : '导入文件夹'}
        </button>
        <button className="btn icon-only" title="设置" onClick={() => toggleSettings(true)}>
          <IconSettings size={16} />
        </button>
      </div>
    </header>
  )
}
