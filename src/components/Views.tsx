import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { usePlayer, type SortKey } from '../lib/store'
import { trackSource, type Track } from '../lib/types'
import { TrackList } from './TrackList'
import { Cover, coverStyle } from './common'
import { IconClock, IconDisc, IconEq, IconFolder, IconHeart, IconLibrary, IconMic, IconMusic, IconPause, IconPlay, IconShuffle, IconSpark } from './Icons'

const collator = new Intl.Collator('zh-Hans-CN', { sensitivity: 'base', numeric: true })

function filterBySearch(list: Track[], search: string): Track[] {
  const q = search.trim().toLowerCase()
  if (!q) return list
  return list.filter(
    (t) =>
      t.title.toLowerCase().includes(q) ||
      t.artist.toLowerCase().includes(q) ||
      t.album.toLowerCase().includes(q) ||
      t.filename.toLowerCase().includes(q),
  )
}

function sortTracks(list: Track[], key: SortKey, asc: boolean): Track[] {
  if (key === 'playlist') return asc ? list.slice() : list.slice().reverse()
  const arr = list.slice()
  const cmp = collator.compare
  arr.sort((a, b) => {
    let r = 0
    switch (key) {
      case 'title':
        r = cmp(a.title, b.title)
        break
      case 'artist':
        r = cmp(a.artist, b.artist) || cmp(a.album, b.album)
        break
      case 'album':
        r = cmp(a.album, b.album) || (a.trackNo ?? 0) - (b.trackNo ?? 0)
        break
      case 'duration':
        r = a.duration - b.duration
        break
      default:
        r = a.addedAt - b.addedAt
    }
    return asc ? r : -r
  })
  return arr
}

function EmptyState({
  icon,
  title,
  desc,
  action,
}: {
  icon: React.ReactNode
  title: string
  desc: string
  action?: React.ReactNode
}) {
  return (
    <div className="empty-state">
      <div className="es-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{desc}</p>
      {action}
    </div>
  )
}

function PageHead({
  kicker,
  title,
  sub,
  cover,
  children,
}: {
  kicker: string
  title: string
  sub: React.ReactNode
  cover?: string
  children?: React.ReactNode
}) {
  return (
    <div className="page-head">
      <div className="ph-cover" style={coverStyle(cover, title)}>
        {!cover && <IconDisc size={34} />}
      </div>
      <div className="ph-meta">
        <div className="kicker">{kicker}</div>
        <h1>{title}</h1>
        <div className="page-sub">{sub}</div>
        {children}
      </div>
    </div>
  )
}

