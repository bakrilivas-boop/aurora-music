import { useEffect, useRef, useState } from 'react'
import { EQ_FREQS, EQ_LABELS, EQ_PRESETS, engine } from '../lib/audio'
import { usePlayer } from '../lib/store'
import { IconClose, IconEq, IconRefresh, IconSpark, IconTrash } from './Icons'

const THEME_COLORS = [
  { color: '#39c5b6', label: '海盐青' },
  { color: '#6b9ff5', label: '远山蓝' },
  { color: '#a291ff', label: '暮光紫' },
  { color: '#e8a76b', label: '琥珀橙' },
  { color: '#e47f9a', label: '玫瑰粉' },
]

export function SettingsModal() {
  const open = usePlayer((s) => s.settingsOpen)
  const toggleSettings = usePlayer((s) => s.toggleSettings)
  const settings = usePlayer((s) => s.settings)
  const updateSettings = usePlayer((s) => s.updateSettings)
  const removeAll = usePlayer((s) => s.removeAll)
  const rescan = usePlayer((s) => s.rescan)
  const tracks = usePlayer((s) => s.tracks)
  const hasHandle = usePlayer((s) => s.hasHandle)
  const pushToast = usePlayer((s) => s.pushToast)
  const dialogRef = useRef<HTMLDivElement>(null)
  const [section, setSection] = useState('preferences')

  useEffect(() => {
    const show = () => { setSection('equalizer'); toggleSettings(true) }
    window.addEventListener('aurora:equalizer-open', show)
    return () => window.removeEventListener('aurora:equalizer-open', show)
  }, [toggleSettings])

  useEffect(() => {
    document.documentElement.dataset.reducedMotion = String(settings.reducedMotion)
  }, [settings.reducedMotion])

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    dialog?.querySelector<HTMLButtonElement>('button')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        toggleSettings(false)
      }
      if (e.key !== 'Tab' || !dialog) return
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')).filter((control) => control.getClientRects().length > 0)
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [open, toggleSettings])

  if (!open) return null

  const setBand = (index: number, gain: number) => {
    const next = settings.eqGains.slice()
    next[index] = gain
    updateSettings({ eqGains: next, eqEnabled: true })
    engine.setEq(next, true)
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && toggleSettings(false)}>
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-label="设置">
        <div className="modal-head">
          <IconSpark size={17} />
          <h3>设置</h3>
          <button className="ctrl" style={{ marginLeft: 'auto' }} onClick={() => toggleSettings(false)} title="关闭">
            <IconClose size={16} />
          </button>
        </div>

        <nav className="settings-nav" aria-label="设置分类">{[
          ['preferences', '外观与播放'], ['equalizer', '均衡器'], ['library', '音乐库'], ['about', '快捷键与关于'],
        ].map(([key, label]) => <button key={key} aria-pressed={section === key} onClick={() => setSection(key)}>{label}</button>)}</nav>

        <div className="modal-body">
          <p className="settings-save-note"><span className="status-dot" />所有更改自动保存，下次打开继续使用</p>
          <section className="settings-section" hidden={section !== 'preferences'}>
          <div className="setting-group">
            <h4>外观与动效</h4>
            <div className="setting-row">
              <div className="sr-text"><div className="sr-title">主题强调色</div><div className="sr-desc">让界面带一点你的偏好</div></div>
              <div className="theme-colors" role="group" aria-label="主题强调色">
                {THEME_COLORS.map(({ color, label }) => <button key={color} className={`theme-swatch${settings.accent === color ? ' selected' : ''}`} style={{ backgroundColor: color }} aria-label={label} aria-pressed={settings.accent === color} title={label} onClick={() => updateSettings({ accent: color })}>{settings.accent === color && <span aria-hidden="true">✓</span>}</button>)}
              </div>
            </div>
            <div className="setting-row">
              <div className="sr-text"><div className="sr-title">减弱动态效果</div><div className="sr-desc">减少过渡与装饰动画，系统的减少动态偏好也会生效</div></div>
              <button className={`switch${settings.reducedMotion ? ' on' : ''}`} role="switch" aria-checked={settings.reducedMotion} aria-label="减弱动态效果" onClick={() => updateSettings({ reducedMotion: !settings.reducedMotion })} />
            </div>
          </div>
          <div className="setting-group">
            <h4>播放与显示</h4>
            {window.auroraDesktop?.metadata && <div className="setting-row">
              <div className="sr-text"><div className="sr-title">自动补全封面与歌词</div><div className="sr-desc">播放时仅发送歌名、歌手与时长查询音乐资料，结果缓存在本机</div></div>
              <button className={`switch${settings.autoMetadata ? ' on' : ''}`} role="switch" aria-checked={settings.autoMetadata} aria-label="自动补全封面与歌词" onClick={() => updateSettings({ autoMetadata: !settings.autoMetadata })} />
            </div>}
            <div className="setting-row">
              <div className="sr-text">
                <div className="sr-title">实时频谱</div>
                <div className="sr-desc">在播放条与正在播放页显示频谱可视化</div>
              </div>
              <button
                className={`switch${settings.showSpectrum ? ' on' : ''}`}
                onClick={() => updateSettings({ showSpectrum: !settings.showSpectrum })}
                aria-label="实时频谱"
                role="switch"
                aria-checked={settings.showSpectrum}
              />
            </div>
            <div className="setting-row">
              <div className="sr-text">
                <div className="sr-title">后台补全时长</div>
                <div className="sr-desc">对没有时长信息的曲目自动读取（会依次读取文件元数据）</div>
              </div>
              <button
                className={`switch${settings.autoAnalyze ? ' on' : ''}`}
                onClick={() => updateSettings({ autoAnalyze: !settings.autoAnalyze })}
                aria-label="后台补全时长"
                role="switch"
                aria-checked={settings.autoAnalyze}
              />
            </div>
            <div className="setting-row">
              <div className="sr-text">
                <div className="sr-title">默认音量</div>
                <div className="sr-desc">当前 {Math.round(settings.volume * 100)}%</div>
              </div>
              <div className="range-row">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(settings.volume * 100)}
                  aria-label="音量"
                  onChange={(e) => updateSettings({ volume: Number(e.target.value) / 100, muted: false })}
                />
              </div>
            </div>
          </div>

          </section>
          <section className="settings-section" hidden={section !== 'equalizer'}>
          <div className="setting-group">
            <h4 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <IconEq size={13} /> 十段均衡器
              <button
                className={`switch${settings.eqEnabled ? ' on' : ''}`}
                style={{ marginLeft: 'auto' }}
                onClick={() => updateSettings({ eqEnabled: !settings.eqEnabled })}
                aria-label="均衡器开关"
                role="switch"
                aria-checked={settings.eqEnabled}
              />
            </h4>

            <div className="preset-row">
              {EQ_PRESETS.map((p) => (
                <button
                  key={p.name}
                  className={`chip${settings.eqGains.every((g, i) => Math.abs(g - p.gains[i]) < 0.01) && settings.eqEnabled ? ' active' : ''}`}
                  onClick={() => {
                    updateSettings({ eqGains: p.gains.slice(), eqEnabled: true })
                    engine.setEq(p.gains, true)
                  }}
                >
                  {p.name}
                </button>
              ))}
            </div>

            <div className="eq-bands">
              {EQ_FREQS.map((f, i) => (
                <div className="eq-band" key={f}>
                  <span className="eq-val">
                    {(settings.eqGains[i] ?? 0) > 0 ? '+' : ''}
                    {settings.eqGains[i] ?? 0}
                  </span>
                  <div className="slider-box">
                    <input
                      type="range"
                      min={-12}
                      max={12}
                      step={0.5}
                      value={settings.eqGains[i] ?? 0}
                      aria-label={`${EQ_LABELS[i]} 增益`}
                      onChange={(e) => setBand(i, Number(e.target.value))}
                    />
                  </div>
                  <span className="eq-freq">{EQ_LABELS[i]}</span>
                </div>
              ))}
            </div>
            <div className="empty-hint" style={{ fontSize: 11 }}>
              拖动滑块即时生效；预设会同时开启均衡器。
            </div>
          </div>

          </section>
          <section className="settings-section" hidden={section !== 'library'}>
          <div className="setting-group">
            <h4>音乐库</h4>
            <div className="setting-row">
              <div className="sr-text">
                <div className="sr-title">曲目数量</div>
                <div className="sr-desc">{tracks.length} 首 · 数据仅保存在本机</div>
              </div>
              <button
                className="btn"
                onClick={() => {
                  void rescan()
                  toggleSettings(false)
                  pushToast('正在重新扫描文件夹', 'info')
                }}
                disabled={!hasHandle}
              >
                <IconRefresh size={14} /> 重新扫描
              </button>
            </div>
            <div className="setting-row">
              <div className="sr-text">
                <div className="sr-title">清空音乐库</div>
                <div className="sr-desc">移除曲目、收藏与播放历史（不会删除磁盘文件）</div>
              </div>
              <button
                className="btn"
                style={{ color: 'var(--danger)' }}
                onClick={() => {
                  if (confirm('确定清空音乐库？不会删除磁盘上的文件。')) {
                    void removeAll()
                    toggleSettings(false)
                  }
                }}
              >
                <IconTrash size={14} /> 清空
              </button>
            </div>
          </div>

          </section>
          <section className="settings-section" hidden={section !== 'about'}>
          <div className="setting-group">
            <h4>键盘快捷键</h4>
            <div className="setting-row" style={{ flexWrap: 'wrap', gap: '8px 18px' }}>
              {[
                ['空格', '播放 / 暂停'],
                ['← →', '快退 / 快进 5 秒'],
                ['↑ ↓', '音量增减'],
                ['L', '歌词页'],
                ['M', '静音'],
                ['S', '随机播放'],
                ['F', '收藏当前曲目'],
                ['Ctrl + F', '搜索'],
                ['Ctrl + K', 'AI 点歌与歌单'],
              ].map(([k, v]) => (
                <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12 }}>
                  <kbd className="kbd">{k}</kbd>
                  <span style={{ color: 'var(--text-3)' }}>{v}</span>
                </span>
              ))}
            </div>
          </div>

          <div className="setting-group">
            <h4>关于</h4>
            <div className="setting-row">
              <div className="sr-text">
                <div className="sr-title">Aurora Music 1.6</div>
                <div className="sr-desc">
                  本地音乐播放器 · 支持 ID3v2 / FLAC / M4A 标签、内嵌封面与 LRC 歌词 · Web Audio 十段均衡器 · 歌单下载支持官方音源与备用解析
                </div>
              </div>
            </div>
          </div>
          </section>
        </div>
      </div>
    </div>
  )
}
