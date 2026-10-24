import { registerPlugin } from '@capacitor/core'
import { create } from 'zustand'
import { App } from '@capacitor/app'
import { usePlayer } from '../lib/store'
import { importAndroid, isAndroid, type MobileFile } from './native'

export interface OnlineTrack { source: 'netease' | 'qq'; id: string; title: string; artist: string; duration: number; restricted?: boolean }
export interface OnlinePlaylist { source: 'netease' | 'qq'; playlistId: string; name: string; tracks: OnlineTrack[]; total: number; complete: boolean }
export interface DownloadJob extends OnlineTrack { key: string; status: 'waiting' | 'resolving' | 'downloading' | 'complete' | 'failed' | 'cancelled'; bytes: number; total: number; message?: string; file?: MobileFile }
interface Snapshot { jobs: DownloadJob[]; endpoint: string; enabled: boolean; error?: string }
interface DownloadsBridge {
  snapshot(): Promise<Snapshot>
  resume(): Promise<void>
  configure(options: { endpoint: string; enabled: boolean }): Promise<Snapshot>
  list(options: { url: string }): Promise<OnlinePlaylist>
  cancelRead(): Promise<void>
  requestNotifications(): Promise<void>
  enqueue(options: { tracks: OnlineTrack[] }): Promise<{ added: number }>
  cancel(options: { key: string }): Promise<Snapshot>
  retry(options: { key: string }): Promise<Snapshot>
  clearFinished(options: { keys: string[] }): Promise<Snapshot>
}
export const downloadBridge = registerPlugin<DownloadsBridge>('AuroraDownloads')
export const useDownloads = create<Snapshot & { reading: boolean; playlist: OnlinePlaylist | null; error: string }>(() => ({
  jobs: [], endpoint: 'https://music-api.gdstudio.xyz/api.php', enabled: true, reading: false, playlist: null, error: '',
}))
let polling: Promise<void> | null = null
let initialized = false
let failuresReported = new Set<string>()
export async function refreshDownloads() {
  if (!isAndroid) return
  if (polling) return polling
  polling = (async () => {
    const state = await downloadBridge.snapshot()
    useDownloads.setState(state)
    if (!usePlayer.getState().ready) return
    const known = new Set(usePlayer.getState().tracks.map(t => t.id))
    const missing = state.jobs.filter(j => j.status === 'complete' && j.file && !known.has(`android_${j.file.id}`)).slice(0, 10)
    if (missing.length) {
      const count = await importAndroid(false, { files: missing.map(j => j.file!) }, true)
      if (count) usePlayer.getState().pushToast(`${count} 首下载音乐已自动加入曲库`, 'success')
      for (const job of missing) if (!usePlayer.getState().tracks.some(t => t.id === `android_${job.file!.id}`) && !failuresReported.has(job.key)) {
        failuresReported.add(job.key)
        usePlayer.getState().pushToast('歌曲已下载，资料读取暂未完成；重新打开应用会再尝试入库', 'error')
      }
    }
  })().catch(error => { useDownloads.setState({ error: (error as Error).message || '无法读取下载队列' }) }).finally(() => { polling = null })
  return polling
}
export function initializeDownloads() {
  if (initialized || !isAndroid) return
  initialized = true
  void refreshDownloads().then(() => downloadBridge.resume()).catch(() => {})
  void App.addListener('appStateChange', ({ isActive }) => { if (isActive) void refreshDownloads() })
  setInterval(() => { if (!document.hidden) void refreshDownloads() }, 1800)
}
export async function readOnlinePlaylist(url: string) {
  if (!isAndroid) throw new Error('请安装安卓版本后读取在线歌单')
  useDownloads.setState({ reading: true, error: '' })
  try { const playlist = await downloadBridge.list({ url }); useDownloads.setState({ playlist }); return playlist }
  catch (error) { useDownloads.setState({ error: (error as Error).message || '歌单读取失败' }); throw error }
  finally { useDownloads.setState({ reading: false }) }
}
export async function enqueueDownloads(tracks: OnlineTrack[]) {
  await downloadBridge.requestNotifications()
  const result = await downloadBridge.enqueue({ tracks })
  await refreshDownloads()
  return result.added
}
