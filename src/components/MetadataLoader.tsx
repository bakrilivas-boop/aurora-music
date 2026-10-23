import { useEffect, useRef } from 'react'
import { usePlayer } from '../lib/store'
import { trackSource } from '../lib/types'
import { mergeMetadata, metadataStatus, useMetadata } from '../lib/metadata'

/** Only the current song is queried; audio and file paths never leave the computer. */
export function MetadataLoader() {
  const currentId = usePlayer((state) => state.currentId)
  const ready = usePlayer((state) => state.ready)
  const enabled = usePlayer((state) => state.settings.autoMetadata)
  const duration = usePlayer((state) => state.tracks.find((track) => track.id === state.currentId)?.duration)
  const title = usePlayer((state) => state.tracks.find((track) => track.id === state.currentId)?.title)
  const artist = usePlayer((state) => state.tracks.find((track) => track.id === state.currentId)?.artist)
  const hasCover = usePlayer((state) => !!state.tracks.find((track) => track.id === state.currentId)?.cover)
  const hasLyrics = usePlayer((state) => !!state.tracks.find((track) => track.id === state.currentId)?.embeddedLyrics?.trim())
  const file = usePlayer((state) => trackSource(state.tracks.find((track) => track.id === state.currentId)))
  const retry = useMetadata((state) => state.retry)
  const previousRetry = useRef(retry)
  useEffect(() => {
    const refresh = retry !== previousRetry.current
    previousRetry.current = retry
    const desktop = window.auroraDesktop
    const track = usePlayer.getState().tracks.find((item) => item.id === currentId)
    if (!ready || !track || !enabled || !desktop?.metadata) return
    if (track.cover && track.embeddedLyrics?.trim()) return
    let cancelled = false
    // Fast skips should not start a network lookup for every passing song.
    const timer = window.setTimeout(() => {
      metadataStatus(track.id, { loading: true, message: '正在匹配封面与歌词…' })
      void desktop.metadata({ title: track.title, artist: track.artist, duration: track.duration, refresh }).then((result) => {
        if (cancelled) return
        const state = usePlayer.getState()
        if (state.currentId !== track.id || !state.settings.autoMetadata) return
        usePlayer.setState({ tracks: state.tracks.map((item) => item.id === track.id ? mergeMetadata(item, result) : item) })
        metadataStatus(track.id, { loading: false, message: result.message || (result.matched ? '已自动补全可用资料' : '暂未找到可靠匹配'), source: result.source })
      }).catch(() => {
        if (!cancelled) metadataStatus(track.id, { loading: false, message: '暂时无法获取音乐资料，可稍后重试' })
      })
    }, 450)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      const status = useMetadata.getState().statuses[track.id]
      if (status?.loading) metadataStatus(track.id, { loading: false, message: '' })
    }
  }, [currentId, ready, enabled, title, artist, duration, hasCover, hasLyrics, file, retry])
  return null
}

export function MetadataInfo({ id }: { id: string }) {
  const enabled = usePlayer((state) => state.settings.autoMetadata)
  const status = useMetadata((state) => state.statuses[id])
  const track = usePlayer((state) => state.tracks.find((item) => item.id === id))
  if (!window.auroraDesktop?.metadata) return null
  const missing = !track?.cover || !track?.embeddedLyrics?.trim()
  if (!missing && !status?.message) return null
  return <div className="metadata-info" aria-live="polite">
    <span>{!enabled ? '自动联网补全已关闭' : status?.message || '封面与歌词将自动匹配'}</span>
    {enabled && status?.source && <span className="metadata-source">资料来源：{status.source}</span>}
    {enabled && missing && <button className="btn ghost" disabled={status?.loading} onClick={() => useMetadata.setState((state) => ({ retry: state.retry + 1 }))}>{status?.loading ? '匹配中…' : '重新匹配封面与歌词'}</button>}
  </div>
}
