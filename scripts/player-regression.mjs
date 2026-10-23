/* Isolated player regressions: no browser, real music, user profile, or process cleanup. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const bundle = await build({
  stdin: { contents: "export { engine } from './src/lib/audio'; export { usePlayer, analyzeDurations } from './src/lib/store'; export { Spectrum } from './src/components/common'", resolveDir: root },
  bundle: true, write: false, format: 'cjs', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'isolated-library-and-storage', setup(build) {
    build.onResolve({ filter: /^react$/ }, () => ({ path: 'react-hooks', namespace: 'player-test' }));
    build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx-runtime', namespace: 'player-test' }));
    build.onLoad({ filter: /^jsx-runtime$/, namespace: 'player-test' }, () => ({ contents: 'export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx; export const Fragment = "fragment";' }));
    build.onLoad({ filter: /.*/, namespace: 'player-test' }, () => ({ contents: `
      export const useCallback = fn => fn;
      export const useRef = value => { const ref = { current: value }; globalThis.hookRefs.push(ref); return ref };
      export const useEffect = fn => globalThis.hookEffects.push(fn);
      export default { useRef, useEffect, useCallback };
    ` }));
    build.onLoad({ filter: /[/\\]idb\.ts$/ }, () => ({ contents: `
      export const DEFAULT_SETTINGS = { volume: .8, muted: false, shuffle: false, repeat: 'all', eqEnabled: false, eqGains: Array(10).fill(0), showSpectrum: true, accent: '#7c5cff', autoAnalyze: true, reducedMotion: false };
      export async function kvGet(key) { return key === 'settings' ? globalThis.savedSettings : undefined }
      export async function kvSet(key, value) { globalThis.savedValues.set(key, value) }
      export async function kvDel() {}
      export async function loadTracks() { return [] }
      export async function loadPlaylists() { return [] }
      export async function saveTracks(tracks) { globalThis.savedTracks.push(tracks) }
      export async function savePlaylists(playlists) { globalThis.savedPlaylists.push(playlists) }
    ` }));
    build.onLoad({ filter: /[/\\]library\.ts$/ }, () => ({ contents: `
      export const readDuration = file => globalThis.durationReader(file);
      export const pickDirectory = async () => ({});
      export const queryHandlePermission = async () => true;
      export const scanHandle = async () => globalThis.scanReader ? globalThis.scanReader() : globalThis.scannedTracks;
      export const filesFromInput = () => [];
      export const collectLocalAssets = () => ({ lrcMap: new Map(), coverMap: new Map() });
      export const buildTracks = async () => globalThis.scannedTracks;
      export const buildNativeTrack = async item => globalThis.nativeReader ? globalThis.nativeReader(item) : ({ id: 'native_' + item.id, nativeId: item.id, nativeModified: item.lastModified, nativeUrl: '/native-audio/' + item.id, title: item.filename, artist: 'Artist', album: 'Downloads', filename: item.filename, relPath: item.filename, size: item.size, addedAt: 1, duration: 60, analyzed: true, format: 'MP3' });
    ` }));
  } }],
})

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const blocked = () => Object.assign(new Error('Playback needs user activation'), { name: 'NotAllowedError' })

