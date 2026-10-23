export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
export const EQ_LABELS = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k']
export const EQ_PRESETS: { name: string; gains: number[] }[] = [
  { name: '平直', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: '流行', gains: [-1, 0.5, 1.5, 2.5, 2, 0, -0.5, -0.5, 1, 2] },
  { name: '摇滚', gains: [5, 4, 2.5, 0.5, -1, -1.5, 0, 2.5, 4, 5] },
  { name: '人声', gains: [-1, -1, 0, 2, 4, 4.5, 2.5, 1, 0, -1] },
  { name: '低音增强', gains: [7, 6, 4.5, 2, 0, 0, 0, 0, 0, 0] },
  { name: '高音增强', gains: [0, 0, 0, 0, 0, 1, 3, 4.5, 5.5, 6] },
  { name: '电子', gains: [4.5, 3.5, 1, 0, -1.5, 1.5, 0.5, 1.5, 4, 5] },
  { name: '古典', gains: [3, 2, 1, 0, -1, -1, 0, 1.5, 2.5, 3.5] },
]

type FrameListener = (time: number, duration: number) => void
type SimpleListener = () => void
type ErrorListener = (error?: Error) => void

class AudioEngine {
  readonly el: HTMLAudioElement
  private ctx: AudioContext | null = null
  private source: MediaElementAudioSourceNode | null = null
  private filters: BiquadFilterNode[] = []
  private gain: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private frameListeners = new Set<FrameListener>()
  private endedListeners = new Set<SimpleListener>()
  private errorListeners = new Set<ErrorListener>()
  private playbackListeners = new Set<(playing: boolean) => void>()
  private rafId = 0
  private objectUrl: string | null = null
  private eqEnabled = false
  private eqGains: number[] = EQ_FREQS.map(() => 0)
  private volume = 0.8
  private muted = false
  private graphFailed = false
  private playRequest = 0
  private failureReported = false

  constructor() {
    const audio = document.createElement('audio')
    audio.preload = 'metadata'
    audio.setAttribute('data-role', 'aurora-audio')
    audio.style.display = 'none'
    document.body.appendChild(audio)
    this.el = audio

    audio.addEventListener('ended', () => {
      this.updatePlayback()
      this.endedListeners.forEach((cb) => cb())
    })
    audio.addEventListener('playing', () => this.updatePlayback())
    audio.addEventListener('pause', () => this.updatePlayback())
    audio.addEventListener('error', () => {
      if (!audio.currentSrc || !audio.error) return
      this.reportFailure()
    })
  }

