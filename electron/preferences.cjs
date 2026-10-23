const fs = require('node:fs')
const path = require('node:path')

function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置格式无效')
  const value = {}
  for (const key of ['muted', 'shuffle', 'eqEnabled', 'showSpectrum', 'autoAnalyze', 'reducedMotion', 'autoMetadata']) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') throw new Error('设置值无效')
      value[key] = input[key]
    }
  }
  if (input.volume !== undefined) {
    if (!Number.isFinite(input.volume) || input.volume < 0 || input.volume > 1) throw new Error('音量设置无效')
    value.volume = input.volume
  }
  if (input.repeat !== undefined) {
    if (!['off', 'all', 'one'].includes(input.repeat)) throw new Error('循环设置无效')
    value.repeat = input.repeat
  }
  if (input.accent !== undefined) {
    if (typeof input.accent !== 'string' || !/^#[\da-f]{6}$/i.test(input.accent)) throw new Error('主题颜色无效')
    value.accent = input.accent
  }
  if (input.eqGains !== undefined) {
    if (!Array.isArray(input.eqGains) || input.eqGains.length !== 10 || input.eqGains.some((n) => !Number.isFinite(n) || n < -12 || n > 12)) throw new Error('均衡器设置无效')
    value.eqGains = input.eqGains.slice()
  }
  return value
}

function createPreferences(filePath) {
  let value = {}
  let timer
  let dirty = false
  try { value = validateSettings(JSON.parse(fs.readFileSync(filePath, 'utf8'))) } catch { /* Migrate the renderer's existing settings on first use. */ }
  const flush = () => {
    clearTimeout(timer)
    if (!dirty) return
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath + '.tmp', JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(filePath + '.tmp', filePath)
    dirty = false
  }
  return {
    read: () => structuredClone(value),
    save(input) {
      const next = validateSettings(input)
      value = { ...value, ...next }
      dirty = true
      clearTimeout(timer)
      timer = setTimeout(() => { try { flush() } catch { /* Keep dirty; retry on the next change or controlled exit. */ } }, 150)
      return { ok: true }
    },
    flush,
  }
}
module.exports = { createPreferences, validateSettings }
