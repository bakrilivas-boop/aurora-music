import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { App } from '@capacitor/app'
import { usePlayer, useCurrentTrack } from '../lib/store'
import { engine } from '../lib/audio'
import { parseLrc, activeLineIndex } from '../lib/lyrics'
import { Cover, CurrentTime, TotalTime, fmtTime, useEngineFrame } from '../components/common'
import { IconPlay, IconPause, IconPrev, IconNext, IconShuffle, IconRepeat, IconRepeatOne, IconHeart, IconSearch, IconLibrary, IconDisc, IconSettings, IconQueue, IconLyrics, IconClose, IconFolder, IconPlus, IconMusic, IconArrowDown, IconClock, IconSpark, IconTrash } from '../components/Icons'
import { importAndroid, isAndroid, restoreMobileTrack } from './native'
import MobileDownloads from './MobileDownloads'
import { initializeDownloads, downloadBridge } from './downloads'
import type { Track } from '../lib/types'

type Tab = 'home' | 'library' | 'favorites' | 'playlists'
type Panel = 'import' | 'settings' | 'queue' | 'newPlaylist' | 'addPlaylist' | 'track' | null

function TrackRow({ track, ids, menu, remove }: { track: Track; ids: string[]; menu(track: Track): void; remove?: () => void }) {
  const playing = usePlayer(s => s.currentId === track.id && s.playing)
  const current = usePlayer(s => s.currentId === track.id)
  return <div className={`m-row ${current ? 'current' : ''}`}>
    <button className="m-row-main" onClick={() => usePlayer.getState().playTrack(track.id, ids)} aria-label={`播放 ${track.title}`}><Cover src={track.cover} seed={track.artist + track.title} className="m-row-cover" iconSize={19} /><span><strong>{track.title}</strong><small>{track.artist} <i>·</i> {track.format}</small></span>{playing ? <span className="m-playing-bars"><i /><i /><i /></span> : <em>{fmtTime(track.duration)}</em>}</button>
    <button className="m-icon m-more" aria-label={remove ? `移除 ${track.title}` : `${track.title} 的选项`} onClick={remove || (() => menu(track))}>{remove ? <IconClose size={18} /> : '•••'}</button>
  </div>
}

function Sheet({ title, close, children }: { title: string; close(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('button,input')?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
      if (e.key !== 'Tab') return
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,a') || [])]
      const first = items[0], last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('keydown', key); previous?.focus() }
  }, [])
  return <div className="m-sheet-layer"><button className="m-backdrop" aria-label="关闭面板" onClick={close} /><div ref={ref} className="m-sheet" role="dialog" aria-modal="true" aria-label={title}><div className="m-handle" /><header><h2>{title}</h2><button className="m-icon" aria-label="关闭" onClick={close}><IconClose size={21} /></button></header><div className="m-sheet-body">{children}</div></div></div>
}

function Seek({ small = false }: { small?: boolean }) {
  const ref = useRef<HTMLInputElement>(null)
  const moving = useRef(false)
  useEngineFrame((t, d) => {
    if (!ref.current || moving.current) return
    const ratio = d > 0 ? t / d : 0
    ref.current.value = String(ratio * 1000)
    ref.current.style.setProperty('--progress', `${ratio * 100}%`)
    ref.current.setAttribute('aria-valuetext', `${fmtTime(t)} / ${fmtTime(d)}`)
  })
  return <input ref={ref} className={`m-seek ${small ? 'm-seek-small' : ''}`} aria-label="播放进度" type="range" min="0" max="1000" defaultValue="0"
    onPointerDown={() => { moving.current = true }}
    onPointerCancel={() => { moving.current = false }}
    onInput={e => { e.currentTarget.style.setProperty('--progress', `${Number(e.currentTarget.value) / 10}%`) }}
    onChange={e => { if (!moving.current) engine.seek(Number(e.currentTarget.value) / 1000 * engine.duration) }}
    onPointerUp={e => { engine.seek(Number(e.currentTarget.value) / 1000 * engine.duration); moving.current = false }} />
}

