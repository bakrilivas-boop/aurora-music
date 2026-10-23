import { useCallback, useEffect, useRef } from 'react'
import { engine } from '../lib/audio'
import { IconMusic } from './Icons'
import type { Track } from '../lib/types'

/** 订阅音频帧（零 React 重渲染） */
export function useEngineFrame(cb: (time: number, duration: number) => void) {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => engine.onFrame((t, d) => ref.current(t, d)), [])
}

export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function Cover({
  src,
  className,
  iconSize = 18,
  onClick,
  title,
}: {
  src?: string
  className: string
  iconSize?: number
  onClick?: () => void
  title?: string
}) {
  const style = src ? { backgroundImage: `url("${src.replace(/"/g, '%22')}")` } : undefined
  return (
    <div className={className} style={style} onClick={onClick} title={title}>
      {!src && <IconMusic size={iconSize} />}
      {src && onClick ? (
        <div className="expand-hint">
          <IconMusic size={16} />
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------ 进度条 ------------------------------ */

export function ProgressBar({
  className = 'progress-rail',
  trackClass = 'progress-track',
  fillClass = 'progress-fill',
  thumbClass = 'progress-thumb',
  showBuffer = true,
}: {
  className?: string
  trackClass?: string
  fillClass?: string
  thumbClass?: string
  showBuffer?: boolean
}) {
  const railRef = useRef<HTMLDivElement>(null)
  const fillRef = useRef<HTMLDivElement>(null)
  const bufferRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const lastPercent = useRef(-1)

  const paint = useCallback((ratio: number) => {
    const pct = `${Math.max(0, Math.min(1, ratio)) * 100}%`
    if (fillRef.current) fillRef.current.style.width = pct
    if (thumbRef.current) thumbRef.current.style.left = pct
    const percent = Math.round(Math.max(0, Math.min(1, ratio)) * 100)
    if (percent !== lastPercent.current) {
      lastPercent.current = percent
      railRef.current?.setAttribute('aria-valuenow', String(percent))
      railRef.current?.setAttribute('aria-valuetext', fmtTime(ratio * engine.duration))
    }
  }, [])

  useEngineFrame((t, d) => {
    if (dragging.current) return
    paint(d > 0 ? t / d : 0)
    if (bufferRef.current) {
      const b = engine.el.buffered
      if (b.length && d > 0) {
        const end = b.end(b.length - 1)
        bufferRef.current.style.width = `${Math.min(100, (end / d) * 100)}%`
      }
    }
  })

  const ratioFromEvent = (clientX: number) => {
    const rail = railRef.current
    if (!rail) return 0
    const rect = rail.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }

  const handleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    try {
      ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    } catch {
      /* 合成事件或浏览器不支持时忽略 */
    }
    dragging.current = true
    paint(ratioFromEvent(e.clientX))
  }

  const handleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    paint(ratioFromEvent(e.clientX))
  }

  const handleUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = false
    const ratio = ratioFromEvent(e.clientX)
    const d = engine.duration
    if (d > 0) engine.seek(ratio * d)
    paint(ratio)
  }

  return (
    <div
      className={className}
      ref={railRef}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={() => {
        dragging.current = false
      }}
      role="slider"
      aria-label="播放进度"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={0}
      tabIndex={0}
      onKeyDown={(e) => {
        if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'ArrowRight') engine.seek(engine.currentTime + 5)
        else if (e.key === 'ArrowLeft') engine.seek(Math.max(0, engine.currentTime - 5))
        else engine.seek(e.key === 'Home' ? 0 : engine.duration)
      }}
    >
      <div className={trackClass}>
        {showBuffer && <div className="progress-buffer" ref={bufferRef} />}
        <div className={fillClass} ref={fillRef} />
      </div>
      <div className={thumbClass} ref={thumbRef} />
    </div>
  )
}

export function CurrentTime({ className = 'time' }: { className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEngineFrame((t) => {
    if (ref.current) ref.current.textContent = fmtTime(t)
  })
  return <span className={className} ref={ref}>0:00</span>
}

export function TotalTime({ track, className = 'time' }: { track: Track | null; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.textContent = fmtTime(track?.duration || 0)
  }, [track?.duration, track?.id])
  return <span className={className} ref={ref}>{fmtTime(track?.duration || 0)}</span>
}

/* ------------------------------ 音量 ------------------------------ */