  /** 建立 Web Audio 图（必须由用户手势触发一次） */
  private ensureGraph(): void {
    if (this.ctx || this.graphFailed) return
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new AC()
      const source = ctx.createMediaElementSource(this.el)
      const gain = ctx.createGain()
      gain.gain.value = this.muted ? 0 : this.volume
      let node: AudioNode = source
      for (let i = 0; i < EQ_FREQS.length; i++) {
        const f = ctx.createBiquadFilter()
        f.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking'
        f.frequency.value = EQ_FREQS[i]
        f.Q.value = 1.1
        f.gain.value = this.eqEnabled ? this.eqGains[i] : 0
        node.connect(f)
        node = f
        this.filters.push(f)
      }
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.8
      node.connect(gain)
      gain.connect(analyser)
      analyser.connect(ctx.destination)
      this.ctx = ctx
      this.source = source
      this.gain = gain
      this.analyser = analyser
      // 音量和静音只由 GainNode 控制，避免与 audio 元素叠加。
      this.el.volume = 1
      this.el.muted = false
    } catch {
      this.graphFailed = true
    }
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser
  }

  getContext(): AudioContext | null {
    return this.ctx
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v))
    if (this.gain && this.ctx) {
      this.gain.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.01)
    } else {
      this.el.volume = this.volume
    }
  }

  setMuted(m: boolean): void {
    this.muted = m
    if (this.gain && this.ctx) {
      this.gain.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.01)
    } else {
      this.el.muted = m
    }
  }

  setEq(gains: number[], enabled: boolean): void {
    this.eqGains = gains.slice()
    this.eqEnabled = enabled
    if (!this.ctx) return
    this.filters.forEach((f, i) => {
      f.gain.setTargetAtTime(enabled ? (gains[i] ?? 0) : 0, this.ctx!.currentTime, 0.02)
    })
  }

  loadFile(file: File | string, autoplay = true): void {
    this.pause()
    this.failureReported = false
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = null
    }
    this.objectUrl = typeof file === 'string' ? null : URL.createObjectURL(file)
    this.el.src = typeof file === 'string' ? file : this.objectUrl!
    this.el.load()
    if (autoplay) void this.play()
  }

  async play(): Promise<void> {
    const request = ++this.playRequest
    this.failureReported = false
    this.ensureGraph()
    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume()
      } catch (error) {
        if (request === this.playRequest) this.reportFailure(error as Error)
        return
      }
    }
    if (request !== this.playRequest) return
    try {
      await this.el.play()
    } catch (error) {
      if (request !== this.playRequest) return
      this.updatePlayback()
      if ((error as Error).name !== 'AbortError') this.reportFailure(error as Error)
      return
    }
    if (request === this.playRequest) this.updatePlayback()
  }

  pause(): void {
    this.playRequest++
    this.el.pause()
    this.updatePlayback()
    this.frameListeners.forEach((cb) => cb(this.el.currentTime, this.duration))
  }

  clear(): void {
    this.pause()
    this.el.removeAttribute('src')
    this.el.load()
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl)
    this.objectUrl = null
    this.frameListeners.forEach((cb) => cb(0, 0))
  }

  private updatePlayback(): void {
    const playing = !this.el.paused && !this.el.ended
    if (playing) this.startFrames()
    else this.stopFrames()
    this.playbackListeners.forEach((cb) => cb(playing))
  }

  private reportFailure(error?: Error): void {
    if (this.failureReported) return
    this.failureReported = true
    this.pause()
    this.errorListeners.forEach((cb) => cb(error))
  }

  get paused(): boolean {
    return this.el.paused
  }

  get currentTime(): number {
    return this.el.currentTime
  }

  get duration(): number {
    const d = this.el.duration
    return isFinite(d) && d > 0 ? d : 0
  }

  seek(t: number): void {
    const dur = this.duration
    const target = Math.max(0, Math.min(dur || t, t))
    try {
      this.el.currentTime = target
    } catch {
      /* noop */
    }
    this.frameListeners.forEach((cb) => cb(target, dur))
  }

  private startFrames(): void {
    if (this.rafId) return
    const tick = () => {
      this.rafId = requestAnimationFrame(tick)
      const dur = this.duration
      const t = this.el.currentTime
      this.frameListeners.forEach((cb) => cb(t, dur))
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private stopFrames(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
  }

  onFrame(cb: FrameListener): () => void {
    this.frameListeners.add(cb)
    cb(this.el.currentTime, this.duration)
    if (!this.el.paused) this.startFrames()
    return () => {
      this.frameListeners.delete(cb)
      if (this.frameListeners.size === 0) this.stopFrames()
    }
  }

  onEnded(cb: SimpleListener): () => void {
    this.endedListeners.add(cb)
    return () => this.endedListeners.delete(cb)
  }

  onError(cb: ErrorListener): () => void {
    this.errorListeners.add(cb)
    return () => this.errorListeners.delete(cb)
  }

  onPlaybackChange(cb: (playing: boolean) => void): () => void {
    this.playbackListeners.add(cb)
    return () => this.playbackListeners.delete(cb)
  }

  syncState(playing: boolean): void {
    if (playing) this.startFrames()
    else this.stopFrames()
  }
}

export let engine: Pick<AudioEngine, keyof AudioEngine> = new AudioEngine()

/** Android supplies a system media player before the shared store is initialized. */
export function installPlaybackEngine(nativeEngine: typeof engine): void {
  engine.clear()
  engine = nativeEngine
}