function Lyrics({ track }: { track: Track }) {
  const parsed = useMemo(() => parseLrc(track.embeddedLyrics || ''), [track.embeddedLyrics])
  const [active, setActive] = useState(-1)
  const live = useRef<HTMLButtonElement>(null)
  useEngineFrame(time => setActive(activeLineIndex(parsed.lines, time + parsed.offset)))
  useEffect(() => { live.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }, [active])
  if (!track.embeddedLyrics) return <div className="m-no-lyrics"><IconLyrics size={38} /><h3>让旋律先说话</h3><p>这首歌曲暂时没有歌词。导入音乐文件夹时，会自动读取同名 LRC 和内嵌歌词。</p></div>
  if (!parsed.lines.length) return <div className="m-lyrics-plain">{track.embeddedLyrics}</div>
  return <div className="m-lyrics" aria-label="同步歌词">{parsed.lines.filter(l => l.text).map((line, i) => <button key={`${line.time}-${i}`} ref={active >= 0 && parsed.lines[active] === line ? live : undefined} className={parsed.lines[active] === line ? 'active' : ''} onClick={() => engine.seek(Math.max(0, line.time - parsed.offset))}>{line.text}</button>)}</div>
}

function FullPlayer({ close, queue, more }: { close(): void; queue(): void; more(track: Track): void }) {
  const s = usePlayer()
  const track = useCurrentTrack()
  const [lyrics, setLyrics] = useState(false)
  const swipe = useRef<{ x: number; y: number } | null>(null)
  if (!track) return null
  const favorite = s.favorites.includes(track.id)
  return <section className="m-full-player" role="dialog" aria-modal="true" aria-label="正在播放">
    <div className="m-player-glow" style={track.cover ? { backgroundImage: `url("${track.cover}")` } : undefined} />
    <header className="m-player-head" onTouchStart={e => { swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY } }} onTouchEnd={e => { if (swipe.current && e.changedTouches[0].clientY - swipe.current.y > 65) close(); swipe.current = null }}>
      <button className="m-icon" aria-label="收起播放页" onClick={close}><IconArrowDown size={25} /></button><div><span>正在播放</span><strong>你的音乐，你的时刻</strong></div><button className="m-icon m-more" aria-label="歌曲选项" onClick={() => more(track)}>•••</button>
    </header>
    <div className="m-player-content">
      <div className="m-player-art" onTouchStart={e => { swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY } }} onTouchEnd={e => { const end = e.changedTouches[0]; if (swipe.current && Math.abs(end.clientX - swipe.current.x) > 70 && Math.abs(end.clientY - swipe.current.y) < 60) end.clientX < swipe.current.x ? s.next() : s.prev(); swipe.current = null }}>
        {lyrics ? <Lyrics track={track} /> : <Cover className="m-large-cover" src={track.cover} seed={track.artist + track.title} iconSize={74} />}
      </div>
      <div className="m-track-heading"><div><h1>{track.title}</h1><p>{track.artist}</p></div><button className={`m-icon ${favorite ? 'active' : ''}`} aria-label={favorite ? '取消喜欢' : '喜欢这首歌'} aria-pressed={favorite} onClick={() => s.toggleFavorite(track.id)}><IconHeart filled={favorite} size={25} /></button></div>
      <div className="m-player-progress"><Seek /><div><CurrentTime /><TotalTime track={track} /></div></div>
      <div className="m-player-controls"><button className={`m-icon ${s.settings.shuffle ? 'active' : ''}`} aria-label="随机播放" aria-pressed={s.settings.shuffle} onClick={s.toggleShuffle}><IconShuffle size={24} /></button><button className="m-icon" aria-label="上一首" onClick={s.prev}><IconPrev size={31} /></button><button className="m-play-main" aria-label={s.playing ? '暂停' : '播放'} onClick={s.togglePlay}>{s.playing ? <IconPause size={30} /> : <IconPlay size={30} />}</button><button className="m-icon" aria-label="下一首" onClick={() => s.next()}><IconNext size={31} /></button><button className={`m-icon ${s.settings.repeat !== 'off' ? 'active' : ''}`} aria-label={`循环模式：${s.settings.repeat === 'one' ? '单曲循环' : s.settings.repeat === 'all' ? '列表循环' : '顺序播放'}`} onClick={s.cycleRepeat}>{s.settings.repeat === 'one' ? <IconRepeatOne size={24} /> : <IconRepeat size={24} />}</button></div>
      <div className="m-player-tools"><button className={lyrics ? 'active' : ''} aria-pressed={lyrics} onClick={() => setLyrics(!lyrics)}><IconLyrics size={20} />歌词</button><span>{track.format} · 本地播放</span><button onClick={queue}><IconQueue size={20} />队列</button></div>
    </div>
  </section>
}