async function harness(settings = {}) {
  const timers = new Set(), frames = new Map(), files = new Map(), revoked = [], contexts = []
  const playCalls = [], playResponses = [], resumeResponses = [], documentEvents = new Map()
  let analyserReads = 0
  let sequence = 0, audio
  class MockAudio {
    listeners = new Map()
    style = {}
    src = ''
    paused = true
    ended = false
    volume = 1
    muted = false
    currentTime = 0
    duration = 120
    error = null
    get currentSrc() { return this.src }
    setAttribute() {}
    removeAttribute(name) { if (name === 'src') this.src = '' }
    addEventListener(event, cb) { this.listeners.set(event, [...(this.listeners.get(event) || []), cb]) }
    emit(event) { if (event === 'error') this.error = { code: 4 }; for (const cb of this.listeners.get(event) || []) cb() }
    load() { this.currentTime = 0; this.ended = false; this.error = null }
    pause() { this.paused = true; this.emit('pause') }
    play() {
      playCalls.push(files.get(this.src)?.name)
      const response = playResponses.shift()
      if (response) return response(this)
      this.paused = false
      this.emit('playing')
      return Promise.resolve()
    }
  }
  const node = () => ({ connect() {}, gain: { value: 1, setTargetAtTime(value) { this.value = value } }, frequency: {}, Q: {} })
  class MockAudioContext {
    state = 'suspended'
    currentTime = 0
    destination = node()
    constructor() { contexts.push(this) }
    createMediaElementSource() { return node() }
    createGain() { this.gain = node(); return this.gain }
    createBiquadFilter() { return node() }
    createAnalyser() { return { ...node(), frequencyBinCount: 1024, context: { sampleRate: 44100 }, getByteFrequencyData(data) { analyserReads++; data.fill(128) } } }
    async resume() { const response = resumeResponses.shift(); if (response) await response; this.state = 'running' }
  }
  const sandbox = {
    module: { exports: {} }, console,
    savedSettings: settings, savedValues: new Map(), savedTracks: [], savedPlaylists: [], scannedTracks: [],
    durationReader: async () => 60,
    hookRefs: [], hookEffects: [],
    getComputedStyle: () => ({ getPropertyValue: () => '#7c5cff' }),
    window: { AudioContext: MockAudioContext },
    document: {
      hidden: false,
      createElement: () => (audio = new MockAudio()), body: { appendChild() {} },
      addEventListener(event, callback) { if (!documentEvents.has(event)) documentEvents.set(event, new Set()); documentEvents.get(event).add(callback) },
      removeEventListener(event, callback) { documentEvents.get(event)?.delete(callback) },
    },
    URL: { createObjectURL(file) { const url = `blob:test-${++sequence}`; files.set(url, file); return url }, revokeObjectURL(url) { revoked.push(url); files.delete(url) } },
    requestAnimationFrame(cb) { const id = ++sequence; frames.set(id, cb); return id },
    cancelAnimationFrame(id) { frames.delete(id) },
    setTimeout(cb, ms) { const timer = setTimeout(() => { timers.delete(timer); cb() }, ms); timers.add(timer); return timer },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer) },
  }
  sandbox.exports = sandbox.module.exports
  runInNewContext(bundle.outputFiles[0].text, sandbox)
  const { engine, usePlayer: player, analyzeDurations, Spectrum } = sandbox.module.exports
  await player.getState().init()
  const tracks = ['a', 'b', 'c'].map((id) => ({ id, title: id, artist: 'Artist', album: 'Album', filename: `${id}.wav`, relPath: `${id}.wav`, size: 1, addedAt: 1, format: 'WAV', duration: 0, analyzed: false, file: { name: id } }))
  player.setState({ tracks })
  return { engine, player, analyzeDurations, Spectrum, tracks, audio, contexts, frames, playCalls, playResponses, resumeResponses, revoked, sandbox,
    get analyserReads() { return analyserReads },
    advanceFrames() { const pending = Array.from(frames.values()); frames.clear(); pending.forEach((callback) => callback()) },
    setHidden(value) { sandbox.document.hidden = value; documentEvents.get('visibilitychange')?.forEach((callback) => callback()) },
    dispose() { for (const timer of timers) clearTimeout(timer) },
  }
}

let passed = 0, failed = 0
async function test(name, fn, settings) {
  const h = await harness(settings)
  try { await fn(h); passed++; console.log(`✓ ${name}`) }
  catch (error) { failed++; console.error(`✗ ${name}: ${error.message}`) }
  finally { h.dispose() }
}

await test('Initial volume is applied once when WebAudio starts', async ({ player, audio, contexts }) => {
  player.getState().playTrack('a'); await flush()
  assert.equal(audio.volume * contexts[0].gain.gain.value, .8)
})

await test('A saved mute can be cleared after the graph starts', async ({ player, audio, contexts }) => {
  player.getState().playTrack('a'); await flush(); player.getState().toggleMute()
  assert.equal(audio.muted, false)
  assert.equal(audio.volume * contexts[0].gain.gain.value, .8)
}, { muted: true })

