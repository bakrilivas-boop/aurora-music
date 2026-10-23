import { engine } from '../lib/audio'
import { usePlayer } from '../lib/store'
import { Cover, CurrentTime, ProgressBar, Spectrum, TotalTime, VolumeSlider } from './common'
import {
  IconEq,
  IconHeart,
  IconLyrics,
  IconNext,
  IconPause,
  IconPlay,
  IconPrev,
  IconQueue,
  IconRepeat,
  IconRepeatOne,
  IconShuffle,
  IconVolume,
  IconVolumeMute,
} from './Icons'

export function PlayerBar({ onOpenQueue }: { onOpenQueue: () => void }) {
  const tracks = usePlayer((s) => s.tracks)
  const currentId = usePlayer((s) => s.currentId)
  const playing = usePlayer((s) => s.playing)
  const settings = usePlayer((s) => s.settings)
  const togglePlay = usePlayer((s) => s.togglePlay)
  const next = usePlayer((s) => s.next)
  const prev = usePlayer((s) => s.prev)
  const toggleShuffle = usePlayer((s) => s.toggleShuffle)
  const cycleRepeat = usePlayer((s) => s.cycleRepeat)
  const setVolume = usePlayer((s) => s.setVolume)
  const toggleMute = usePlayer((s) => s.toggleMute)
  const toggleFavorite = usePlayer((s) => s.toggleFavorite)
  const favorites = usePlayer((s) => s.favorites)
  const toggleNowPlaying = usePlayer((s) => s.toggleNowPlaying)

  const current = tracks.find((t) => t.id === currentId) ?? null
  const liked = current ? favorites.includes(current.id) : false
  const VolumeIcon = settings.muted || settings.volume === 0 ? IconVolumeMute : IconVolume

  return (
    <footer className="playerbar">
      <div className="pb-left">
        <Cover
          src={current?.cover}
          className="pb-cover"
          iconSize={18}
          onClick={() => current && toggleNowPlaying(true)}
          title={current ? '打开歌词页' : '暂无播放'}
          seed={current ? current.artist + current.title : undefined}
        />
        <div className="pb-meta">
          <span className="pb-title" title={current?.title}>
            {current ? current.title : '未在播放'}
          </span>
          <span className="pb-artist" title={current?.artist}>
            {current ? current.artist : '导入本地音乐开始聆听'}
          </span>
        </div>
        {current && (
          <button
            className={`ctrl${liked ? ' on' : ''}`}
            style={{ width: 30, height: 30, color: liked ? 'var(--danger)' : undefined }}
            onClick={() => toggleFavorite(current.id)}
            title={liked ? '取消收藏' : '收藏'}
          >
            <IconHeart size={16} filled={liked} />
          </button>
        )}
      </div>

      <div className="pb-center">
        <div className="pb-controls">
          <button
            className={`ctrl${settings.shuffle ? ' on' : ''}`}
            onClick={toggleShuffle}
            title={settings.shuffle ? '关闭随机播放' : '开启随机播放'}
          >
            <IconShuffle size={16} />
          </button>
          <button className="ctrl" onClick={prev} title="上一首">
            <IconPrev size={17} />
          </button>
          <button className="ctrl-play" onClick={togglePlay} disabled={!tracks.length} title={playing ? '暂停' : '播放'}>
            {playing ? <IconPause size={18} /> : <IconPlay size={18} />}
          </button>
          <button className="ctrl" onClick={() => next()} title="下一首">
            <IconNext size={17} />
          </button>
          <button
            className={`ctrl${settings.repeat !== 'off' ? ' on' : ''}`}
            onClick={cycleRepeat}
            title={
              settings.repeat === 'one' ? '单曲循环' : settings.repeat === 'all' ? '列表循环' : '不循环'
            }
          >
            {settings.repeat === 'one' ? <IconRepeatOne size={16} /> : <IconRepeat size={16} />}
          </button>
        </div>
        <div className="pb-progress">
          <CurrentTime />
          <ProgressBar />
          <TotalTime track={current} />
        </div>
      </div>

      <div className="pb-right">
        <button className="ctrl-play pb-compact-play" onClick={togglePlay} disabled={!tracks.length} title={playing ? '暂停' : '播放'}>{playing ? <IconPause size={18} /> : <IconPlay size={18} />}</button>
        {settings.showSpectrum && playing && <Spectrum mini bars={16} />}
        <button
          className={`ctrl${settings.eqEnabled ? ' on' : ''}`}
          onClick={() => window.dispatchEvent(new Event('aurora:equalizer-open'))}
          title="均衡器"
        >
          <IconEq size={16} />
        </button>
        <button className="ctrl" onClick={onOpenQueue} title="播放队列">
          <IconQueue size={16} />
        </button>
        <button className="ctrl" onClick={() => toggleNowPlaying(true)} title="歌词 / 正在播放">
          <IconLyrics size={16} />
        </button>
        <div className="volume-wrap">
          <button className="ctrl" onClick={toggleMute} title={settings.muted ? '取消静音' : '静音'} style={{ width: 30 }}>
            <VolumeIcon size={16} />
          </button>
          <VolumeSlider
            value={settings.muted ? 0 : settings.volume}
            onLive={(v) => engine.setVolume(v)}
            onCommit={(v) => setVolume(v)}
          />
        </div>
      </div>
    </footer>
  )
}
