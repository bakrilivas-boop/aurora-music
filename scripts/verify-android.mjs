import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const yauzl = require('yauzl')
const apk = path.resolve(process.argv[2] || 'release/android/1.1.0/Aurora-Music-Android-1.1.0.apk')
const bytes = await readFile(apk)
const zip = await new Promise((resolve, reject) => yauzl.open(apk, { lazyEntries: true }, (error, file) => error ? reject(error) : resolve(file)))
const entries = new Map()
await new Promise((resolve, reject) => {
  zip.on('error', reject)
  zip.on('entry', entry => {
    if (entry.fileName.endsWith('/')) { zip.readEntry(); return }
    zip.openReadStream(entry, (error, stream) => {
      if (error) { reject(error); return }
      const chunks = []
      stream.on('error', reject)
      stream.on('data', chunk => chunks.push(chunk))
      stream.on('end', () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry() })
    })
  })
  zip.on('end', resolve)
  zip.readEntry()
})
assert.ok(entries.has('assets/public/index.html'))
for (const [name, content] of entries) {
  if (name.startsWith('assets/public/assets/') || ['assets/public/index.html', 'assets/public/mobile.html'].includes(name)) {
    assert.deepEqual(content, await readFile(path.resolve('dist-mobile', name.slice('assets/public/'.length))), 'packaged web asset differs: ' + name)
  }
}
assert.ok(entries.has('assets/licenses/Apache-2.0.txt'))
assert.ok(entries.has('assets/licenses/Capacitor-MIT.txt'))
assert.ok(entries.has('assets/LICENSE.txt'))
const config = JSON.parse(entries.get('assets/capacitor.config.json'))
assert.equal(config.appId, 'com.aurora.music')
assert.equal(config.server?.url, undefined)
assert.equal(config.server.androidScheme, 'https')
assert.equal(config.android?.webContentsDebuggingEnabled, undefined)
const names = [...entries.keys()]
assert.ok(!names.some(n => /test-music|\.qa\/|\.private\/|\.jks$|signing-password|deepseek-config|node_modules|\.wav$|\.mp3$/i.test(n)))
const dex = names.filter(n => /classes\d*\.dex$/.test(n)).map(n => entries.get(n))
assert.ok(dex.some(b => b.includes(Buffer.from('Lcom/aurora/music/AuroraAudioPlugin;'))))
assert.ok(dex.some(b => b.includes(Buffer.from('Lcom/aurora/music/PlaybackService;'))))
assert.ok(dex.some(b => b.includes(Buffer.from('Lcom/aurora/music/MusicDownloadService;'))))
assert.ok(dex.some(b => b.includes(Buffer.from('Lcom/aurora/music/AuroraDownloadsPlugin;'))))
for (const [name, value] of entries) {
  if (/\.(js|json|html|txt|xml|md)$/.test(name)) assert.ok(!/sk-[a-zA-Z0-9]{20,}/.test(value.toString('utf8')), 'credential-like content: ' + name)
}
const sdk = process.env.ANDROID_HOME || path.resolve('.tools/android-sdk')
const aapt = path.join(sdk, 'build-tools/36.0.0/aapt2.exe')
const manifest = execFileSync(aapt, ['dump', 'badging', apk], { encoding: 'utf8' })
assert.ok(manifest.includes("name='com.aurora.music'"))
assert.ok(manifest.includes("versionName='1.1.0'"))
assert.ok(manifest.includes("versionCode='2'"))
assert.match(manifest, /(?:minSdkVersion|sdkVersion):'24'/)
assert.ok(manifest.includes("targetSdkVersion:'36'"))
assert.ok(!manifest.includes('application-debuggable'))
assert.ok(manifest.includes('android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK'))
assert.ok(manifest.includes('android.permission.FOREGROUND_SERVICE_DATA_SYNC'))
assert.ok(!manifest.includes('android.permission.MANAGE_EXTERNAL_STORAGE'))
console.log(JSON.stringify({ apk, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), package: 'com.aurora.music', version: '1.1.0', minSdk: 24, targetSdk: 36, debuggable: false, mediaService: true, personalMusicOrKey: false, entries: entries.size }, null, 2))
