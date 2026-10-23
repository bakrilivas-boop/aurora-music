import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePlayer } from '../lib/store'
import { fmtTime } from './common'
import { IconArrowDown, IconClose, IconFolder, IconRefresh, IconSpark } from './Icons'
import '../ai.css'
import '../downloads.css'

interface PlaylistTrack { id: string; title: string; artist: string; duration: number; source: 'netease' | 'qq'; restricted?: boolean }
interface PlaylistPreview { source: string; playlistId: string; name: string; tracks: PlaylistTrack[]; total: number; complete: boolean; enhanced?: boolean; warnings: string[] }
type DownloadStatus = 'queued' | 'resolving' | 'downloading' | 'completed' | 'failed' | 'cancelled' | 'skipped'
interface DownloadTask { id: string; source: string; trackId: string; title: string; artist: string; status: DownloadStatus; receivedBytes: number; totalBytes: number; filename?: string; message?: string }
interface Snapshot { directory: string; tasks: DownloadTask[]; active: number; completed: number }
interface MirrorInfo { enabled: boolean; endpoint: string }
interface DownloadsBridge {
  playlistPreview: (url: string) => Promise<PlaylistPreview>
  downloadInfo: () => Promise<Snapshot>
  chooseDownloadDirectory: () => Promise<Snapshot>
  enqueueDownloads: (input: { tracks: PlaylistTrack[] }) => Promise<Snapshot>
  cancelDownload: (id: string) => Promise<Snapshot>
  retryDownload: (id: string) => Promise<Snapshot>
  onDownloads: (callback: (snapshot: Snapshot) => void) => () => void
  openDownloadsFolder: () => Promise<void>
  mirrorInfo?: () => Promise<MirrorInfo>
  mirrorConfigure?: (input: { enabled?: boolean; endpoint?: string }) => Promise<MirrorInfo>
}