export function VolumeSlider({
  value,
  onLive,
  onCommit,
}: {
  value: number
  onLive: (v: number) => void
  onCommit: (v: number) => void
}) {
  const railRef = useRef<HTMLDivElement>(null)
  const fillRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const paint = useCallback((v: number) => {
    if (fillRef.current) fillRef.current.style.width = `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`
  }, [])

  useEffect(() => {
    if (!dragging.current) paint(value)
  }, [value, paint])

  const ratioFromEvent = (clientX: number) => {
    const rail = railRef.current
    if (!rail) return 0
    const rect = rail.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }

  return (
    <div
      className="volume-rail"
      role="slider"
      aria-label="音量"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      tabIndex={0}
      onKeyDown={(e) => {
        const steps: Record<string, number> = { ArrowLeft: -0.05, ArrowDown: -0.05, ArrowRight: 0.05, ArrowUp: 0.05 }
        if (!(e.key in steps) && e.key !== 'Home' && e.key !== 'End') return
        e.preventDefault()
        e.stopPropagation()
        onCommit(e.key === 'Home' ? 0 : e.key === 'End' ? 1 : Math.max(0, Math.min(1, value + steps[e.key])))
      }}
      ref={railRef}
      onPointerDown={(e) => {
        e.preventDefault()
        ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
        dragging.current = true
        const v = ratioFromEvent(e.clientX)
        paint(v)
        onLive(v)
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return
        const v = ratioFromEvent(e.clientX)
        paint(v)
        onLive(v)
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return
        dragging.current = false
        onCommit(ratioFromEvent(e.clientX))
      }}
      onPointerCancel={(e) => {
        if (!dragging.current) return
        dragging.current = false
        onCommit(ratioFromEvent(e.clientX))
      }}
    >
      <div className="volume-track">
        <div className="volume-fill" ref={fillRef} style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
    </div>
  )
}

/* ------------------------------ 频谱 ------------------------------ */

export function Spectrum({ height = 96, mini = false, bars = 56 }: { height?: number; mini?: boolean; bars?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let raf = 0
    const data = new Uint8Array(1024)
    const smooth = new Float32Array(bars)
    // 对数频率映射：45Hz → 16kHz，覆盖真实音乐的整个频段
    const LO = 45
    const HI = 16000
    const RATIO = HI / LO
    let bins = data.length
    let binHz = 22050 / data.length
    const binFor = (pos: number, n: number) => {
      const p = pos < 0 ? 0 : pos > 1 ? 1 : pos
      const f = LO * Math.pow(RATIO, p)
      return Math.min(n - 1, Math.max(1, Math.round(f / binHz)))
    }
    let accent = '#7c5cff'
    let accent2 = '#00d4ff'
    let grad: CanvasGradient | null = null
    let gradKey = ''
    let tick = 0

    const readAccent = () => {
      const cs = getComputedStyle(document.documentElement)
      accent = cs.getPropertyValue('--accent').trim() || '#7c5cff'
      accent2 = cs.getPropertyValue('--accent-2').trim() || '#00d4ff'
    }
    readAccent()

    const draw = () => {
      const analyser = engine.getAnalyser()
      if (analyser) {
        analyser.getByteFrequencyData(data)
        const nb = Math.min(analyser.frequencyBinCount, data.length)
        if (nb > 1) {
          bins = nb
          binHz = analyser.context.sampleRate / 2 / nb
        }
      } else data.fill(0)

      if (mini) {
        const host = ref.current
        if (!host) return
        const kids = host.children
        for (let i = 0; i < kids.length; i++) {
          const v = (data[binFor((i + 1) / kids.length, bins)] || 0) / 255
          smooth[i] = smooth[i] * 0.72 + v * 0.28
          ;(kids[i] as HTMLElement).style.transform = `scaleY(${Math.max(0.03, smooth[i])})`
        }
        return
      }

      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      const barW = w / bars
      // 画布过窄时不绘制，避免出现负宽度/负圆角
      if (!(w > 12) || !(h > 12) || barW < 1.2) {
        ctx.globalAlpha = 1
        return
      }
      const gap = Math.min(barW * 0.34, barW * 0.62)
      const bw = Math.max(1, barW - gap)
      // 渐变按画布坐标建立一次即可复用；每 90 帧同步一次主色（用户可改主题色）
      if (++tick % 90 === 0) readAccent()
      const key = `${w}x${h}:${accent}:${accent2}`
      if (!grad || gradKey !== key) {
        grad = ctx.createLinearGradient(0, h, 0, 0)
        grad.addColorStop(0, accent)
        grad.addColorStop(1, accent2)
        gradKey = key
      }
      ctx.fillStyle = grad

      for (let i = 0; i < bars; i++) {
        const v = (data[binFor((i + 0.5) / bars, bins)] || 0) / 255
        smooth[i] = smooth[i] * 0.7 + v * 0.3
        const bh = Math.max(2.5, smooth[i] * h * 0.94)
        const x = i * barW + gap / 2
        ctx.globalAlpha = 0.16 + smooth[i] * 0.84
        const r = Math.max(0, Math.min(bw / 2, 3))
        ctx.beginPath()
        ctx.roundRect(x, h - bh, bw, bh, [r, r, 0, 0])
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }
    const loop = () => {
      raf = 0
      if (document.hidden || engine.paused) return
      draw()
      raf = requestAnimationFrame(loop)
    }
    const sync = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      if (document.hidden) return
      draw()
      if (!engine.paused) raf = requestAnimationFrame(loop)
    }
    const stopPlayback = engine.onPlaybackChange(sync)
    document.addEventListener('visibilitychange', sync)
    sync()
    return () => {
      if (raf) cancelAnimationFrame(raf)
      stopPlayback()
      document.removeEventListener('visibilitychange', sync)
    }
  }, [bars, mini])

  if (mini) {
    return (
      <div className="mini-spectrum" ref={ref}>
        {Array.from({ length: bars }).map((_, i) => (
          <i key={i} style={{ transform: 'scaleY(0.12)' }} />
        ))}
      </div>
    )
  }

  return <canvas className="np-spectrum" ref={canvasRef} style={{ height }} />
}