await test('Rejected playback stops the indicator without skipping the selected song', async ({ player, playResponses, frames }) => {
  playResponses.push(() => Promise.reject(blocked()))
  player.getState().playTrack('a'); await flush()
  assert.equal(player.getState().playing, false)
  assert.equal(player.getState().currentId, 'a')
  assert.equal(frames.size, 0)
  assert.ok(player.getState().toasts.length)
})

await test('Shuffle keeps the requested startIndex song', async ({ player }) => {
  player.getState().playQueue(['a', 'b', 'c'], 2); await flush()
  assert.equal(player.getState().currentId, 'c')
  assert.equal(player.getState().queue[player.getState().queueIndex], 'c')
}, { shuffle: true })

await test('playQueue can explicitly enable and persist shuffle', async ({ player, sandbox }) => {
  player.getState().playQueue(['a', 'b', 'c'], 1, true); await flush()
  assert.equal(player.getState().currentId, 'b')
  assert.equal(player.getState().settings.shuffle, true)
  await new Promise((resolve) => setTimeout(resolve, 380))
  assert.equal(sandbox.savedValues.get('settings').shuffle, true)
})

await test('playQueue can explicitly disable shuffle', async ({ player }) => {
  player.getState().playQueue(['a', 'b', 'c'], 1, false); await flush()
  assert.equal(player.getState().currentId, 'b')
  assert.equal(player.getState().settings.shuffle, false)
  assert.deepEqual(Array.from(player.getState().queue), ['a', 'b', 'c'])
}, { shuffle: true })

await test('Next at the end without repeat also pauses real audio', async ({ player, audio }) => {
  player.getState().playQueue(['a'], 0); await flush(); player.getState().next()
  assert.equal(player.getState().playing, false)
  assert.equal(audio.paused, true)
}, { repeat: 'off' })

await test('Removing the final queue item stops playback and clears the selection', async ({ player, audio }) => {
  player.getState().playQueue(['a'], 0); await flush(); player.getState().removeFromQueue('a')
  assert.equal(player.getState().queue.length, 0)
  assert.equal(player.getState().currentId, null)
  assert.equal(player.getState().playing, false)
  assert.equal(audio.paused, true)
})

await test('A stale AudioContext resume cannot replay a newer song', async ({ player, playCalls, resumeResponses }) => {
  const pending = deferred(); resumeResponses.push(pending.promise)
  player.getState().playTrack('a'); player.getState().playTrack('b'); await flush()
  pending.resolve(); await flush()
  assert.deepEqual(playCalls, ['b'])
})

await test('Pausing while AudioContext resumes cannot start playback later', async ({ player, engine, playCalls, resumeResponses }) => {
  const pending = deferred(); resumeResponses.push(pending.promise)
  player.getState().playTrack('a'); engine.pause(); pending.resolve(); await flush()
  assert.equal(playCalls.length, 0)
  assert.equal(player.getState().playing, false)
})

await test('An old play rejection cannot stop the current song', async ({ player, playResponses }) => {
  const pending = deferred(); playResponses.push(() => pending.promise)
  player.getState().playTrack('a'); await flush()
  player.getState().playTrack('b'); await flush()
  pending.reject(blocked()); await flush()
  assert.equal(player.getState().currentId, 'b')
  assert.equal(player.getState().playing, true)
  assert.equal(player.getState().toasts.length, 0)
})

await test('Broken tracks are skipped once, even with single-song repeat', async ({ player, audio }) => {
  player.getState().playQueue(['a', 'b'], 0); await flush()
  audio.emit('error'); await flush()
  assert.equal(player.getState().currentId, 'b')
  audio.emit('error'); await flush()
  assert.equal(player.getState().playing, false)
  assert.equal(audio.paused, true)
}, { repeat: 'one' })