export default function MobileApp() {
  const s = usePlayer()
  const current = useCurrentTrack()
  const [tab, setTab] = useState<Tab>('home')
  const [downloadsOpen, setDownloadsOpen] = useState(false)
  const [panel, setPanel] = useState<Panel>(null)
  const [selected, setSelected] = useState<Track | null>(null)
  const [playlistId, setPlaylistId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('全部')
  const input = useRef<HTMLInputElement>(null)
  const scroll = useRef<HTMLElement>(null)
  useEffect(() => { initializeDownloads(); void s.init().then(() => { usePlayer.setState({ tracks: usePlayer.getState().tracks.map(restoreMobileTrack) }) }) }, [])
  useEffect(() => {
    const back = () => {
      if (downloadsOpen) { setDownloadsOpen(false); void downloadBridge.cancelRead().catch(() => {}) }
      else if (panel) setPanel(null)
      else if (s.nowPlayingOpen) s.toggleNowPlaying(false)
      else if (playlistId) setPlaylistId(null)
      else if (tab !== 'home') setTab('home')
      else if (isAndroid) void App.minimizeApp()
    }
    window.addEventListener('aurora-back', back)
    return () => window.removeEventListener('aurora-back', back)
  }, [panel, s.nowPlayingOpen, playlistId, tab, downloadsOpen])
  useEffect(() => { scroll.current?.scrollTo(0, 0) }, [tab, playlistId, category])
  const openImport = () => setPanel('import')
  const changeTab = (value: Tab) => { setTab(value); setPlaylistId(null); setSearch(''); setCategory('全部') }
  const trackMenu = (track: Track) => { setSelected(track); setPanel('track') }
  const albums = useMemo(() => {
    const groups = new Map<string, Track[]>()
    for (const track of s.tracks) { const key = track.album; groups.set(key, [...(groups.get(key) || []), track]) }
    return [...groups.entries()]
  }, [s.tracks])
  const playlist = s.playlists.find(p => p.id === playlistId)
  const tracks = useMemo(() => {
    let rows = playlist ? playlist.trackIds.map(id => s.tracks.find(t => t.id === id)).filter((t): t is Track => !!t) : tab === 'favorites' ? s.tracks.filter(t => s.favorites.includes(t.id)) : s.tracks
    if (category === '最近播放') rows = s.history.map(h => s.tracks.find(t => t.id === h.id)).filter((t): t is Track => !!t).filter((t, i, all) => all.findIndex(a => a.id === t.id) === i)
    const query = search.trim().toLowerCase()
    return query ? rows.filter(t => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(query)) : rows
  }, [s.tracks, s.favorites, s.history, tab, playlist, search, category])
  const trackIds = useMemo(() => tracks.map(t => t.id), [tracks])
  const allIds = useMemo(() => s.tracks.map(t => t.id), [s.tracks])
  const Empty = ({ text = '把喜欢的声音，留在这里', detail = '导入手机上的音乐，随时开始聆听。', action = true }: { text?: string; detail?: string; action?: boolean }) => <div className="m-empty"><div><IconMusic size={39} /></div><h3>{text}</h3><p>{detail}</p>{action && <button className="m-primary" onClick={openImport}><IconPlus size={19} />导入音乐</button>}</div>
  const title = playlist?.name || ({ home: '聆听', library: '音乐库', favorites: '我喜欢', playlists: '我的歌单' })[tab]
  return <div className={`mobile-app ${s.settings.reducedMotion ? 'reduced-motion' : ''}`} style={{ '--accent': s.settings.accent } as React.CSSProperties}>
    <main ref={scroll} className="m-main">
      <header className="m-header"><div>{playlistId && <button className="m-icon" aria-label="返回歌单" onClick={() => setPlaylistId(null)}><IconArrowDown style={{ transform: 'rotate(90deg)' }} size={22} /></button>}<span className="m-brand"><IconSpark size={22} /></span><strong>AURORA<span>MUSIC</span></strong></div><div><button className="m-icon m-settings" aria-label="打开歌单下载" onClick={() => setDownloadsOpen(true)}><IconArrowDown size={23} /></button><button className="m-icon m-settings" aria-label="打开设置" onClick={() => setPanel('settings')}><IconSettings size={23} /></button></div></header>
      {tab === 'home' && !playlist ? <>
        <div className="m-greeting"><span>属于你的声音空间</span><h1>把日常，听成喜欢。</h1></div>
        <section className="m-hero"><div className="m-hero-copy"><span className="m-eyebrow"><i /> 此刻，随心听</span><h2>{current ? current.title : '让这一刻\n有自己的旋律。'}</h2><p>{current ? current.artist : '离线收藏 · 沉浸聆听'}</p><button className="m-pill" onClick={() => s.tracks.length ? s.playQueue(s.tracks.map(t => t.id), 0, true) : openImport()}><IconPlay size={17} />{s.tracks.length ? '随心播放' : '开始收藏'}</button></div><div className="m-hero-art">{s.tracks.length ? <Cover className="m-hero-cover" src={(current || s.tracks[0]).cover} seed={(current || s.tracks[0]).title} iconSize={42} /> : <div className="m-vinyl"><div><IconSpark size={30} /></div></div>}</div></section>
        <div className="m-shortcuts"><button onClick={() => changeTab('favorites')}><span className="m-shortcut-icon"><IconHeart size={22} filled /></span><span><strong>我喜欢</strong><small>{s.favorites.length} 首心动</small></span><span>↗</span></button><button onClick={() => { changeTab('library'); setCategory('最近播放') }}><span className="m-shortcut-icon rose"><IconClock size={22} /></span><span><strong>最近播放</strong><small>重温好旋律</small></span><span>↗</span></button></div>
        <button className="m-online-entry" onClick={() => setDownloadsOpen(true)}><IconArrowDown size={23} /><span><strong>歌单下载</strong><small>网易云 / QQ 音乐 · 自动加入曲库</small></span><span>↗</span></button>
        <div className="m-section-title"><h2>收藏的声音</h2><button onClick={() => changeTab('library')}>全部音乐 <span>→</span></button></div>
        {s.tracks.length ? <div className="m-album-rail">{albums.slice(0, 10).map(([album, rows]) => <button key={album} onClick={() => { changeTab('library'); setSearch(album) }}><Cover className="m-album-cover" src={rows[0].cover} seed={rows[0].artist + album} iconSize={35} /><strong>{album}</strong><small>{rows[0].artist} · {rows.length} 首</small></button>)}</div> : <div className="m-import-card"><div><IconFolder size={26} /></div><span><strong>从你的音乐开始</strong><small>选择文件夹，封面和歌词一起带上。</small></span><button className="m-icon" aria-label="添加本地音乐" onClick={openImport}><IconPlus size={22} /></button></div>}
        <div className="m-section-title"><h2>最近加入</h2><span className="m-muted">{s.tracks.length} 首本地音乐</span></div>
        {s.tracks.length ? s.tracks.slice(0, 6).map(track => <TrackRow menu={trackMenu} key={track.id} track={track} ids={allIds} />) : <div className="m-home-empty"><span>音乐属于你，时刻也属于你。</span><p>无需登录，离线也能好好听。</p></div>}
      </> : <>
        <div className="m-page-title"><div><span className="m-eyebrow">YOUR PERSONAL COLLECTION</span><h1>{title}</h1><p>{playlist ? `${tracks.length} 首 · 为自己收藏` : `${tab === 'playlists' ? s.playlists.length + ' 张歌单' : tracks.length + ' 首音乐'} · 随时随地聆听`}</p></div><button className="m-circle-add" aria-label={tab === 'playlists' ? '创建歌单' : '导入音乐'} onClick={() => { setName(''); setSelected(null); setPanel(tab === 'playlists' ? 'newPlaylist' : 'import') }}><IconPlus size={25} /></button></div>
        {tab === 'playlists' && !playlist ? <div className="m-playlist-grid">{s.playlists.map(p => { const first = s.tracks.find(t => p.trackIds.includes(t.id)); return <button key={p.id} onClick={() => setPlaylistId(p.id)}><Cover src={first?.cover} className="m-playlist-cover" seed={p.name} iconSize={38} /><strong>{p.name}</strong><small>{p.trackIds.filter(id => s.tracks.some(t => t.id === id)).length} 首音乐</small></button> })}{!s.playlists.length && <Empty text="给每种心情，一张歌单" detail="点击右上角的加号，创建你的第一张歌单。" action={false} />}</div> : <>
          <label className="m-search"><IconSearch size={20} /><input aria-label="搜索本地音乐" placeholder="搜索歌曲、歌手、专辑" value={search} onChange={e => setSearch(e.target.value)} />{search && <button aria-label="清空搜索" onClick={() => setSearch('')}><IconClose size={17} /></button>}</label>
          {!playlist && tab === 'library' && <div className="m-chips">{['全部', '最近播放', '专辑'].map(c => <button className={category === c ? 'active' : ''} key={c} onClick={() => setCategory(c)}>{c}</button>)}</div>}
          {tracks.length > 0 && category !== '专辑' && <div className="m-list-toolbar"><button onClick={() => s.playQueue(tracks.map(t => t.id), 0, false)}><span><IconPlay size={14} /></span>播放全部 <small>({tracks.length})</small></button><button className="m-icon" aria-label="随机播放全部" onClick={() => s.playQueue(tracks.map(t => t.id), 0, true)}><IconShuffle size={20} /></button></div>}
          {category === '专辑' ? <div className="m-playlist-grid">{albums.filter(([album]) => !search || album.toLowerCase().includes(search.toLowerCase())).map(([album, rows]) => <button key={album} onClick={() => { setCategory('全部'); setSearch(album) }}><Cover className="m-playlist-cover" src={rows[0].cover} seed={album} iconSize={35} /><strong>{album}</strong><small>{rows.length} 首 · {rows[0].artist}</small></button>)}</div> : tracks.map(track => <TrackRow menu={trackMenu} key={track.id} track={track} ids={trackIds} />)}
          {!tracks.length && <Empty text={search ? '没有找到这段旋律' : tab === 'favorites' ? '喜欢的歌，值得反复听' : playlist ? '这张歌单等你填满' : undefined} detail={search ? '试试其他歌名或歌手。' : tab === 'favorites' ? '在歌曲选项或播放页点亮爱心。' : playlist ? '在歌曲选项中，选择「加入歌单」。' : undefined} action={!search && tab === 'library' && !playlist} />}
          {playlist && <button className="m-text-danger" onClick={() => { s.deletePlaylist(playlist.id); setPlaylistId(null); s.pushToast('已删除歌单，音乐仍在曲库中') }}>删除这张歌单</button>}
        </>}
      </>}
      <div className="m-endmark">AURORA · 让音乐陪你慢下来</div>
    </main>
    <footer className="m-bottom"><div className="m-mini">{current ? <><button className="m-mini-track" aria-label="展开播放页" onClick={() => s.toggleNowPlaying(true)}><Cover className="m-mini-cover" src={current.cover} seed={current.artist + current.title} iconSize={19} /><span><strong>{current.title}</strong><small>{current.artist}</small></span></button><button className="m-icon" aria-label={s.playing ? '暂停' : '播放'} onClick={s.togglePlay}>{s.playing ? <IconPause size={22} /> : <IconPlay size={23} />}</button><button className="m-icon" aria-label="下一首" onClick={() => s.next()}><IconNext size={22} /></button><Seek small /></> : <button className="m-mini-idle" onClick={openImport}><IconDisc size={25} /><span>你的下一首好歌，从这里开始</span><IconPlus size={20} /></button>}</div><nav className="m-nav" aria-label="主导航">{([{ id: 'home', title: '聆听', icon: IconSpark }, { id: 'library', title: '音乐库', icon: IconLibrary }, { id: 'favorites', title: '喜欢', icon: IconHeart }, { id: 'playlists', title: '歌单', icon: IconQueue }] as const).map(item => <button key={item.id} className={tab === item.id ? 'active' : ''} aria-current={tab === item.id ? 'page' : undefined} onClick={() => changeTab(item.id)}><span><item.icon size={23} /></span><small>{item.title}</small></button>)}</nav></footer>
    {s.nowPlayingOpen && <FullPlayer close={() => s.toggleNowPlaying(false)} queue={() => setPanel('queue')} more={trackMenu} />}
    {panel && <Sheet title={({ import: '把音乐带进来', settings: '设置', queue: `播放队列 · ${s.queue.length}`, newPlaylist: '创建歌单', addPlaylist: '加入歌单', track: '歌曲选项' })[panel]} close={() => setPanel(null)}>
      {panel === 'import' && <><p className="m-sheet-description">选择手机上的音乐文件夹，自动读取内嵌封面和同名歌词。导入后可离线播放，重启应用也会保留。</p><button className="m-option" onClick={() => { setPanel(null); isAndroid ? void importAndroid(true) : input.current?.click() }}><IconFolder size={24} /><span><strong>导入整个文件夹</strong><small>歌曲、封面和 LRC 歌词一起导入</small></span><span>→</span></button><button className="m-option" onClick={() => { setPanel(null); isAndroid ? void importAndroid(false) : input.current?.click() }}><IconMusic size={24} /><span><strong>选择音乐文件</strong><small>可以一次选择多首歌曲</small></span><span>→</span></button><p className="m-footnote">歌曲保存在应用内，卸载应用会一并移除。原始文件不会改动。</p></>}
      {panel === 'settings' && <><div className="m-about"><span className="m-brand"><IconSpark size={32} /></span><h3>Aurora Music</h3><p>Android · 1.1.0</p></div><label className="m-setting-volume">播放音量 <strong>{Math.round(s.settings.volume * 100)}%</strong><input aria-label="播放音量" type="range" min="0" max="100" value={Math.round(s.settings.volume * 100)} onChange={e => s.setVolume(Number(e.target.value) / 100)} /></label><div className="m-setting-line"><span>主题色</span><div className="m-colors">{['#a291ff', '#84cbbb', '#e8a5b6', '#d6b984'].map(color => <button key={color} style={{ background: color }} aria-label={`主题色 ${color}`} aria-pressed={s.settings.accent === color} onClick={() => s.updateSettings({ accent: color })}>{s.settings.accent === color ? '✓' : ''}</button>)}</div></div><label className="m-setting-line"><span>减少动态效果<small>使用更轻柔的界面过渡</small></span><input type="checkbox" role="switch" checked={s.settings.reducedMotion} onChange={e => s.updateSettings({ reducedMotion: e.target.checked })} /></label><button className="m-option" onClick={openImport}><IconPlus size={22} /><span>导入本地音乐</span><span>→</span></button><p className="m-footnote">本地音乐、喜欢、歌单和设置保存在这台手机上。系统通知和耳机按键可以控制播放。歌单下载支持网易云和 QQ 音乐；DeepSeek 尚未移植到安卓。</p><a className="m-source" href="https://github.com/bakrilivas-boop/aurora-music" target="_blank" rel="noreferrer">开源项目与第三方说明 ↗</a></>}
      {panel === 'queue' && <>{s.queue.map(id => s.tracks.find(t => t.id === id)).filter((t): t is Track => !!t).map(track => <TrackRow menu={trackMenu} key={track.id} track={track} ids={s.queue} remove={() => s.removeFromQueue(track.id)} />)}{!s.queue.length && <Empty text="队列还空着" detail="点一首喜欢的歌，开始播放。" action={false} />}</>}
      {panel === 'newPlaylist' && <form onSubmit={e => { e.preventDefault(); if (!name.trim()) return; const id = s.createPlaylist(name.trim()); if (selected) s.addToPlaylist(id, selected.id); setSelected(null); setPanel(null); changeTab('playlists'); setPlaylistId(id) }}><label className="m-form-label">歌单名称<input autoFocus aria-label="歌单名称" maxLength={60} placeholder="例如：今晚的晚风" value={name} onChange={e => setName(e.target.value)} /></label><button className="m-primary m-wide" disabled={!name.trim()} type="submit">创建歌单</button></form>}
      {panel === 'addPlaylist' && <>{s.playlists.map(p => <button key={p.id} className="m-option" onClick={() => { if (selected) s.addToPlaylist(p.id, selected.id); s.pushToast(`已加入「${p.name}」`, 'success'); setPanel(null) }}><IconQueue size={22} /><span>{p.name}</span><span><IconPlus size={18} /></span></button>)}<button className="m-option" onClick={() => { setName(''); setPanel('newPlaylist') }}><IconPlus size={22} /><span>新建歌单</span></button></>}
      {panel === 'track' && selected && <><div className="m-selected-track"><Cover className="m-row-cover" src={selected.cover} seed={selected.title} iconSize={22} /><div><strong>{selected.title}</strong><small>{selected.artist} · {selected.album}</small></div></div><button className="m-option" onClick={() => { s.toggleFavorite(selected.id); setPanel(null) }}><IconHeart size={22} filled={s.favorites.includes(selected.id)} /><span>{s.favorites.includes(selected.id) ? '取消喜欢' : '加入我喜欢'}</span></button><button className="m-option" onClick={() => setPanel('addPlaylist')}><IconPlus size={22} /><span>加入歌单</span></button><button className="m-option" onClick={() => { s.addToQueue(selected.id); setPanel(null) }}><IconQueue size={22} /><span>加入播放队列</span></button>{playlist && <button className="m-option" onClick={() => { s.removeFromPlaylist(playlist.id, selected.id); setPanel(null) }}><IconTrash size={22} /><span>从这张歌单移除</span></button>}<p className="m-footnote">{selected.format} · {fmtTime(selected.duration)} · {(selected.size / 1024 / 1024).toFixed(1)} MB</p></>}
    </Sheet>}
    {downloadsOpen && <MobileDownloads close={() => { setDownloadsOpen(false); void downloadBridge.cancelRead().catch(() => {}) }} library={() => { setDownloadsOpen(false); changeTab('library') }} />}
    {s.scanning && <div className="m-import-progress" role="status"><span className="m-spinner" /><div><strong>{s.scanProgress?.phase === 'parse' ? '正在读取封面与歌词' : '正在导入音乐'}</strong><small>{s.scanProgress?.total ? `${s.scanProgress.done} / ${s.scanProgress.total}` : '从所选位置保存歌曲，请稍候…'}</small></div></div>}
    <div className="m-toasts" aria-live="polite">{s.toasts.map(toast => <div role="status" key={toast.id} className={toast.kind}>{toast.text}</div>)}</div>
    <input ref={input} hidden type="file" multiple accept="audio/*,.lrc,.txt,image/*" onChange={e => { if (e.currentTarget.files?.length) void s.importFromInput(e.currentTarget) }} />
  </div>
}
