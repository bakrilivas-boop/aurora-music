import type { RepeatMode } from './types'

export interface AiInfo { configured: boolean; model: string; modelLabel: string }
export interface AiInput {
  query: string
  tracks: { id: string; title: string; artist: string; album: string; genre?: string; duration: number; available?: boolean }[]
  playlists: { id: string; name: string; trackIds: string[] }[]
  context: { currentId: string | null; playing: boolean; volume: number; shuffle: boolean; repeat: RepeatMode }
  history?: { role: 'user' | 'assistant'; content: string }[]
}
export interface AiRecommendation {
  model: string
  action: 'none' | 'play' | 'playlist' | 'add_to_playlist' | 'reorder_playlist' | 'control'
  name: string
  ids: string[]
  explanation: string
  playlistId?: string
  control?: { command: 'play' | 'pause' | 'next' | 'prev' | 'volume' | 'shuffle' | 'repeat' | 'seek'; value?: number | string | boolean }
}