await test('Duration analysis publishes batches instead of every track', async ({ player, analyzeDurations, tracks }) => {
  player.setState({ tracks: Array.from({ length: 80 }, (_, i) => ({ ...tracks[0], id: `duration-${i}`, file: { name: `duration-${i}` } })) })
  let writes = 0
  const unsubscribe = player.subscribe((state, prev) => { if (state.tracks !== prev.tracks) writes++ })
  await analyzeDurations(); unsubscribe()
  assert.ok(writes <= 5, `Expected at most 5 list updates, got ${writes}`)
  assert.ok(player.getState().tracks.every((track) => track.duration === 60 && track.analyzed))
  assert.equal(player.getState().analyzing, false)
})

await test('Clearing during analysis cancels pending writes', async ({ player, analyzeDurations, sandbox }) => {
  const pending = []
  sandbox.durationReader = () => { const item = deferred(); pending.push(item); return item.promise }
  const running = analyzeDurations(); await flush(); await player.getState().removeAll()
  assert.equal(player.getState().analyzing, false)
  const saves = sandbox.savedTracks.length
  for (const item of pending) item.resolve(60)
  await running
  assert.equal(player.getState().tracks.length, 0)
  assert.equal(sandbox.savedTracks.length, saves)
})

await test('Replacing or clearing the library releases obsolete cover URLs', async ({ player, tracks, sandbox, revoked }) => {
  player.setState({ tracks: [{ ...tracks[0], cover: 'blob:old-cover' }] })
  sandbox.scannedTracks = [{ ...tracks[1], cover: 'blob:new-cover', duration: 60, analyzed: true }]
  await player.getState().importFolder()
  assert.ok(revoked.includes('blob:old-cover'))
  await player.getState().removeAll()
  assert.ok(revoked.includes('blob:new-cover'))
})

await test('Clearing while a folder scan is running cannot restore the cleared tracks', async ({ player, tracks, sandbox, revoked }) => {
  const pending = deferred(); sandbox.scanReader = () => pending.promise
  const scanning = player.getState().importFolder(); await flush()
  await player.getState().removeAll()
  pending.resolve([{ ...tracks[0], duration: 60, analyzed: true, cover: 'blob:cancelled-cover' }])
  await scanning
  assert.equal(player.getState().tracks.length, 0)
  assert.ok(revoked.includes('blob:cancelled-cover'))
})

await test('A progress subscriber mounted while paused receives the current time', async ({ engine }) => {
  engine.el.currentTime = 42
  let time = -1
  const unsubscribe = engine.onFrame((current) => { time = current })
  unsubscribe()
  assert.equal(time, 42)
})

await test('Moving queue items preserves the current song and audio position', async ({ player, audio, playCalls }) => {
  player.getState().playQueue(['a', 'b', 'c'], 1, false); await flush()
  audio.currentTime = 42
  const source = audio.src, calls = playCalls.length
  player.getState().moveInQueue('a', 2)
  assert.deepEqual(Array.from(player.getState().queue), ['b', 'c', 'a'])
  assert.equal(player.getState().queueIndex, 0)
  player.getState().moveInQueue('b', 2)
  assert.equal(player.getState().currentId, 'b')
  assert.equal(player.getState().queue[player.getState().queueIndex], 'b')
  assert.equal(audio.src, source)
  assert.equal(audio.currentTime, 42)
  assert.equal(playCalls.length, calls)
  assert.equal(player.getState().playing, true)
})

await test('Clearing the queue stops audio while keeping the music library', async ({ player, audio, tracks }) => {
  player.getState().playQueue(['a', 'b'], 0); await flush()
  player.setState({ nowPlayingOpen: true })
  player.getState().clearQueue()
  assert.equal(player.getState().queue.length, 0)
  assert.equal(player.getState().queueIndex, 0)
  assert.equal(player.getState().currentId, null)
  assert.equal(player.getState().playing, false)
  assert.equal(player.getState().nowPlayingOpen, false)
  assert.equal(player.getState().tracks.length, tracks.length)
  assert.equal(audio.paused, true)
  assert.equal(audio.src, '')
})

