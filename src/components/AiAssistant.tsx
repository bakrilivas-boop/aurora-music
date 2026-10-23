import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePlayer } from '../lib/store'
import { trackSource, type Track } from '../lib/types'
import { Cover, fmtTime } from './common'
import { IconClose, IconPlay, IconPlus, IconSpark } from './Icons'
import '../ai.css'

interface AiInfo { configured: boolean; model: string; modelLabel: string }
interface Message { role: 'user' | 'assistant'; content: string }
interface Control {
  command: 'play' | 'pause' | 'next' | 'prev' | 'volume' | 'shuffle' | 'repeat' | 'seek'
  value?: number | string | boolean
}
interface Recommendation {
  model: string
  action: 'none' | 'play' | 'playlist' | 'add_to_playlist' | 'reorder_playlist' | 'control'
  name: string
  ids: string[]
  explanation: string
  playlistId?: string
  control?: Control
}
interface AiBridge {
  aiInfo: () => Promise<AiInfo>
  aiConfigure: (input: { apiKey: string }) => Promise<AiInfo>
  aiRecommend: (input: {
    query: string
    tracks: Pick<Track, 'id' | 'title' | 'artist' | 'album' | 'genre' | 'duration'>[]
    playlists: { id: string; name: string; trackIds: string[] }[]
    context: { currentId: string | null; playing: boolean; volume: number; shuffle: boolean; repeat: string }
    history: Message[]
  }) => Promise<Recommendation>
}

const actionLabels = { none: '音乐问答', play: '播放歌曲', playlist: '创建歌单', add_to_playlist: '添加到歌单', reorder_playlist: '整理歌单顺序', control: '播放器操作' }
function validInfo(value: AiInfo): boolean {
  return !!value && typeof value.configured === 'boolean' && typeof value.model === 'string' && !!value.model && typeof value.modelLabel === 'string' && !!value.modelLabel
}
function validControl(control?: Control): boolean {
  if (!control || typeof control !== 'object') return false
  if (['play', 'pause', 'next', 'prev'].includes(control.command)) return true
  if (control.command === 'volume') return typeof control.value === 'number' && Number.isFinite(control.value) && control.value >= 0 && control.value <= 1
  if (control.command === 'seek') return typeof control.value === 'number' && Number.isFinite(control.value) && control.value >= 0 && control.value <= 86400
  if (control.command === 'shuffle') return typeof control.value === 'boolean'
  return control.command === 'repeat' && ['off', 'all', 'one'].includes(String(control.value))
}
function controlLabel(control: Control): string {
  if (control.command === 'volume') return `把音量设为 ${Math.round(Number(control.value) * 100)}%`
  if (control.command === 'shuffle') return `${control.value ? '开启' : '关闭'}随机播放`
  if (control.command === 'repeat') return `切换为${({ off: '顺序播放', all: '列表循环', one: '单曲循环' } as Record<string, string>)[String(control.value)]}`
  if (control.command === 'seek') return `跳转到 ${fmtTime(Number(control.value))}`
  return { play: '继续播放', pause: '暂停播放', next: '切换下一首', prev: '返回上一首' }[control.command]
}
function friendlyError(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : 'DeepSeek 暂时没有响应，请稍后重试。'
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '').replace(/sk-[A-Za-z0-9_-]+/g, '[已隐藏 Key]').slice(0, 300)
}

