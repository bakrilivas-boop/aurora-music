import { useEffect, useMemo, useState } from 'react'
import { IconArrowDown, IconClose, IconFolder, IconMusic, IconRefresh, IconCheck, IconPlus } from '../components/Icons'
import { fmtTime } from '../components/common'
import { usePlayer } from '../lib/store'
import { downloadBridge, enqueueDownloads, readOnlinePlaylist, refreshDownloads, useDownloads } from './downloads'
import './downloads.css'

const statusNames = { waiting: '等待下载', resolving: '解析音源', downloading: '正在下载', complete: '下载完成', failed: '下载失败', cancelled: '已取消' }
const bytes = (n: number) => n > 0 ? `${(n / 1024 / 1024).toFixed(1)} MB` : ''
export default function MobileDownloads({ close, library }: { close(): void; library(): void }) {
  const state = useDownloads()
  const [url, setUrl] = useState(() => { try { return localStorage.getItem('aurora-playlist-url') || '' } catch { return '' } })
  const [endpoint, setEndpoint] = useState(state.endpoint)
  const [settings, setSettings] = useState(false)
  const [tab, setTab] = useState<'preview' | 'queue'>('preview')
  const [selected, setSelected] = useState(new Set<string>())
  const [page, setPage] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const playlist = state.playlist
  const rows = playlist?.tracks || []
  const active = state.jobs.filter(j => ['waiting', 'resolving', 'downloading'].includes(j.status)).length
  const known = useMemo(() => new Set(state.jobs.map(j => `${j.source}_${j.id}`)), [state.jobs])
  const completed = state.jobs.filter(j => j.status === 'complete').length
  useEffect(() => { void refreshDownloads() }, [])
  useEffect(() => { setEndpoint(state.endpoint) }, [state.endpoint])
  const notify = (value: string) => usePlayer.getState().pushToast(value, 'success')
  const action = async (fn: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await fn() } catch (e) { setError((e as Error).message || '操作失败，请重试') }
    finally { setBusy(false) }
  }
  const read = () => action(async () => {
    if (!url.trim()) throw new Error('请先粘贴完整的网易云或 QQ 音乐歌单链接')
    try { localStorage.setItem('aurora-playlist-url', url.trim()) } catch {}
    const result = await readOnlinePlaylist(url.trim())
    setSelected(new Set(result.tracks.filter(t => !known.has(`${t.source}_${t.id}`)).map(t => t.id)))
    setPage(0); setTab('preview')
  })
  const queue = () => action(async () => {
    const count = await enqueueDownloads(rows.filter(t => selected.has(t.id) && !known.has(`${t.source}_${t.id}`)))
    notify(count ? `${count} 首歌曲已加入下载队列` : '这些歌曲已在下载队列中')
    setSelected(new Set()); setTab('queue'); setPage(0)
  })
  const items = tab === 'preview' ? rows : state.jobs
  const pages = Math.ceil(items.length / 50)
  return <section className="m-downloads" role="dialog" aria-modal="true" aria-label="歌单下载">
    <header className="m-download-head"><span className="m-download-logo"><IconArrowDown size={23} /></span><div><h1>歌单下载</h1><p>网易云 / QQ 音乐 · 下载后自动入库</p></div><button className="m-icon" aria-label="关闭歌单下载" onClick={close}><IconClose size={23} /></button></header>
    <div className="m-download-scroll">
      <div className="m-download-location"><IconFolder size={23} /><span><strong>保存到 Aurora 应用音乐目录</strong><small>原生后台队列 · {active ? `${active} 首进行中` : '随时离线聆听'}</small></span><button onClick={library}>音乐库 →</button></div>
      <form className="m-download-form" onSubmit={e => { e.preventDefault(); void read() }}><label htmlFor="playlist-url">歌单链接</label><textarea id="playlist-url" rows={2} value={url} placeholder="粘贴网易云音乐或 QQ 音乐的完整歌单链接" onChange={e => setUrl(e.target.value)} disabled={state.reading} /><button className="m-primary m-wide" disabled={busy || !url.trim()} type="submit">{state.reading ? <><span className="m-spinner" />正在读取歌单</> : <><IconPlus size={17} />读取歌单</>}</button></form>
      {state.reading && <button className="m-download-cancel-read" onClick={() => void downloadBridge.cancelRead()}>取消读取</button>}
      <button className="m-download-settings-toggle" aria-expanded={settings} onClick={() => setSettings(!settings)}>备用音源解析 <span>{state.enabled ? '已开启' : '已关闭'} · {settings ? '收起' : '设置'}</span></button>
      {settings && <div className="m-download-settings"><p>先尝试平台公开音源，没有可用地址时再调用兼容解析接口。结果受平台权限、音源和网络状态影响。</p><label>解析接口<input aria-label="解析接口" type="url" value={endpoint} onChange={e => setEndpoint(e.target.value)} disabled={active > 0} /></label><div><label className="m-setting-line"><span>启用备用解析</span><input type="checkbox" role="switch" aria-label="启用备用解析" checked={state.enabled} disabled={busy || active > 0} onChange={e => { const enabled = e.target.checked; void action(async () => { useDownloads.setState(await downloadBridge.configure({ endpoint: state.endpoint, enabled })) }) }} /></label><button disabled={busy || active > 0} onClick={() => void action(async () => { useDownloads.setState(await downloadBridge.configure({ endpoint: endpoint.trim(), enabled: state.enabled })); notify('解析设置已保存') })}>保存接口</button></div>{active > 0 && <small>下载进行中，完成或取消后可修改接口。</small>}</div>}
      {(error || state.error) && <p className="m-download-error" role="alert">{error || state.error}</p>}
      <div className="m-download-tabs"><button className={tab === 'preview' ? 'active' : ''} onClick={() => { setTab('preview'); setPage(0) }}>歌单预览{playlist ? ` · ${rows.length}` : ''}</button><button className={tab === 'queue' ? 'active' : ''} onClick={() => { setTab('queue'); setPage(0) }}>下载队列 · {state.jobs.length}</button></div>
      {tab === 'preview' && <>{playlist ? <><div className="m-download-summary"><h2>{playlist.name}</h2><p>已读取 {rows.length} / {playlist.total || rows.length} 首 · {playlist.source === 'netease' ? '网易云音乐' : 'QQ 音乐'}</p>{!playlist.complete && <p className="m-download-warning">当前列表可能不完整；每次最多读取 1000 首、10 页。</p>}</div><label className="m-download-select"><input type="checkbox" aria-label="选择全部已读取歌曲" checked={rows.some(t => !known.has(`${t.source}_${t.id}`)) && rows.filter(t => !known.has(`${t.source}_${t.id}`)).every(t => selected.has(t.id))} onChange={e => setSelected(e.target.checked ? new Set(rows.filter(t => !known.has(`${t.source}_${t.id}`)).map(t => t.id)) : new Set())} />全选已读取歌曲<span>已选 {selected.size} 首</span></label>{rows.slice(page * 50, page * 50 + 50).map(t => { const added = known.has(`${t.source}_${t.id}`); return <label className="m-download-song" key={t.id}><input type="checkbox" aria-label={`选择 ${t.title}`} disabled={added} checked={!added && selected.has(t.id)} onChange={e => setSelected(old => { const next = new Set(old); e.target.checked ? next.add(t.id) : next.delete(t.id); return next })} /><span><strong>{t.title}</strong><small>{t.artist} · {fmtTime(t.duration)}{t.restricted ? ' · 平台受限' : ''}</small></span>{added && <small>已在队列</small>}</label> })}</> : <div className="m-download-empty"><IconFolder size={38} /><h2>把歌单带到手机里</h2><p>粘贴公开歌单链接，读取后选择歌曲下载。</p></div>}</>}
      {tab === 'queue' && <>{state.jobs.length > 0 ? <><div className="m-download-summary"><h2>{completed} 首已完成</h2><p>下载成功后自动加入音乐库，已有歌曲和歌单会保留。</p><button className="m-download-clean" disabled={busy} onClick={() => void action(async () => { const imported = new Set(usePlayer.getState().tracks.map(t => t.id)); const keys = state.jobs.filter(j => ['failed', 'cancelled'].includes(j.status) || j.status === 'complete' && j.file && imported.has(`android_${j.file.id}`)).map(j => j.key); useDownloads.setState(await downloadBridge.clearFinished({ keys })); setPage(0); notify('已清理结束记录，音乐库中的歌曲保留') })}>清理已结束记录</button>{active > 0 && <button className="m-text-danger" disabled={busy} onClick={() => void action(async () => { useDownloads.setState(await downloadBridge.cancel({ key: '' })) })}>取消全部未完成任务</button>}</div>{state.jobs.slice(page * 50, page * 50 + 50).map(j => <div className="m-download-job" key={j.key}><div className="m-download-job-icon">{j.status === 'complete' ? <IconCheck size={19} /> : <IconMusic size={19} />}</div><div><strong>{j.title}</strong><small>{j.artist} · {statusNames[j.status]}</small>{j.status === 'downloading' && <><progress max={j.total > 0 ? j.total : undefined} value={j.total > 0 ? j.bytes : undefined} aria-label={`${j.title} 下载进度`} /><small>{bytes(j.bytes)}{j.total > 0 ? ` / ${bytes(j.total)}` : ''}</small></>}{j.message && <p className={j.status === 'failed' ? 'failed' : ''}>{j.message}</p>}</div>{['failed', 'cancelled'].includes(j.status) ? <button className="m-icon" aria-label={`重试 ${j.title}`} disabled={busy} onClick={() => void action(async () => { useDownloads.setState(await downloadBridge.retry({ key: j.key })) })}><IconRefresh size={19} /></button> : ['waiting', 'resolving', 'downloading'].includes(j.status) ? <button className="m-icon" aria-label={`取消 ${j.title}`} disabled={busy} onClick={() => void action(async () => { useDownloads.setState(await downloadBridge.cancel({ key: j.key })) })}><IconClose size={18} /></button> : null}</div>)}</> : <div className="m-download-empty"><IconArrowDown size={38} /><h2>还没有下载任务</h2><p>读取歌单后，选择想收藏的歌曲。</p></div>}</>}
      {pages > 1 && <div className="m-download-pages"><button disabled={page <= 0} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1} / {pages}</span><button disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>下一页</button></div>}
    </div>
    <footer className="m-download-footer">{tab === 'preview' ? <button className="m-primary m-wide" disabled={busy || state.reading || selected.size === 0} onClick={() => void queue()}><IconArrowDown size={19} />下载所选 {selected.size > 0 ? `${selected.size} 首` : ''}</button> : <button className="m-primary m-wide" onClick={library}>查看音乐库</button>}<p>关闭面板后队列继续；系统强制停止应用时任务可能中断，可重新打开后恢复或重试。请下载你有权使用的内容。</p></footer>
  </section>
}