await test('Spectrum stops while paused or hidden and resumes without layout writes', async (h) => {
  const bars = Array.from({ length: 16 }, () => ({ style: {} }))
  h.Spectrum({ mini: true, bars: 16 })
  h.sandbox.hookRefs[0].current = { children: bars }
  const cleanup = h.sandbox.hookEffects[0]()
  try {
    assert.equal(h.frames.size, 0, 'A paused spectrum must not request frames')
    h.player.getState().playTrack('a'); await flush(); h.advanceFrames()
    assert.ok(bars.every((bar) => bar.style.transform?.startsWith('scaleY(')))
    assert.ok(bars.every((bar) => !('height' in bar.style)))
    h.setHidden(true)
    const hiddenReads = h.analyserReads
    h.advanceFrames(); h.advanceFrames()
    assert.equal(h.analyserReads, hiddenReads, 'Hidden spectrum must not sample or draw')
    h.setHidden(false); h.advanceFrames()
    assert.ok(h.analyserReads > hiddenReads)
    h.engine.pause()
    const pausedReads = h.analyserReads
    assert.equal(h.frames.size, 0)
    h.advanceFrames()
    assert.equal(h.analyserReads, pausedReads)
    assert.ok(bars.some((bar) => bar.style.transform !== 'scaleY(0.03)'))
  } finally { cleanup() }
})

await test('AI playlist ordering persists without changing playback or its queue', async ({ player, audio, playCalls, sandbox }) => {
  player.setState({ playlists: [{ id: 'p', name: 'Scene', trackIds: ['a', 'b', 'c'], createdAt: 1 }] })
  player.getState().playQueue(['a', 'b', 'c'], 1, false); await flush()
  audio.currentTime = 42
  const source = audio.src, calls = playCalls.length
  assert.equal(player.getState().reorderPlaylist('p', ['c', 'a', 'b'], ['a', 'b', 'c']), true)
  assert.deepEqual(Array.from(player.getState().playlists[0].trackIds), ['c', 'a', 'b'])
  assert.deepEqual(Array.from(sandbox.savedPlaylists.at(-1)[0].trackIds), ['c', 'a', 'b'])
  assert.deepEqual(Array.from(player.getState().queue), ['a', 'b', 'c'])
  assert.equal(player.getState().currentId, 'b')
  assert.equal(audio.currentTime, 42); assert.equal(audio.src, source); assert.equal(playCalls.length, calls)
  player.getState().setView('playlist', 'p')
  assert.equal(player.getState().sortKey, 'playlist'); assert.equal(player.getState().sortAsc, true)
  player.getState().setView('library')
  assert.equal(player.getState().sortKey, 'addedAt'); assert.equal(player.getState().sortAsc, false)
})

await test('AI ordering rejects stale, missing, foreign and duplicate playlist members', async ({ player, sandbox }) => {
  player.setState({ playlists: [{ id: 'p', name: 'Scene', trackIds: ['a', 'b', 'c'], createdAt: 1 }] })
  for (const [target, ids, expected] of [
    ['p', ['c', 'b', 'a'], ['b', 'a', 'c']], ['p', ['a', 'b'], ['a', 'b', 'c']],
    ['p', ['a', 'b', 'd'], ['a', 'b', 'c']], ['p', ['a', 'a', 'c'], ['a', 'b', 'c']],
    ['missing', ['c', 'b', 'a'], ['a', 'b', 'c']],
  ]) assert.equal(player.getState().reorderPlaylist(target, ids, expected), false)
  assert.deepEqual(Array.from(player.getState().playlists[0].trackIds), ['a', 'b', 'c'])
  assert.equal(sandbox.savedPlaylists.length, 0)
})

await test('Settings are checkpointed before an immediate close, without waiting for the renderer debounce', async ({ player, sandbox }) => {
  let checkpoint
  sandbox.window.auroraDesktop = { settingsWrite: (value) => { checkpoint = { ...value, eqGains: value.eqGains.slice() }; return { ok: true } } }
  player.getState().updateSettings({ accent: '#6b9ff5', showSpectrum: false, autoAnalyze: false, reducedMotion: true, eqEnabled: true, eqGains: [1,2,3,4,5,6,7,8,9,10] })
  player.getState().setVolume(.31)
  assert.equal(checkpoint.accent, '#6b9ff5'); assert.equal(checkpoint.volume, .31)
  assert.equal(checkpoint.showSpectrum, false); assert.equal(checkpoint.reducedMotion, true)
  assert.equal(checkpoint.eqGains[9], 10)
  assert.equal(sandbox.savedValues.has('settings'), false, 'Native checkpoint must precede the 350ms IndexedDB write')
})