export function Views() {
  const view = usePlayer((s) => s.view)
  const tracks = usePlayer((s) => s.tracks)
  const search = usePlayer((s) => s.search)
  const deferredSearch = useDeferredValue(search)
  const sortKey = usePlayer((s) => s.sortKey)
  const sortAsc = usePlayer((s) => s.sortAsc)
  const favorites = usePlayer((s) => s.favorites)
  const history = usePlayer((s) => s.history)
  const playlists = usePlayer((s) => s.playlists)
  const activePlaylistId = usePlayer((s) => s.activePlaylistId)
  const playQueue = usePlayer((s) => s.playQueue)
  const importFolder = usePlayer((s) => s.importFolder)
  const scanning = usePlayer((s) => s.scanning)
  const scanProgress = usePlayer((s) => s.scanProgress)
  const needsPermission = usePlayer((s) => s.needsPermission)
  const grantPermission = usePlayer((s) => s.grantPermission)
  const removeFromPlaylist = usePlayer((s) => s.removeFromPlaylist)
  const settings = usePlayer((s) => s.settings)
  const setView = usePlayer((s) => s.setView)
  const currentId = usePlayer((s) => s.currentId)
  const playing = usePlayer((s) => s.playing)
  const togglePlay = usePlayer((s) => s.togglePlay)

  const [drill, setDrill] = useState<{ type: 'album' | 'artist'; value: string } | null>(null)

  useEffect(() => setDrill(null), [view])

  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks])

  const currentList = useMemo(() => {
    let base: Track[] = []
    switch (view) {
      case 'library':
        base = tracks
        break
      case 'favorites':
        base = favorites.map((id) => byId.get(id)).filter((t): t is Track => !!t).reverse()
        break
      case 'recent':
        base = history.map((h) => byId.get(h.id)).filter((t): t is Track => !!t)
        break
      case 'playlist': {
        const pl = playlists.find((p) => p.id === activePlaylistId)
        base = pl ? pl.trackIds.map((id) => byId.get(id)).filter((t): t is Track => !!t) : []
        break
      }
      default:
        base = tracks
    }
    return base
  }, [view, tracks, favorites, history, playlists, activePlaylistId, byId])

  const searchTracks = useMemo(() => filterBySearch(tracks, deferredSearch), [tracks, deferredSearch])
  const filtered = useMemo(() => currentList === tracks ? searchTracks : filterBySearch(currentList, deferredSearch), [currentList, tracks, searchTracks, deferredSearch])
  const matchingIds = useMemo(() => new Set(searchTracks.map((t) => t.id)), [searchTracks])

  const albums = useMemo(() => {
    const map = new Map<string, { key: string; name: string; artist: string; tracks: Track[]; cover?: string }>()
    for (const t of tracks) {
      const key = `${t.album}__${t.artist === '未知艺术家' ? '' : t.artist}`
      let entry = map.get(key)
      if (!entry) {
        entry = { key, name: t.album, artist: t.artist, tracks: [], cover: t.cover }
        map.set(key, entry)
      }
      entry.tracks.push(t)
      if (!entry.cover && t.cover) entry.cover = t.cover
    }
    return Array.from(map.values())
      .map((a) => ({ ...a, tracks: a.tracks.slice().sort((x, y) => (x.trackNo ?? 0) - (y.trackNo ?? 0)) }))
      .sort((a, b) => b.tracks.length - a.tracks.length)
  }, [tracks])

  const artists = useMemo(() => {
    const map = new Map<string, { name: string; tracks: Track[]; cover?: string }>()
    for (const t of tracks) {
      let entry = map.get(t.artist)
      if (!entry) {
        entry = { name: t.artist, tracks: [], cover: t.cover }
        map.set(t.artist, entry)
      }
      entry.tracks.push(t)
      if (!entry.cover && t.cover) entry.cover = t.cover
    }
    return Array.from(map.values()).sort((a, b) => b.tracks.length - a.tracks.length)
  }, [tracks])

  const sorted = useMemo(() => sortTracks(filtered, sortKey, sortAsc), [filtered, sortKey, sortAsc])
  const visibleAlbums = useMemo(() => albums.filter((a) => a.tracks.some((t) => matchingIds.has(t.id))), [albums, matchingIds])
  const visibleArtists = useMemo(() => artists.filter((a) => a.tracks.some((t) => matchingIds.has(t.id))), [artists, matchingIds])
  const recentAdded = useMemo(() => tracks.slice().sort((a, b) => b.addedAt - a.addedAt), [tracks])
  const recentPlayed = useMemo(() => history.map((h) => byId.get(h.id)).filter((t): t is Track => !!t), [history, byId])

  const playAll = (list: Track[], shuffle = false) => {
    const playable = list.filter((t) => trackSource(t))
    if (!playable.length) return
    playQueue(playable.map((t) => t.id), 0, shuffle)
  }

  const statusBanner = (
    <>
      {needsPermission && (
        <div className="permission-bar" role="status">
          需要恢复上次音乐文件夹的访问权限，之后即可继续播放。
          <button className="btn" onClick={() => void grantPermission()}>
            恢复访问
          </button>
        </div>
      )}
      {scanning && (
        <div className="scan-banner" role="status">
          <div className="spinner" />
          {scanProgress?.phase === 'walk'
            ? '正在遍历文件夹…'
            : `正在解析标签 ${scanProgress?.done ?? 0} / ${scanProgress?.total ?? 0}`}
        </div>
      )}
    </>
  )

  if (view === 'home') {
    const focus = byId.get(currentId ?? '') ?? recentPlayed[0] ?? recentAdded[0]
    const listening = [...new Map<string, Track>([...recentPlayed, ...recentAdded].map((track) => [track.id, track])).values()]
    const listeningIds = listening.filter((t) => trackSource(t)).map((t) => t.id)
    const libraryDuration = tracks.reduce((sum, t) => sum + t.duration, 0)
    return (
      <div className="home-view" aria-busy={search !== deferredSearch}>
        <div className="home-heading">
          <div><div className="kicker">AURORA / YOUR PERSONAL SOUNDSPACE</div><h1>{tracks.length ? '此刻，让音乐接管。' : '为喜欢的声音，留点时间。'}</h1><p>{tracks.length ? `${tracks.length} 首音乐，和只属于你的聆听时光。` : '你的音乐，你的节奏。'}</p></div>
          <span className="local-badge"><span /> 本地 · 私享</span>
        </div>
        {statusBanner}
        {deferredSearch.trim() ? (
          <section className="home-section"><div className="section-heading"><h2>搜索结果</h2><span>{filtered.length} 首曲目</span></div><TrackList tracks={sorted} /></section>
        ) : (
          <>
            <div className="home-hero-grid">
              <section className={`home-hero${focus ? ' has-track' : ''}`}>
                <div className="home-hero-copy">
                  <div className="hero-eyebrow"><span className="status-dot" /> {focus ? '为你保留的旋律 · CONTINUE LISTENING' : '每一次聆听，都值得认真对待'}</div>
                  <h2>{focus ? focus.title : <>把喜欢的音乐，<br />留在身边。</>}</h2>
                  <p>{focus ? `${focus.artist} · ${focus.album}` : '导入本地文件夹，封面、专辑与歌词自动归位。打开就能沉浸在你的音乐里。'}</p>
                  <div className="hero-actions">
                    {focus ? (
                      <button className="btn primary" disabled={!trackSource(focus)} onClick={() => focus.id === currentId ? togglePlay() : playAll([focus, ...listening.filter((t) => t.id !== focus.id)])}>
                        {playing && focus.id === currentId ? <IconPause size={15} /> : <IconPlay size={15} />}{playing && focus.id === currentId ? '暂停播放' : '继续聆听'}
                      </button>
                    ) : (
                      <button className="btn primary" onClick={() => void importFolder()} disabled={scanning}><IconFolder size={15} /> 导入音乐文件夹</button>
                    )}
                    {tracks.length > 0 && <button className="btn ghost" onClick={() => setView('library')}>浏览音乐库 <span aria-hidden="true">↗</span></button>}
                  </div>
                  <div className="hero-caption">{focus ? `${focus.format.toUpperCase()} · ${focus.hasLrc || focus.embeddedLyrics ? '歌词已就绪' : '本地音频'}` : 'MP3 / FLAC / M4A / WAV / OGG'}</div>
                </div>
                <div className="hero-art" aria-hidden="true">
                  <div className="hero-vinyl"><span /></div>
                  <div className="hero-sleeve" style={coverStyle(focus?.cover, (focus?.artist || "") + (focus?.title || "Aurora"))}>{!focus?.cover && <IconMusic size={50} />}<span>AURORA / PERSONAL COLLECTION</span></div>
                </div>
              </section>
              <section className="library-overview" aria-label="音乐库概览">
                <div className="overview-heading"><span>你的音乐收藏</span><IconLibrary size={17} /></div>
                <div className="overview-stats"><button onClick={() => setView('library')}><strong>{tracks.length}</strong><span>首歌曲</span></button><button onClick={() => setView('albums')}><strong>{albums.length}</strong><span>张专辑</span></button><button onClick={() => setView('artists')}><strong>{artists.length}</strong><span>位艺术家</span></button><button onClick={() => setView('favorites')}><strong>{favorites.filter((id) => byId.has(id)).length}</strong><span>首收藏</span></button></div>
                <div className="overview-foot"><span className="status-dot" />{libraryDuration > 0 ? `${Math.round(libraryDuration / 60)} 分钟的好时光` : '音乐数据仅保存在本机'}</div>
              </section>
            </div>

            {tracks.length > 0 ? (
              <section className="home-section">
                <div className="section-heading"><div><h2>{recentPlayed.length ? '继续聆听' : '最近加入'}</h2><p>{recentPlayed.length ? '熟悉的旋律，随时接着听。' : '属于你的声音，已经准备好。'}</p></div><button className="text-link" onClick={() => setView(recentPlayed.length ? 'recent' : 'library')}>查看全部 <span aria-hidden="true">→</span></button></div>
                <div className="home-track-grid">{listening.slice(0, 5).map((t) => (
                  <button key={t.id} className={`home-track${currentId === t.id ? ' active' : ''}`} disabled={!trackSource(t)} onClick={() => currentId === t.id ? togglePlay() : playQueue(listeningIds, listeningIds.indexOf(t.id), false)} title={trackSource(t) ? `播放 ${t.title}` : '请先恢复文件夹访问'}>
                    <Cover src={t.cover} seed={t.artist + t.title} className="home-track-cover" iconSize={32}><span className="home-track-play">{currentId === t.id && playing ? <IconPause size={18} /> : <IconPlay size={18} />}</span></Cover><span className="home-track-title">{t.title}</span><span className="home-track-artist">{t.artist}</span>
                  </button>
                ))}</div>
              </section>
            ) : (
              <section className="home-section">
                <div className="section-heading"><div><h2>三步，开始你的音乐旅程</h2><p>无需账号，所有音乐都在你手里。</p></div></div>
                <div className="onboarding-grid">{[
                  { icon: <IconFolder size={19} />, title: '导入你的音乐', desc: '选择本地文件夹，自动识别标签与封面。' },
                  { icon: <IconHeart size={19} />, title: '收好每一份喜欢', desc: '收藏歌曲，创建专属于你的播放歌单。' },
                  { icon: <IconEq size={19} />, title: '找到舒服的声音', desc: '同步歌词与十段均衡器，让聆听更自在。' },
                ].map((step, i) => <div className="onboarding-card" key={step.title}><div className="onboarding-icon">{step.icon}<span>0{i + 1}</span></div><h3>{step.title}</h3><p>{step.desc}</p></div>)}</div>
              </section>
            )}
            <section className="home-scene"><div><span className="scene-icon"><IconSpark size={20} /></span><h2>让音乐，懂你的此刻。</h2><p>说说心情，让 AI 从你的曲库里挑选。</p></div><div className="scene-actions">{['专注工作', '深夜放松', '通勤路上'].map((scene) => <button key={scene} className="chip" onClick={() => window.dispatchEvent(new CustomEvent('aurora:ai-open', { detail: { query: `从我的本地曲库中，推荐适合${scene}的歌曲并创建歌单。` } }))}>{scene}<span aria-hidden="true">↗</span></button>)}</div></section>
            <div className="home-shortcuts"><button onClick={() => setView('favorites')}><IconHeart size={19} /><span><strong>我的收藏</strong><small>把心动留在这里</small></span><span aria-hidden="true">↗</span></button><button onClick={() => setView('albums')}><IconDisc size={19} /><span><strong>专辑时光</strong><small>完整听完一张好专辑</small></span><span aria-hidden="true">↗</span></button><button onClick={() => setView('recent')}><IconClock size={19} /><span><strong>最近播放</strong><small>重逢刚刚听过的旋律</small></span><span aria-hidden="true">↗</span></button></div>
          </>
        )}
      </div>
    )
  }

  /* ------------------ 专辑 / 艺术家（含钻取详情） ------------------ */

  if (view === 'albums') {
    if (drill?.type === 'album') {
      const album = albums.find((a) => a.key === drill.value)
      if (album) {
        const albumTracks = sortTracks(filterBySearch(album.tracks, deferredSearch), sortKey, sortAsc)
        return (
          <>
            <div className="toolbar">
              <button className="chip" onClick={() => setDrill(null)}>
                ← 返回专辑
              </button>
            </div>
            <PageHead
              kicker="专辑"
              title={album.name}
              sub={
                <>
                  <span>{album.artist}</span>
                  <span className="sep">·</span>
                  <span>{album.tracks.length} 首</span>
                </>
              }
              cover={album.cover}
            >
              <div className="toolbar" style={{ paddingTop: 14 }}>
                <button className="btn primary" onClick={() => playAll(albumTracks)} disabled={!albumTracks.length}>
                  <IconPlay size={14} /> 播放全部
                </button>
                <button className="btn" onClick={() => playAll(albumTracks, true)} disabled={!albumTracks.length}>
                  <IconShuffle size={14} /> 随机
                </button>
              </div>
            </PageHead>
            <TrackList tracks={albumTracks} />
          </>
        )
      }
    }
    return (
      <>
        <PageHead
          kicker="音乐库"
          title="专辑"
          sub={
            <>
              <span>{visibleAlbums.length} 张专辑</span>
              <span className="sep">·</span>
              <span>{tracks.length} 首曲目</span>
            </>
          }
        />
        {statusBanner}
        {!albums.length ? (
          <EmptyState
            icon={<IconDisc size={34} />}
            title="还没有专辑"
            desc="导入本地音乐文件夹后，会自动按标签里的专辑信息归类。"
            action={
              <button className="btn primary" onClick={() => void importFolder()}>
                <IconFolder size={15} /> 导入音乐文件夹
              </button>
            }
          />
        ) : (
          <div className="card-grid">
            {visibleAlbums.map((a) => (
              <div
                key={a.key}
                className="album-card"
                role="button"
                tabIndex={0}
                onClick={() => setDrill({ type: 'album', value: a.key })}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
                  e.preventDefault()
                  setDrill({ type: 'album', value: a.key })
                }}
              >
                <div className="ac-cover" style={coverStyle(a.cover, a.name)}>
                  {!a.cover && <IconDisc size={28} />}
                  <button
                    className="ac-play"
                    title="播放专辑"
                    onClick={(e) => {
                      e.stopPropagation()
                      playAll(a.tracks)
                    }}
                  >
                    <IconPlay size={16} />
                  </button>
                </div>
                <span className="ac-title" title={a.name}>
                  {a.name}
                </span>
                <span className="ac-sub">
                  {a.artist} · {a.tracks.length} 首
                </span>
              </div>
            ))}
          </div>
        )}
        {albums.length > 0 && !visibleAlbums.length && <EmptyState icon={<IconDisc size={30} />} title="没有匹配的专辑" desc="试试其他专辑名、艺术家或歌曲名。" />}
      </>
    )
  }

  if (view === 'artists') {
    if (drill?.type === 'artist') {
      const artist = artists.find((a) => a.name === drill.value)
      if (artist) {
        const artistTracks = sortTracks(filterBySearch(artist.tracks, deferredSearch), sortKey, sortAsc)
        return (
          <>
            <div className="toolbar">
              <button className="chip" onClick={() => setDrill(null)}>
                ← 返回艺术家
              </button>
            </div>
            <PageHead
              kicker="艺术家"
              title={artist.name}
              sub={
                <>
                  <span>{artist.tracks.length} 首曲目</span>
                  <span className="sep">·</span>
                  <span>{new Set(artist.tracks.map((t) => t.album)).size} 张专辑</span>
                </>
              }
              cover={artist.cover}
            >
              <div className="toolbar" style={{ paddingTop: 14 }}>
                <button className="btn primary" onClick={() => playAll(artistTracks)} disabled={!artistTracks.length}>
                  <IconPlay size={14} /> 播放全部
                </button>
                <button className="btn" onClick={() => playAll(artistTracks, true)} disabled={!artistTracks.length}>
                  <IconShuffle size={14} /> 随机
                </button>
              </div>
            </PageHead>
            <TrackList tracks={artistTracks} />
          </>
        )
      }
    }
    return (
      <>
        <PageHead
          kicker="音乐库"
          title="艺术家"
          sub={
            <>
              <span>{visibleArtists.length} 位艺术家</span>
            </>
          }
        />
        {statusBanner}
        {!artists.length ? (
          <EmptyState
            icon={<IconMic size={34} />}
            title="还没有艺术家"
            desc="导入音乐后，会按音频标签中的艺术家字段自动分组。"
            action={
              <button className="btn primary" onClick={() => void importFolder()}>
                <IconFolder size={15} /> 导入音乐文件夹
              </button>
            }
          />
        ) : (
          <div className="card-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
            {visibleArtists.map((a) => (
              <div
                key={a.name}
                className="artist-card"
                role="button"
                tabIndex={0}
                onClick={() => setDrill({ type: 'artist', value: a.name })}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  setDrill({ type: 'artist', value: a.name })
                }}
              >
                <div className="ar-cover" style={coverStyle(a.cover, a.name)}>
                  {!a.cover && <IconMic size={26} />}
                </div>
                <span className="ac-title" title={a.name} style={{ maxWidth: '100%' }}>
                  {a.name}
                </span>
                <span className="ac-sub">{a.tracks.length} 首</span>
              </div>
            ))}
          </div>
        )}
        {artists.length > 0 && !visibleArtists.length && <EmptyState icon={<IconMic size={30} />} title="没有匹配的艺术家" desc="试试其他艺术家、专辑或歌曲名。" />}
      </>
    )
  }

  if (view === 'playlist') {
    const pl = playlists.find((p) => p.id === activePlaylistId)
    if (!pl) {
      return (
        <EmptyState
          icon={<IconMusic size={34} />}
          title="歌单不存在"
          desc="这个歌单可能已经被删除。"
          action={
            <button className="btn" onClick={() => setView('library')}>
              返回歌曲库
            </button>
          }
        />
      )
    }
    const list = sorted
    return (
      <>
        <PageHead
          kicker="歌单"
          title={pl.name}
          sub={
            <>
              <span>{pl.trackIds.length} 首</span>
              <span className="sep">·</span>
              <span>创建于 {new Date(pl.createdAt).toLocaleDateString('zh-CN')}</span>
            </>
          }
          cover={currentList[0]?.cover}
        >
          <div className="toolbar" style={{ paddingTop: 14 }}>
            <button className="btn primary" onClick={() => playAll(list)} disabled={!list.length}>
              <IconPlay size={14} /> 播放全部
            </button>
            <button className="btn" onClick={() => playAll(list, true)} disabled={!list.length}>
              <IconShuffle size={14} /> 随机播放
            </button>
          </div>
        </PageHead>
        {!pl.trackIds.length ? (
          <EmptyState
            icon={<IconMusic size={34} />}
            title="歌单还是空的"
            desc="在任意曲目上点击右键（或「⋯」按钮），选择「添加到歌单」即可。"
          />
        ) : (
          <TrackList tracks={list} onRemove={(id) => removeFromPlaylist(pl.id, id)} />
        )}
      </>
    )
  }

  /* ------------------ 列表类视图 ------------------ */

  const meta = {
    library: {
      kicker: '音乐库',
      title: '全部歌曲',
      icon: <IconMusic size={34} />,
      emptyTitle: '还没有音乐',
      emptyDesc:
        '选择一个本地音乐文件夹，自动读取标签、封面与歌词。支持 MP3 / FLAC / M4A / WAV / OGG 等格式，数据只保留在本机。',
    },
    favorites: {
      kicker: '我的收藏',
      title: '收藏的歌曲',
      icon: <IconHeart size={34} />,
      emptyTitle: '还没有收藏',
      emptyDesc: '在曲目右侧点击心形图标，或在播放条上收藏当前播放的歌曲。',
    },
    recent: {
      kicker: '历史',
      title: '最近播放',
      icon: <IconSpark size={34} />,
      emptyTitle: '还没有播放记录',
      emptyDesc: '开始播放后，最近听过的曲目会出现在这里。',
    },
  }[view as 'library' | 'favorites' | 'recent']

  const totalDur = currentList.reduce((acc, t) => acc + (t.duration || 0), 0)
  const durText = totalDur > 0 ? `${Math.floor(totalDur / 3600)} 小时 ${Math.round((totalDur % 3600) / 60)} 分` : '时长未知'

  return (
    <>
      <PageHead
        kicker={meta.kicker}
        title={meta.title}
        sub={
          <>
            <span>{filtered.length} 首</span>
            <span className="sep">·</span>
            <span>{durText}</span>
            {settings.autoAnalyze && scanProgress?.phase === 'parse' && (
              <>
                <span className="sep">·</span>
                <span>解析中…</span>
              </>
            )}
          </>
        }
        cover={currentList[0]?.cover}
      >
        <div className="toolbar" style={{ paddingTop: 14 }}>
          <button className="btn primary" onClick={() => playAll(sorted)} disabled={!sorted.length}>
            <IconPlay size={14} /> 播放全部
          </button>
          <button className="btn" onClick={() => playAll(sorted, true)} disabled={!sorted.length}>
            <IconShuffle size={14} /> 随机播放
          </button>
        </div>
      </PageHead>

      {statusBanner}

      {!currentList.length ? (
        <EmptyState
          icon={meta.icon}
          title={meta.emptyTitle}
          desc={meta.emptyDesc}
          action={
            view === 'library' ? (
              <button className="btn primary" onClick={() => void importFolder()} disabled={scanning}>
                <IconFolder size={15} /> 导入音乐文件夹
              </button>
            ) : undefined
          }
        />
      ) : (
        <TrackList tracks={sorted} />
      )}
    </>
  )
}
