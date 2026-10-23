import { create } from 'zustand'
import type { Track } from './types'

export interface MetadataInput { title: string; artist: string; duration: number; refresh?: boolean }
export interface MetadataResult { cover?: string; lyrics?: string; source?: string; matched?: boolean; message?: string }
interface MetadataStatus { loading: boolean; message: string; source?: string }
export const useMetadata = create<{ statuses: Record<string, MetadataStatus>; retry: number }>(() => ({ statuses: {}, retry: 0 }))

export function metadataStatus(id: string, status: MetadataStatus) {
  useMetadata.setState((state) => ({ statuses: { ...state.statuses, [id]: status } }))
}

/** Online results only fill missing local assets. */
export function mergeMetadata(track: Track, result: MetadataResult): Track {
  if (!result.matched) return track
  const cover = track.cover || (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(result.cover || '') ? result.cover : undefined)
  const embeddedLyrics = track.embeddedLyrics?.trim() ? track.embeddedLyrics : result.lyrics?.trim().slice(0, 200_000)
  return cover === track.cover && embeddedLyrics === track.embeddedLyrics ? track : { ...track, cover, embeddedLyrics }
}