const PAGE_SIZE = 50
const statusLabels: Record<DownloadStatus, string> = { queued: '等待下载', resolving: '获取音源', downloading: '下载中', completed: '已完成', failed: '失败', cancelled: '已取消', skipped: '已跳过' }
const trackKey = (track: PlaylistTrack) => `${track.source}:${track.id}`
const sourceLabel = (source: string) => source === 'netease' ? '网易云音乐' : source === 'qq' ? 'QQ 音乐' : '音乐平台'
function messageText(value: unknown): string {
  const message = value instanceof Error ? value.message : typeof value === 'string' ? value : '操作暂时未完成，请稍后重试。'
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '').replace(/https?:\/\/\S+/gi, '[链接已隐藏]').replace(/\b(?:access_?token|token|accesskey|authorization)\s*[:=]\s*\S+/gi, '[凭据已隐藏]').slice(0, 300)
}
function validSnapshot(value: Snapshot): boolean {
  return !!value && typeof value.directory === 'string' && Array.isArray(value.tasks) && Number.isFinite(value.active) && Number.isFinite(value.completed) && value.tasks.every((task) => task && typeof task.id === 'string' && typeof task.trackId === 'string' && typeof task.source === 'string' && typeof task.title === 'string' && typeof task.artist === 'string' && (task.filename === undefined || typeof task.filename === 'string') && (task.message === undefined || typeof task.message === 'string') && Object.hasOwn(statusLabels, task.status) && Number.isFinite(task.receivedBytes) && task.receivedBytes >= 0 && Number.isFinite(task.totalBytes) && task.totalBytes >= 0)
}
function validPreview(value: PlaylistPreview): boolean {
  return !!value && ['netease', 'qq'].includes(value.source) && typeof value.playlistId === 'string' && typeof value.name === 'string' && typeof value.complete === 'boolean' && Number.isFinite(value.total) && value.total >= 0 && Array.isArray(value.warnings) && value.warnings.every((warning) => typeof warning === 'string') && Array.isArray(value.tracks) && value.tracks.length <= 1000 && value.tracks.every((track) => track && typeof track.id === 'string' && typeof track.title === 'string' && typeof track.artist === 'string' && track.source === value.source && Number.isFinite(track.duration) && track.duration >= 0)
}
function bytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`
  if (value >= 1024) return `${Math.round(value / 1024)} KiB`
  return `${Math.round(value)} B`
}
function Pages({ page, total, label, onPage }: { page: number; total: number; label: string; onPage: (page: number) => void }) {
  const count = Math.max(1, Math.ceil(total / PAGE_SIZE))
  if (count <= 1) return null
  return <div className="downloads-pages"><span>第 {page + 1} / {count} 页 · 共 {total} 首</span><div><button className="btn ghost" aria-label={`${label}上一页`} disabled={page === 0} onClick={() => onPage(page - 1)}>上一页</button><button className="btn ghost" aria-label={`${label}下一页`} disabled={page >= count - 1} onClick={() => onPage(page + 1)}>下一页</button></div></div>
}

export function Downloads() {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [preview, setPreview] = useState<PlaylistPreview | null>(null)
  const [selected, setSelected] = useState(new Set<string>())
  const [previewPage, setPreviewPage] = useState(0)
  const [queuePage, setQueuePage] = useState(0)
  const [tab, setTab] = useState<'playlist' | 'queue'>('playlist')
  const [snapshot, setSnapshot] = useState<Snapshot>({ directory: '', tasks: [], active: 0, completed: 0 })
  const [mirror, setMirror] = useState<MirrorInfo | null>(null)
  const [mirrorDraft, setMirrorDraft] = useState('')
  const [mirrorBusy, setMirrorBusy] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const selectAll = useRef<HTMLInputElement>(null)
  const bridge = (window as unknown as { auroraDesktop?: DownloadsBridge }).auroraDesktop
  const supported = !!bridge?.playlistPreview && !!bridge.downloadInfo
  const pending = snapshot.tasks.filter((task) => ['queued', 'resolving', 'downloading'].includes(task.status)).length
  const skipped = snapshot.tasks.filter((task) => task.status === 'skipped').length
  const failed = snapshot.tasks.filter((task) => task.status === 'failed').length
  const allSelected = !!preview?.tracks.length && selected.size === preview.tracks.length
  const shownQueuePage = Math.min(queuePage, Math.max(0, Math.ceil(snapshot.tasks.length / PAGE_SIZE) - 1))

  function accept(value: Snapshot) {
    if (!validSnapshot(value)) throw new Error('下载队列返回了无法识别的数据，请重新打开面板。')
    setSnapshot(value)
  }

  function acceptMirror(value: MirrorInfo) {
    if (!value || typeof value.enabled !== 'boolean' || typeof value.endpoint !== 'string') throw new Error('音源解析设置返回了无法识别的数据。')
    setMirror(value)
    setMirrorDraft(value.endpoint)
    return value
  }

  async function saveMirror(patch: { enabled?: boolean; endpoint?: string }) {
    if (!bridge?.mirrorConfigure || mirrorBusy) return
    setMirrorBusy(true); setError(''); setNotice('')
    try {
      const value = acceptMirror(await bridge.mirrorConfigure(patch))
      setNotice(value.enabled ? '备用音源解析已开启：受限歌曲会自动再解析一次。' : '备用音源解析已关闭：受限歌曲将直接跳过。')
    } catch (failure) { setError(messageText(failure)) }
    finally { setMirrorBusy(false) }
  }

  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener('aurora:downloads-open', show)
    let unsubscribe: (() => void) | undefined
    let cancelled = false
    if (supported) {
      void bridge.downloadInfo().then((value) => { if (!cancelled) accept(value) }).catch((failure) => { if (!cancelled) setError(messageText(failure)) })
      if (bridge.onDownloads) unsubscribe = bridge.onDownloads((value) => { try { accept(value) } catch (failure) { setError(messageText(failure)) } })
      if (bridge.mirrorInfo) void bridge.mirrorInfo().then((value) => { if (!cancelled) acceptMirror(value) }).catch(() => { /* 旧版桌面无此接口时按未开启处理 */ })
    }
    return () => { cancelled = true; unsubscribe?.(); window.removeEventListener('aurora:downloads-open', show) }
  }, [])

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    input.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true); dialog.current?.close(); previous?.focus() }
  }, [open])

  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = selected.size > 0 && !allSelected
  }, [selected, allSelected, tab])

  async function readPlaylist() {
    if (!supported || loading || !url.trim()) return
    setLoading(true); setError(''); setNotice(''); setPreview(null); setSelected(new Set()); setPreviewPage(0)
    try {
      const value = await bridge!.playlistPreview(url.trim())
      if (!validPreview(value)) throw new Error('歌单资料不完整或格式无效，请重新复制完整歌单链接。')
      setPreview(value)
      setSelected(new Set(value.tracks.map(trackKey)))
      setTab('playlist')
    } catch (failure) { setError(messageText(failure)) }
    finally { setLoading(false) }
  }

  async function mutate(operation: () => Promise<Snapshot>) {
    if (working) return
    setWorking(true); setError(''); setNotice('')
    try { accept(await operation()) }
    catch (failure) { setError(messageText(failure)) }
    finally { setWorking(false) }
  }

  async function enqueue() {
    if (!bridge || !preview || !selected.size || working || !snapshot.directory) return
    const tracks = preview.tracks.filter((track) => selected.has(trackKey(track)))
    setWorking(true); setError(''); setNotice('')
    try {
      accept(await bridge.enqueueDownloads({ tracks }))
      setTab('queue'); setQueuePage(0)
      setNotice(`已提交 ${tracks.length} 首歌曲；${preview.enhanced && mirror?.enabled ? '受限歌曲会自动走备用音源解析' : '平台限制会显示具体原因'}，重复任务会保留现有记录。`)
    } catch (failure) { setError(messageText(failure)) }
    finally { setWorking(false) }
  }

  function toggleTrack(track: PlaylistTrack) {
    setSelected((previous) => { const next = new Set(previous); const key = trackKey(track); if (next.has(key)) next.delete(key); else next.add(key); return next })
  }

  return createPortal(
    <dialog className="ai-dialog downloads-dialog" ref={dialog} role="dialog" aria-labelledby="downloads-title" aria-describedby="downloads-description"
      onCancel={(event) => { event.preventDefault(); setOpen(false) }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setOpen(false)
      }}>
      <header className="ai-head"><span className="ai-mark"><IconArrowDown size={21} /></span><div><h2 id="downloads-title">歌单下载</h2><p>网易云音乐 / QQ 音乐 · 本地下载队列</p></div><button className="ctrl" aria-label="关闭下载面板" title="关闭下载面板" onClick={() => setOpen(false)}><IconClose size={18} /></button></header>
      <div className="ai-body downloads-body">
        <p className="ai-description" id="downloads-description">读取公开歌单后选择歌曲。先用平台官方匿名音源下载；平台不给下载权限时，按歌曲编号交给备用解析接口再要一次地址，仍失败会写明原因。</p>
        {!supported && <div className="ai-notice">请在 Aurora Music 桌面版使用歌单下载；网页版不能创建本地下载任务。</div>}
        <div className="downloads-directory"><IconFolder size={18} /><div><span>保存目录</span><strong title={snapshot.directory || undefined}>{snapshot.directory || '尚未选择保存目录'}</strong></div><button className="btn ghost" disabled={!supported || working || pending > 0} title={pending ? '请等待任务结束或取消所有任务后再更改目录' : '选择保存文件夹'} onClick={() => void mutate(() => bridge!.chooseDownloadDirectory())}>更改目录</button><button className="btn ghost" disabled={!supported || !snapshot.directory} onClick={() => void bridge!.openDownloadsFolder().catch((failure) => setError(messageText(failure)))}>打开目录</button></div>
        {bridge?.mirrorConfigure && <div className="downloads-directory downloads-mirror"><IconSpark size={18} /><div><span>备用音源解析</span><strong>{!mirror ? '读取中…' : mirror.enabled ? '已开启 · 平台受限时自动再解析一次' : '已关闭 · 受限歌曲直接跳过'}</strong></div><button className="btn ghost" disabled={mirrorBusy || !mirror} title="平台未提供下载权限时，按歌曲编号向备用解析接口再要一次地址" onClick={() => void saveMirror({ enabled: !(mirror?.enabled ?? false) })}>{mirrorBusy ? '处理中…' : mirror?.enabled ? '关闭' : '开启'}</button></div>}
        {bridge?.mirrorConfigure && <form className="downloads-form downloads-mirror-form" onSubmit={(event) => { event.preventDefault(); void saveMirror({ endpoint: mirrorDraft.trim() }) }}><label htmlFor="downloads-mirror-endpoint">解析接口</label><div className="ai-query-row"><input id="downloads-mirror-endpoint" type="text" inputMode="url" autoComplete="off" spellCheck={false} maxLength={400} placeholder="https://music-api.gdstudio.xyz/api.php" value={mirrorDraft} disabled={mirrorBusy} onChange={(event) => setMirrorDraft(event.target.value)} /><button className="btn ghost" disabled={mirrorBusy || !mirrorDraft.trim() || mirrorDraft.trim() === mirror?.endpoint}>保存接口</button></div></form>}
        <form className="downloads-form" onSubmit={(event) => { event.preventDefault(); void readPlaylist() }}><label htmlFor="downloads-url">歌单链接</label><div className="ai-query-row"><input id="downloads-url" ref={input} type="text" inputMode="url" autoComplete="off" spellCheck={false} maxLength={2000} placeholder="粘贴网易云音乐或 QQ 音乐的完整歌单链接" value={url} disabled={loading} onChange={(event) => { setUrl(event.target.value); setPreview(null); setSelected(new Set()); setPreviewPage(0); setError('') }} /><button className="btn primary" disabled={!supported || loading || working || !url.trim()}>{loading ? <><span className="spinner" />读取中</> : '读取歌单'}</button></div></form>
        {error && <div className="ai-error" role="alert">{error}</div>}
        {notice && <div className="downloads-notice" role="status">{notice}</div>}
        <div className="downloads-tabs" role="tablist" aria-label="下载面板内容"><button role="tab" aria-selected={tab === 'playlist'} aria-controls="downloads-playlist-panel" className={tab === 'playlist' ? 'active' : ''} onClick={() => setTab('playlist')}>歌单预览{preview ? ` · ${preview.tracks.length}` : ''}</button><button role="tab" aria-selected={tab === 'queue'} aria-controls="downloads-queue-panel" className={tab === 'queue' ? 'active' : ''} onClick={() => setTab('queue')}>下载队列 · {snapshot.tasks.length}{pending ? `（进行中 ${pending}）` : ''}</button></div>
        {tab === 'playlist' ? <section id="downloads-playlist-panel" className="downloads-panel" role="tabpanel" aria-label="歌单预览">
          {!preview ? <div className="downloads-empty"><IconFolder size={28} /><strong>{loading ? '正在读取歌单…' : '先读取歌单，再选择下载'}</strong><p>支持公开的网易云音乐和 QQ 音乐歌单。每页显示 50 首，全选会包含所有已读取的页面。</p></div> : <>
            <div className="downloads-playlist-head"><div><h3>{preview.name || '未命名歌单'}</h3><p>{sourceLabel(preview.source)} · 已读取 {preview.tracks.length} / {preview.total || '未知'} 首</p></div><span className={`downloads-badge${preview.complete ? ' complete' : ' warning'}`}>{preview.complete ? '已完整读取' : '当前列表不完整'}</span></div>
            {!preview.complete && <p className="downloads-warning">平台未返回完整歌单，下载范围仅为当前已读取的 {preview.tracks.length} 首。</p>}
            {preview.warnings.map((warning, index) => <p key={index} className="downloads-warning">{messageText(warning)}</p>)}
            <div className="downloads-selection"><label><input type="checkbox" ref={selectAll} aria-label="全选歌单所有页面" checked={allSelected} disabled={!preview.tracks.length || working} onChange={() => setSelected(allSelected ? new Set() : new Set(preview.tracks.map(trackKey)))} />全选（包含全部页）</label><span>已选 {selected.size} 首</span><button className="btn primary" disabled={!selected.size || working || !snapshot.directory || !supported} onClick={() => void enqueue()}><IconArrowDown size={14} />{working ? '提交中…' : `下载选中 ${selected.size} 首`}</button></div>
            <div className="downloads-track-list">{preview.tracks.slice(previewPage * PAGE_SIZE, (previewPage + 1) * PAGE_SIZE).map((track, index) => <label className="downloads-track-row" key={trackKey(track)}><input type="checkbox" aria-label={`选择 ${track.title}`} checked={selected.has(trackKey(track))} disabled={working} onChange={() => toggleTrack(track)} /><span className="downloads-index">{previewPage * PAGE_SIZE + index + 1}</span><span className="downloads-track-text"><strong title={track.title}>{track.title}</strong><small>{track.artist}</small></span><span className="downloads-duration">{track.duration ? fmtTime(track.duration) : '--:--'}</span><span className={`downloads-track-right${track.restricted ? ' restricted' : ''}`}>{track.restricted ? (preview.enhanced && mirror?.enabled ? '解析下载' : '平台限制') : '可尝试下载'}</span></label>)}</div>
            <Pages page={previewPage} total={preview.tracks.length} label="歌单预览" onPage={setPreviewPage} />
          </>}
        </section> : <section id="downloads-queue-panel" className="downloads-panel" role="tabpanel" aria-label="下载队列">
          <div className="downloads-queue-summary"><strong>已完成 {snapshot.completed} 首</strong><span>正在处理 {snapshot.active} · 等待 {Math.max(0, pending - snapshot.active)} · 已跳过 {skipped} 首 · 失败 {failed} 首</span></div>
          {!snapshot.tasks.length ? <div className="downloads-empty"><IconArrowDown size={28} /><strong>还没有下载任务</strong><p>在歌单预览中勾选歌曲后，点击“下载选中”。</p></div> : <div className="downloads-task-list">{snapshot.tasks.slice(shownQueuePage * PAGE_SIZE, (shownQueuePage + 1) * PAGE_SIZE).map((task) => <div className={`downloads-task ${task.status}`} key={task.id} data-download-status={task.status}><div className="downloads-task-main"><div className="downloads-task-title"><strong title={task.title}>{task.title}</strong><span>{statusLabels[task.status]}</span></div><p className="downloads-task-artist">{task.artist} · {sourceLabel(task.source)}</p>{task.status === 'downloading' && <><progress aria-label={`${task.title}下载进度`} value={task.totalBytes ? Math.min(task.receivedBytes, task.totalBytes) : undefined} max={task.totalBytes || 1} /><small>{bytes(task.receivedBytes)}{task.totalBytes ? ` / ${bytes(task.totalBytes)} · ${Math.min(100, Math.round(task.receivedBytes / task.totalBytes * 100))}%` : ' · 正在接收'}</small></>}{task.filename && <p className="downloads-task-message" title={task.filename}>{task.filename}</p>}{task.message && <p className="downloads-task-message">{messageText(task.message)}</p>}</div><div className="downloads-task-actions">{['queued', 'resolving', 'downloading'].includes(task.status) && <button className="btn ghost" aria-label={`取消下载 ${task.title}`} disabled={working} onClick={() => void mutate(() => bridge!.cancelDownload(task.id))}>取消</button>}{['failed', 'cancelled'].includes(task.status) && <button className="btn ghost" aria-label={`重试下载 ${task.title}`} disabled={working || !snapshot.directory} onClick={() => void mutate(() => bridge!.retryDownload(task.id))}><IconRefresh size={13} />重试</button>}</div></div>)}</div>}
          <Pages page={shownQueuePage} total={snapshot.tasks.length} label="下载队列" onPage={setQueuePage} />
        </section>}
        <footer className="downloads-footer"><div><strong>下载成功后自动加入歌曲库，无需再次导入。</strong><p>已有本地歌曲与歌单会保留，重启后自动恢复下载的音乐。关闭面板下载继续，退出软件会取消未完成任务。</p></div><button className="btn" onClick={() => { setOpen(false); usePlayer.getState().setView('library') }}><IconFolder size={15} />查看歌曲库</button></footer>
      </div>
    </dialog>, document.body,
  )
}
