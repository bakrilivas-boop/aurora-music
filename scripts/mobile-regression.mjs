/** Android adapter contract checks: no device, network, real songs or credentials. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'

const bundle = await build({ entryPoints: ['src/mobile/native.ts'], bundle: true, write: false, format: 'cjs', platform: 'browser', plugins: [{ name: 'android-contract', setup(b) {
  b.onLoad({ filter: /[/\\]store\.ts$/ }, () => ({ contents: 'export const usePlayer = globalThis.store' }))
  b.onLoad({ filter: /[/\\]audio\.ts$/ }, () => ({ contents: 'export let engine = {el: {}}; export const installPlaybackEngine = e => { engine = globalThis.engine = e }' }))
  b.onLoad({ filter: /[/\\]idb\.ts$/ }, () => ({ contents: 'export const saveTracks = async tracks => { globalThis.persisted = structuredClone(tracks) }' }))
  b.onResolve({ filter: /^@capacitor\/core$/ }, () => ({ path: 'core', namespace: 'fake-cap' }))
  b.onResolve({ filter: /^@capacitor\/app$/ }, () => ({ path: 'app', namespace: 'fake-cap' }))
  b.onLoad({ filter: /.*/, namespace: 'fake-cap' }, a => ({ contents: a.path === 'core' ? 'export const Capacitor = {getPlatform: () => "android", convertFileSrc: s => "https://localhost/_capacitor_file_"+s.slice(7)}; export const registerPlugin = () => globalThis.bridge' : 'export const App = {addListener: async () => {}}' }))
} }] })
function wav() {
  const bytes = Buffer.alloc(48)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(40, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(4, 40)
  return bytes
}
const assets = [
  { id: 'a'.repeat(64), name: '歌手 - 夜航.wav', relative: 'Album/歌手 - 夜航.wav', bytes: wav() },
  { id: 'b'.repeat(64), name: '歌手 - 夜航.lrc', relative: 'Album/歌手 - 夜航.lrc', bytes: Buffer.from('\ufeff[00:00.00]一起听晚风') },
  { id: 'c'.repeat(64), name: 'cover.png', relative: 'Album/cover.png', bytes: Buffer.from('image fixture') },
  { id: 'd'.repeat(64), name: '另一个人 - 白天.wav', relative: 'Other/另一个人 - 白天.wav', bytes: wav() },
].map(a => ({ ...a, uri: 'file:///data/user/0/com.aurora.music/files/music/' + a.id + '.' + a.name.split('.').pop(), size: a.bytes.length }))
let changes = [], listeners = {}, polls = [], queueCalls = [], controls = []
const state = { tracks: [], ready: false, queue: [], currentId: null, settings: { volume: .8, repeat: 'all', muted: false }, pushToast() {}, addHistory() {} }
const store = { getState: () => state, setState: patch => { const old = { ...state }; Object.assign(state, patch); changes.forEach(cb => cb(state, old)) }, subscribe: cb => changes.push(cb) }
const bridge = {
  pick: async () => ({ files: assets }),
  readRange: async ({uri, start, length}) => ({ data: assets.find(a => a.uri === uri).bytes.subarray(start, start + length).toString('base64') }),
  artwork: async () => { throw new Error('fixture has no embedded image') },
  queue: async args => queueCalls.push(args), control: async args => controls.push(args),
  state: async () => ({ id: '', playing: false, position: 0, duration: 0 }),
  addListener: async (name, cb) => { listeners[name] = cb; return { remove: async () => {} } },
}
const sandbox = { module: { exports: {} }, exports: {}, store, bridge, TextDecoder, TextEncoder, URL, Blob, Uint8Array, ArrayBuffer, DataView,
  structuredClone, atob, btoa, console, document: { hidden: false, addEventListener() {} }, window: { dispatchEvent() {} },
  setInterval: cb => polls.push(cb), setTimeout, clearTimeout }
runInNewContext(bundle.outputFiles[0].text, sandbox)
const mobile = sandbox.module.exports
await mobile.importAndroid(true)
assert.equal(state.tracks.length, 2)
const night = state.tracks.find(t => t.title === '夜航')
assert.ok(night.mobileLyrics.includes('一起听晚风'))
assert.ok(night.cover.endsWith('.png'))
assert.equal(state.tracks.find(t => t.title === '白天').cover, undefined)
console.log('PASS folder import pairs sidecars in the same directory and preserves Unicode lyrics')
await mobile.importAndroid(true)
assert.equal(state.tracks.length, 2)
assert.equal(new Set(state.tracks.map(t => t.id)).size, 2)
console.log('PASS repeated imports merge without duplicating existing music')
const checkpoint = structuredClone(night); delete checkpoint.nativeUrl; delete checkpoint.cover; delete checkpoint.embeddedLyrics
const restored = mobile.restoreMobileTrack(checkpoint)
assert.equal(restored.embeddedLyrics, night.embeddedLyrics)
assert.equal(restored.nativeUrl, night.nativeUrl)
assert.equal(restored.cover, night.cover)
console.log('PASS Android private file URLs, cover and lyrics restore from saved metadata')
mobile.initializeMobile()
state.queue = state.tracks.map(t => t.id); state.currentId = night.id
sandbox.engine.loadFile(night.nativeUrl, true)
await new Promise(r => setTimeout(r, 0))
assert.equal(queueCalls.length, 1)
assert.equal(queueCalls[0].items.length, 2)
assert.equal(queueCalls[0].repeat, 'all')
assert.ok(queueCalls[0].items.every(t => t.uri.startsWith('file:///')))
console.log('PASS entire native queue is handed to Android, independent of JavaScript timers')
let changesInPlayback = 0
sandbox.engine.onPlaybackChange(() => changesInPlayback++)
listeners.playback({ id: night.id, playing: true, position: 1, duration: 60 })
listeners.playback({ id: night.id, playing: true, position: 2, duration: 60 })
assert.equal(changesInPlayback, 1)
const next = state.tracks.find(t => t.id !== night.id)
listeners.playback({ id: next.id, playing: true, position: 0, duration: 60 })
assert.equal(state.currentId, next.id)
assert.equal(queueCalls.length, 1)
console.log('PASS progress does not rerender playback state; native track advancement updates UI without reloading audio')
const oldCount = state.tracks.length
bridge.pick = async () => ({ files: [], cancelled: true })
await mobile.importAndroid(false)
assert.equal(state.tracks.length, oldCount)
assert.equal(state.scanning, false)
console.log('PASS canceling file selection keeps the library and clears the import indicator')
console.log('Android adapter regressions: 6/6 passed (native bridge mocked)')