await test('Native downloads merge into the existing library exactly once without interrupting playback', async ({ player, audio, playCalls, sandbox }) => {
  const item = { id: 'a'.repeat(64), filename: 'Downloaded.mp3', size: 100, lastModified: 1 }
  sandbox.window.auroraDesktop = { nativeLibrary: async () => [item] }
  player.getState().playTrack('b'); await flush(); audio.currentTime = 42
  const calls = playCalls.length, source = audio.src
  player.setState({ favorites: ['a'], playlists: [{ id:'p', name:'Old', trackIds:['b'], createdAt:1 }] })
  await player.getState().syncNativeLibrary(); await player.getState().syncNativeLibrary()
  assert.equal(player.getState().tracks.length, 4)
  assert.equal(player.getState().tracks.filter((track) => track.nativeId).length, 1)
  assert.equal(player.getState().favorites[0], 'a'); assert.equal(player.getState().playlists[0].trackIds[0], 'b')
  assert.equal(audio.currentTime, 42); assert.equal(audio.src, source); assert.equal(playCalls.length, calls)
  assert.equal(sandbox.savedTracks.at(-1).length, 4)
  player.getState().playTrack('native_' + item.id); await flush()
  assert.equal(player.getState().playing, true); assert.equal(audio.src, '/native-audio/' + item.id)
})

await test('Local folder rescans preserve downloaded music, and missing downloads become unavailable', async ({ player, sandbox, tracks }) => {
  let entries = [{ id: 'c'.repeat(64), filename: 'Download.mp3', size: 100, lastModified: 1 }]
  sandbox.window.auroraDesktop = { nativeLibrary: async () => entries }
  await player.getState().syncNativeLibrary()
  sandbox.scannedTracks = [tracks[0]]
  await player.getState().importFolder()
  assert.equal(player.getState().tracks.length, 2)
  entries = []
  await player.getState().syncNativeLibrary()
  assert.equal(player.getState().tracks.find((track) => track.nativeId).nativeUrl, undefined)
})

await test('Clearing the library during native parsing cancels stale inserts and ignores cleared downloads', async ({ player, sandbox }) => {
  const pending = deferred()
  const item = { id: 'b'.repeat(64), filename: 'Download.mp3', size: 100, lastModified: 1 }
  sandbox.window.auroraDesktop = { nativeLibrary: async () => [item] }
  sandbox.nativeReader = () => pending.promise
  const running = player.getState().syncNativeLibrary(); await flush()
  await player.getState().removeAll()
  pending.resolve({ id:'native_'+item.id, nativeId:item.id, nativeUrl:'/native-audio/'+item.id, title:'Download' })
  await running
  assert.equal(player.getState().tracks.length, 0)
})

await test('A concurrent local-folder scan retries native parsing instead of leaving downloads unavailable', async ({ player, sandbox, tracks }) => {
  const pending = deferred(), id = 'd'.repeat(64)
  const result = { ...tracks[0], id:'native_'+id, nativeId:id, nativeModified:1, nativeUrl:'/native-audio/'+id, file:undefined, analyzed:true, duration:60 }
  let reads = 0
  sandbox.window.auroraDesktop = { nativeLibrary: async () => [{ id, filename:'New.mp3', size:100, lastModified:1 }] }
  sandbox.nativeReader = () => ++reads === 1 ? pending.promise : Promise.resolve(result)
  const syncing = player.getState().syncNativeLibrary(); await flush()
  sandbox.scannedTracks = [tracks[0]]
  await player.getState().importFolder()
  pending.resolve(result); await syncing
  assert.equal(player.getState().tracks.length,2)
  assert.equal(player.getState().tracks.find((track) => track.nativeId).nativeUrl,result.nativeUrl)
  assert.ok(reads >= 2)
})

console.log(`\nPlayer regressions: ${passed}/${passed + failed} passed`)
process.exitCode = failed ? 1 : 0