export function AiAssistant() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<Recommendation | null>(null)
  const [name, setName] = useState('')
  const [preview, setPreview] = useState<Track[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [info, setInfo] = useState<AiInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [connectionMessage, setConnectionMessage] = useState('')
  const [controlTrack, setControlTrack] = useState('')
  const [mood, setMood] = useState('放松')
  const [scene, setScene] = useState('夜晚独处')
  const [count, setCount] = useState(10)
  const [sceneOperation, setSceneOperation] = useState('playlist')
  const [scenePlaylistId, setScenePlaylistId] = useState('')
  const [originalOrder, setOriginalOrder] = useState<Track[]>([])
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const conversation = useRef<HTMLDivElement>(null)
  const files = useRef(new Map<string, File | string>())
  const playlistSnapshots = useRef(new Map<string, string[]>())
  const snapshot = useRef<{ currentId: string | null; file?: File | string }>({ currentId: null })
  const tracks = usePlayer((state) => state.tracks)
  const playlists = usePlayer((state) => state.playlists)
  const scenePlaylist = playlists.find((playlist) => playlist.id === scenePlaylistId) || playlists[0]
  const availableIds = new Set(tracks.filter((track) => trackSource(track)).map((track) => track.id))
  const available = availableIds.size
  const reorderIssue = !scenePlaylist ? '请先创建一个已有歌单。' : !scenePlaylist.trackIds.length ? '这个歌单还没有歌曲，请先添加歌曲。' : scenePlaylist.trackIds.length > 100 ? '当前支持整理最多 100 首歌曲的歌单。' : scenePlaylist.trackIds.some((id) => !availableIds.has(id)) ? '这个歌单中有尚未加载的歌曲，请重新导入对应音乐文件夹。' : ''
  const sceneIssue = sceneOperation === 'reorder_playlist' ? reorderIssue : !available ? '请先导入可播放的本地歌曲。' : ''
  const exampleTrack = tracks.find((track) => trackSource(track) && track.title)
  const exactExample = exampleTrack ? `播放《${exampleTrack.title}》` : '我可以怎样整理自己的音乐库？'
  const bridge = (window as unknown as { auroraDesktop?: AiBridge }).auroraDesktop

  useEffect(() => {
    const show = (event: Event) => {
      const text = (event as CustomEvent<{ query?: unknown }>).detail?.query
      if (typeof text === 'string') setQuery(text.slice(0, 500))
      setOpen(true)
    }
    const onKey = (event: KeyboardEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.key.toLowerCase() !== 'k') return
      const active = document.activeElement as HTMLElement | null
      if (active?.matches('input, textarea') || active?.isContentEditable || active?.closest('[role="dialog"]')) return
      event.preventDefault()
      setOpen(true)
    }
    window.addEventListener('aurora:ai-open', show)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('aurora:ai-open', show); window.removeEventListener('keydown', onKey) }
  }, [])

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    input.current?.focus()
    let cancelled = false
    if (bridge?.aiInfo) {
      setChecking(true)
      void bridge.aiInfo().then((value) => {
        if (cancelled) return
        if (!validInfo(value)) throw new Error('无法读取 DeepSeek 配置，请重新打开助手。')
        setInfo(value)
        if (!value.configured) setSettingsOpen(true)
      }).catch((failure) => { if (!cancelled) setConnectionMessage(friendlyError(failure)) })
        .finally(() => { if (!cancelled) setChecking(false) })
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => { cancelled = true; setApiKey(''); window.removeEventListener('keydown', onKey, true); dialog.current?.close(); previous?.focus() }
  }, [open])

  useEffect(() => {
    if (conversation.current) conversation.current.scrollTop = conversation.current.scrollHeight
  }, [messages, busy, open])

  async function configure() {
    if (!bridge?.aiConfigure || saving || busy || !apiKey.trim()) return
    setSaving(true)
    setConnectionMessage('正在验证 DeepSeek 连接…')
    try {
      const value = await bridge.aiConfigure({ apiKey: apiKey.trim() })
      if (!validInfo(value) || value.configured !== true) throw new Error('连接尚未验证成功，请检查 API Key 后重试。')
      setInfo(value)
      setConnectionMessage('连接验证成功，已启用 DeepSeek。')
      setSettingsOpen(false)
    } catch (failure) {
      const message = friendlyError(failure)
      setConnectionMessage(apiKey.trim() ? message.split(apiKey.trim()).join('[已隐藏 Key]') : message)
    } finally { setApiKey(''); setSaving(false) }
  }

  function fillSceneRequest() {
    if (sceneIssue || busy || saving) return
    const preferences = `心情：${mood}；使用场景：${scene}`
    const text = sceneOperation === 'reorder_playlist'
      ? `请整理已有歌单《${scenePlaylist.name}》（歌单ID：${scenePlaylist.id}）的播放顺序。${preferences}。完整保留原有的 ${scenePlaylist.trackIds.length} 首歌曲，不增加、不删除，只调整顺序并说明安排理由。`
      : `请从当前可播放曲库中推荐最多 ${Math.min(count, available)} 首歌曲，新建一个场景歌单。${preferences}。说明选择理由，不添加曲库外的歌曲。`
    setQuery(`${text}仅根据歌名、歌手、专辑与流派标签建议，不声称分析过音频。`.slice(0, 500))
    setResult(null)
    setPreview([])
    setOriginalOrder([])
    setError('')
    input.current?.focus()
  }

  async function recommend() {
    const text = query.trim()
    if (!bridge?.aiRecommend || busy || saving || !text) return
    if (!info?.configured) { setSettingsOpen(true); setError('请先填写并验证 DeepSeek API Key。'); return }
    if (/\bsk-[A-Za-z0-9_-]{12,}\b/.test(text) || (apiKey.trim() && text.includes(apiKey.trim()))) {
      setError('API Key 请填写在连接设置中，不能放进对话。')
      return
    }
    const state = usePlayer.getState()
    const loaded = state.tracks.filter((track) => trackSource(track))
    files.current = new Map(loaded.map((track) => [track.id, trackSource(track)!]))
    playlistSnapshots.current = new Map(state.playlists.map((playlist) => [playlist.id, playlist.trackIds.slice()]))
    snapshot.current = { currentId: state.currentId, file: trackSource(loaded.find((track) => track.id === state.currentId)) }
    setControlTrack(loaded.find((track) => track.id === state.currentId)?.title || '')
    const history = messages.slice(-6)
    setMessages([...history, { role: 'user', content: text } as Message].slice(-6))
    setQuery('')
    setBusy(true)
    setError('')
    setResult(null)
    setPreview([])
    setOriginalOrder([])
    try {
      const recommendation = await bridge.aiRecommend({
        query: text,
        tracks: state.tracks.map(({ id, title, artist, album, genre, duration, file, nativeUrl }) => ({ id, title, artist, album, genre, duration, available: !!(file || nativeUrl) })),
        playlists: state.playlists.map(({ id, name, trackIds }) => ({ id, name, trackIds: trackIds.slice() })),
        context: { currentId: state.currentId, playing: state.playing, volume: state.settings.volume, shuffle: state.settings.shuffle, repeat: state.settings.repeat },
        history,
      })
      if (!recommendation || !Object.hasOwn(actionLabels, recommendation.action) || typeof recommendation.explanation !== 'string' || !recommendation.explanation.trim() || typeof recommendation.model !== 'string' || typeof recommendation.name !== 'string' || !Array.isArray(recommendation.ids) || recommendation.ids.length > 100 || recommendation.ids.some((id) => typeof id !== 'string')) {
        throw new Error('DeepSeek 返回的内容无法识别，请换一种说法重试。')
      }
      const ids = [...new Set(recommendation.ids)]
      const songAction = ['play', 'playlist', 'add_to_playlist', 'reorder_playlist'].includes(recommendation.action)
      if ((songAction && !ids.length) || (!songAction && ids.length) || (recommendation.action === 'control' && !validControl(recommendation.control))) throw new Error('DeepSeek 没有返回有效操作，请重新描述。')
      if (recommendation.action === 'add_to_playlist' && !usePlayer.getState().playlists.some((playlist) => playlist.id === recommendation.playlistId)) throw new Error('目标歌单已不存在，请重新选择。')
      if (recommendation.action === 'reorder_playlist') {
        const original = playlistSnapshots.current.get(recommendation.playlistId || '')
        const current = usePlayer.getState().playlists.find((playlist) => playlist.id === recommendation.playlistId)
        if (!original?.length || original.length > 100 || !current || current.trackIds.length !== original.length || current.trackIds.some((id, index) => id !== original[index])) throw new Error('歌单在请求期间已改变，请重新提出整理要求。')
        if (recommendation.ids.length !== ids.length || ids.length !== original.length || ids.some((id) => !original.includes(id))) throw new Error('整理结果必须完整保留原歌单的所有歌曲，请重试。')
      }
      if (songAction) {
        const byId = new Map(usePlayer.getState().tracks.map((track) => [track.id, track]))
        const selected = ids.map((id) => byId.get(id))
        if (selected.some((track) => !track || !trackSource(track) || files.current.get(track.id) !== trackSource(track))) throw new Error('音乐库已发生变化，请重新检索。')
        if (recommendation.action === 'reorder_playlist') setOriginalOrder(playlistSnapshots.current.get(recommendation.playlistId!)!.map((id) => byId.get(id)!))
        setPreview(selected as Track[])
      }
      setMessages((previous) => [...previous, { role: 'assistant', content: recommendation.explanation.slice(0, 3000) } as Message].slice(-6))
      setName(recommendation.name.slice(0, 60))
      setResult({ ...recommendation, ids })
    } catch (failure) { setError(friendlyError(failure)) }
    finally { setBusy(false); input.current?.focus() }
  }

  function apply() {
    if (!result || result.action === 'none' || busy) return
    const state = usePlayer.getState()
    const songAction = ['play', 'playlist', 'add_to_playlist', 'reorder_playlist'].includes(result.action)
    const byId = new Map(state.tracks.map((track) => [track.id, track]))
    if (songAction && result.ids.some((id) => !trackSource(byId.get(id)) || trackSource(byId.get(id)) !== files.current.get(id))) {
      setResult(null); setPreview([]); setError('歌曲文件已变更或不再可读，请重新检索后再应用。'); return
    }
    if (result.action === 'reorder_playlist') {
      const expected = playlistSnapshots.current.get(result.playlistId || '')
      if (!expected || !state.reorderPlaylist(result.playlistId!, result.ids, expected)) {
        setResult(null); setPreview([]); setOriginalOrder([]); setError('歌单内容或顺序已改变，已取消过期预览，请重新提出整理要求。'); return
      }
      state.setView('playlist', result.playlistId)
      state.toggleNowPlaying(false)
      state.pushToast('已整理歌单顺序，所有歌曲保持完整', 'success')
    } else if (result.action === 'playlist' || result.action === 'add_to_playlist') {
      if (result.action === 'playlist' && !name.trim()) { setError('请为歌单填写名称。'); return }
      const target = result.action === 'add_to_playlist' ? state.playlists.find((playlist) => playlist.id === result.playlistId) : null
      if (result.action === 'add_to_playlist' && !target) { setError('目标歌单已被删除，请重新检索。'); return }
      const id = target?.id || state.createPlaylist(name.trim().slice(0, 60))
      for (const trackId of result.ids) usePlayer.getState().addToPlaylist(id, trackId)
      usePlayer.getState().setView('playlist', id)
      usePlayer.getState().toggleNowPlaying(false)
      usePlayer.getState().pushToast(`已${target ? '更新' : '创建'}歌单「${target?.name || name.trim()}」`, 'success')
    } else if (result.action === 'play') {
      state.playQueue(result.ids, 0, false)
      usePlayer.getState().pushToast(`已开始播放 ${result.ids.length} 首歌曲`, 'success')
    } else if (result.action === 'control' && validControl(result.control)) {
      const control = result.control!
      if (['play', 'pause', 'seek', 'next', 'prev'].includes(control.command)) {
        const current = byId.get(state.currentId || '')
        if (snapshot.current.currentId !== state.currentId || (state.currentId && (!trackSource(current) || trackSource(current) !== snapshot.current.file))) { setError('当前歌曲已改变，请重新确认想操作的歌曲。'); return }
        if (control.command === 'seek' && (!current || !trackSource(current) || (current.duration > 0 && Number(control.value) > current.duration))) { setError('跳转位置超出当前歌曲，请重新描述。'); return }
        if (control.command === 'play' && !state.currentId && !state.tracks.some((track) => trackSource(track))) { setError('请先导入可播放的歌曲。'); return }
        if (['next', 'prev'].includes(control.command) && !state.queue.length) { setError('播放队列还是空的，请先选择歌曲。'); return }
      }
      if (control.command === 'play' && !state.playing) state.togglePlay()
      else if (control.command === 'pause' && state.playing) state.togglePlay()
      else if (control.command === 'next') state.next()
      else if (control.command === 'prev') state.prev()
      else if (control.command === 'volume') state.setVolume(Number(control.value))
      else if (control.command === 'shuffle' && state.settings.shuffle !== control.value) state.toggleShuffle()
      else if (control.command === 'repeat') state.updateSettings({ repeat: control.value as 'off' | 'all' | 'one' })
      else if (control.command === 'seek') state.seek(Number(control.value))
      state.pushToast(`已${controlLabel(control)}`, 'success')
    } else { setError('操作已失效，请重新提问。'); return }
    setMessages((previous) => [...previous, { role: 'assistant', content: `已确认：${result.action === 'control' ? controlLabel(result.control!) : actionLabels[result.action]}。` } as Message].slice(-6))
    setResult(null)
    setPreview([])
    setOriginalOrder([])
    setError('')
    input.current?.focus()
  }

  const proposedAction = result && result.action !== 'none'
  const targetPlaylist = playlists.find((playlist) => playlist.id === result?.playlistId)
  return createPortal(
    <dialog className="ai-dialog" ref={dialog} role="dialog" aria-labelledby="ai-title" aria-describedby="ai-description"
      onCancel={(event) => { event.preventDefault(); setOpen(false) }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setOpen(false)
      }}>
      <header className="ai-head">
        <span className="ai-mark"><IconSpark size={20} /></span>
        <div><h2 id="ai-title">DeepSeek 音乐助手</h2><p>{info?.modelLabel || 'DeepSeek V4.1 Flash1017'} · {available} 首可播放歌曲</p></div>
        <button className="ctrl" title="关闭音乐助手" aria-label="关闭音乐助手" onClick={() => setOpen(false)}><IconClose size={18} /></button>
      </header>
      <div className="ai-body">
        <p id="ai-description" className="ai-description">向 DeepSeek 发送对话、歌曲名称、歌手、专辑与歌单文字，不发送音频或本地文件路径。</p>
        {!bridge?.aiRecommend && <div className="ai-notice">请在 Aurora Music 桌面版连接 DeepSeek 音乐助手。</div>}
        <details className="ai-connection" open={settingsOpen} onToggle={(event) => setSettingsOpen(event.currentTarget.open)}>
          <summary><span className={`ai-connection-dot${info?.configured ? ' connected' : ''}`} />{checking ? '正在读取连接状态…' : info?.configured ? 'DeepSeek 已连接' : '连接 DeepSeek'}<span>API 设置</span></summary>
          <form onSubmit={(event) => { event.preventDefault(); void configure() }}>
            <label htmlFor="ai-api-key">DeepSeek API Key</label>
            <div className="ai-query-row"><input id="ai-api-key" type="password" value={apiKey} autoComplete="off" spellCheck={false} placeholder={info?.configured ? '已配置，输入新 Key 可更换' : '输入 API Key'} disabled={busy || saving || checking} onChange={(event) => setApiKey(event.target.value)} /><button className="btn" type="submit" disabled={!bridge?.aiConfigure || !apiKey.trim() || busy || saving || checking}>{saving ? '验证中…' : '保存并验证'}</button></div>
            <p>仅在点击按钮后保存。已保存的 Key 不会回填到页面或加入对话。</p>
          </form>
        </details>
        {connectionMessage && <p className="ai-connection-message" role="status">{connectionMessage}</p>}
        <details className="ai-scene-picker" open>
          <summary>按心情与场景推荐 <span>新建歌单 / 整理已有歌单</span></summary>
          <div className="ai-scene-fields">
            <label>心情<select aria-label="推荐心情" value={mood} disabled={busy} onChange={(event) => setMood(event.target.value)}>{['放松', '开心', '思念', '振奋', '不限'].map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>场景<select aria-label="推荐场景" value={scene} disabled={busy} onChange={(event) => setScene(event.target.value)}>{['夜晚独处', '通勤', '运动', '专注', '休息', '不限'].map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>操作<select aria-label="推荐操作" value={sceneOperation} disabled={busy} onChange={(event) => setSceneOperation(event.target.value)}><option value="playlist">新建场景歌单</option><option value="reorder_playlist">整理已有歌单</option></select></label>
            {sceneOperation === 'playlist' ? <label>歌曲数量<input aria-label="推荐数量" type="number" min={1} max={30} value={count} disabled={busy} onChange={(event) => setCount(Math.max(1, Math.min(30, Math.trunc(Number(event.target.value) || 1))))} /></label> : <label>整理数量<output>{scenePlaylist?.trackIds.length || 0} 首 · 全部保留</output></label>}
            {sceneOperation === 'reorder_playlist' && <label className="ai-scene-target">目标歌单<select aria-label="目标歌单" value={scenePlaylist?.id || ''} disabled={busy || !playlists.length} onChange={(event) => setScenePlaylistId(event.target.value)}>{!playlists.length && <option value="">暂无已有歌单</option>}{playlists.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.name}（{playlist.trackIds.length} 首）</option>)}</select></label>}
          </div>
          <div className="ai-scene-footer"><p>{sceneIssue || (sceneOperation === 'reorder_playlist' ? '只调整顺序，不添加或移除歌曲；先预览，再确认。' : `当前有 ${available} 首可播放歌曲，推荐最多 ${Math.min(count, available)} 首。`)}<span>推荐依据歌曲文字标签，不分析音频。</span></p><button className="btn" type="button" disabled={busy || saving || !!sceneIssue} onClick={fillSceneRequest}>填写推荐要求</button></div>
        </details>
        <div className="ai-conversation-head"><span>当前会话</span><button className="btn ghost" disabled={busy || !messages.length} onClick={() => { setMessages([]); setResult(null); setPreview([]); setError('') }}>清空对话</button></div>
        <div className="ai-conversation" ref={conversation} role="log" aria-label="与 DeepSeek 的对话" aria-live="polite">
          {!messages.length && <div className="ai-welcome"><IconSpark size={25} /><strong>今天想听些什么？</strong><p>聊音乐、发现曲库中的歌曲、整理歌单，也可以调整播放和音量。{!available ? '还没导入歌曲时，也能先聊聊音乐。' : ''}</p></div>}
          {messages.map((message, index) => <div key={index} className={`ai-message ${message.role}`}><span>{message.role === 'user' ? '你' : 'DeepSeek'}</span><p>{message.content}</p></div>)}
          {busy && <div className="ai-status" role="status"><span className="spinner" />DeepSeek 正在思考…</div>}
        </div>
        {error && <div className="ai-error" role="alert">{error}</div>}
        {proposedAction && <section className="ai-result" aria-label="操作预览">
          <div className="ai-result-head"><strong>待确认操作</strong><span>{actionLabels[result.action]}</span></div>
          {result.action === 'control' && result.control && <div className="ai-control-preview"><strong>{controlLabel(result.control)}</strong>{controlTrack && ['play', 'pause', 'next', 'prev', 'seek'].includes(result.control.command) && <span>当前歌曲：{controlTrack}</span>}</div>}
          {result.action === 'add_to_playlist' && <p className="ai-explanation">加入歌单：{targetPlaylist?.name || '歌单已不存在'}</p>}
          {result.action === 'reorder_playlist' && <><p className="ai-explanation">整理《{targetPlaylist?.name || '歌单已不存在'}》· {preview.length} 首歌曲全部保留</p><div className="ai-order-preview"><section><h3>原顺序</h3><ol>{originalOrder.map((track, index) => <li key={track.id}><span>{index + 1}</span><div><strong title={track.title}>{track.title}</strong><small>{track.artist}</small></div></li>)}</ol></section><span className="ai-order-arrow" aria-hidden="true">→</span><section><h3>建议顺序</h3><ol>{preview.map((track, index) => <li key={track.id}><span>{index + 1}</span><div><strong title={track.title}>{track.title}</strong><small>{track.artist}</small></div><em>{originalOrder.findIndex((item) => item.id === track.id) + 1}→{index + 1}</em></li>)}</ol></section></div></>}
          {!!preview.length && result.action !== 'reorder_playlist' && <ol className="ai-tracks">{preview.map((track, index) => <li key={track.id}><span className="ai-index">{index + 1}</span><Cover className="ai-cover" src={track.cover} iconSize={15} /><div className="ai-track-text"><strong>{track.title}</strong><span>{track.artist} · {track.album || '未知专辑'}</span></div><span className="ai-duration">{track.duration ? fmtTime(track.duration) : '--:--'}</span></li>)}</ol>}
          {result.action === 'playlist' && <label className="ai-name">歌单名称<input aria-label="歌单名称" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} /></label>}
          <footer className="ai-result-footer"><span>确认后才会执行</span><div><button className="btn ghost" onClick={() => { setResult(null); setPreview([]); setOriginalOrder([]) }}>取消操作</button><button className="btn primary" onClick={apply} disabled={busy || (result.action === 'playlist' && !name.trim())}>{result.action === 'play' ? <IconPlay size={15} /> : ['control', 'reorder_playlist'].includes(result.action) ? <IconSpark size={15} /> : <IconPlus size={15} />}确认{actionLabels[result.action]}</button></div></footer>
        </section>}
        <form className="ai-form" onSubmit={(event) => { event.preventDefault(); void recommend() }}>
          <label htmlFor="ai-query">和音乐助手说句话</label>
          <div className="ai-query-row"><input id="ai-query" ref={input} maxLength={500} placeholder={`例如：${exactExample}`} value={query} disabled={busy || saving} onChange={(event) => { setQuery(event.target.value); setError('') }} /><button className="btn primary" type="submit" disabled={busy || saving || !query.trim() || !bridge?.aiRecommend || !info?.configured}>{busy ? <><span className="spinner" />思考中</> : <><IconSpark size={15} />发送</>}</button></div>
        </form>
        <div className="ai-examples" aria-label="提问示例">{[exactExample, '曲库里有哪些歌手？', '把音量设为40%', '建一个适合夜晚听的歌单'].map((example) => <button type="button" className="chip" key={example} disabled={busy} onClick={() => { setQuery(example); setError(''); input.current?.focus() }}>{example}</button>)}</div>
        <p className="ai-footnote">所有问题均由 DeepSeek V4.1 Flash1017 回答。仅保留当前会话最近 6 条消息；关闭软件后不保留对话。</p>
      </div>
    </dialog>, document.body,
  )
}
