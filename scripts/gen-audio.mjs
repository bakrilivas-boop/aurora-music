/* 生成测试用 WAV 音频（仅用于开发期验证，不参与交付） */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SR = 22050
const DIR = resolve(process.argv[2] || 'public/test-music')
mkdirSync(DIR, { recursive: true })

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    data.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(SR, 24)
  h.writeUInt32LE(SR * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

/** 简单旋律合成：五声音阶 + 泛音 + ADSR */
function makeSong(notes, seconds = 9, gain = 0.32) {
  const n = Math.floor(SR * seconds)
  const out = new Float32Array(n)
  const noteDur = seconds / notes.length
  notes.forEach((freq, i) => {
    const start = Math.floor(i * noteDur * SR)
    const len = Math.floor(noteDur * SR)
    for (let k = 0; k < len; k++) {
      const t = k / SR
      const env = Math.min(1, k / (SR * 0.02)) * Math.exp(-t * 2.2)
      const s =
        Math.sin(2 * Math.PI * freq * t) * 0.6 +
        Math.sin(2 * Math.PI * freq * 2 * t) * 0.24 +
        Math.sin(2 * Math.PI * freq * 3 * t) * 0.1 +
        Math.sin(2 * Math.PI * freq * 0.5 * t) * 0.18
      const idx = start + k
      if (idx < n) out[idx] += s * env * gain
    }
  })
  // 轻微立体感：加一点延迟回声
  const delay = Math.floor(SR * 0.11)
  for (let i = delay; i < n; i++) out[i] += out[i - delay] * 0.16
  return out
}

const A4 = 440
const st = (semi) => A4 * Math.pow(2, semi / 12)

const songs = [
  {
    name: '林深 - 夜航.wav',
    notes: [st(-9), st(-5), st(-2), st(0), st(-2), st(-5), st(-7), st(-9)],
    lrc: '[00:00.00]夜色从舷窗漫进来\n[00:03.20]云层之上没有风的形状\n[00:06.40]我把耳机调到最亮\n[00:08.60]让频率替我记住这一程',
  },
  {
    name: '海雾 - 潮汐.wav',
    notes: [st(-12), st(-9), st(-7), st(-4), st(-7), st(-9), st(-12), st(-14)],
    lrc: '[00:00.00]潮水退去的时候\n[00:03.50]沙滩上留下整片星空\n[00:07.00]我数着浪的节拍',
  },
  {
    name: '夏至 - 橘子汽水.wav',
    notes: [st(0), st(2), st(4), st(7), st(4), st(2), st(0), st(-3)],
    lrc: null,
  },
  {
    name: 'Nova - Aurora.wav',
    notes: [st(-2), st(3), st(5), st(7), st(10), st(7), st(5), st(3)],
    lrc: '[00:00.00]Lights above the polar night\n[00:03.10]Green and violet rivers in the sky\n[00:06.20]We are only passing through',
  },
  {
    name: '陈默 - 城市清晨.wav',
    notes: [st(-7), st(-4), st(-2), st(0), st(2), st(0), st(-2), st(-4)],
    lrc: null,
  },
]

for (const s of songs) {
  const sec = 9
  const buf = wav(makeSong(s.notes, sec))
  writeFileSync(resolve(DIR, s.name), buf)
  if (s.lrc) writeFileSync(resolve(DIR, s.name.replace(/\.wav$/, '.lrc')), s.lrc, 'utf8')
  console.log(`✓ ${s.name}  ${(buf.length / 1024).toFixed(0)}KB  ${s.lrc ? '+lrc' : ''}`)
}
console.log(`\n输出目录: ${DIR}  (${songs.length} 首)`)
