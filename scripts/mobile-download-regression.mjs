import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
const bundle = await build({ entryPoints: ['src/mobile/downloads.ts'], bundle: true, write: false, platform: 'browser', format: 'cjs', plugins: [{ name: 'mobile-download-contract', setup(b) {
  b.onResolve({ filter: /^@capacitor\/core$/ }, () => ({ path: 'core', namespace: 'download-test' }))
  b.onResolve({ filter: /^@capacitor\/app$/ }, () => ({ path: 'app', namespace: 'download-test' }))
  b.onLoad({ filter: /.*/, namespace: 'download-test' }, a => ({ contents: a.path === 'core' ? 'export const registerPlugin = () => globalThis.bridge' : 'export const App = {addListener: async () => {}}' }))
  b.onLoad({ filter: /[/\\]store\.ts$/ }, () => ({ contents: 'export const usePlayer = {getState: () => globalThis.player}' }))
  b.onLoad({ filter: /[/\\]native\.ts$/ }, () => ({ contents: 'export const isAndroid = true; export async function importAndroid(folder, supplied, silent) {globalThis.imports.push({folder,supplied,silent}); for(const f of supplied.files) globalThis.player.tracks.push({id: "android_"+f.id}); return supplied.files.length}' }))
} }] })
const file = { id: 'abc', name: 'Test.mp3', uri: 'file:///music/abc.mp3', size: 123, relative: '下载的音乐/Test.mp3' }
const snapshot = { endpoint: 'https://music-api.gdstudio.xyz/api.php', enabled: true, jobs: [{ key: 'netease_1', source: 'netease', id: '1', title: 'Song', artist: 'Artist', status: 'complete', file }] }
const order = [], imports = []
const player = { ready: true, tracks: [{id:'existing'}], favorites:['existing'], playlists:[{id:'favorites-list'}], settings:{volume:.3}, pushToast() {} }
const bridge = { snapshot: async () => snapshot, resume: async () => {}, addListener: async () => {},
  requestNotifications: async () => order.push('notifications'), enqueue: async ({tracks}) => { order.push('enqueue'); assert.equal(tracks[0].id, '2'); return {added:1} },
  list: async () => ({ name:'Playlist', source:'netease', playlistId:'1', tracks:[], complete:true, total:0 }) }
const sandbox = { module:{exports:{}}, exports:{}, player, bridge, imports, setInterval(){}, document:{hidden:false}, setTimeout, clearTimeout, console }
runInNewContext(bundle.outputFiles[0].text, sandbox)
const downloads = sandbox.module.exports
await downloads.refreshDownloads()
assert.equal(imports.length, 1); assert.equal(imports[0].silent, true)
assert.deepEqual(player.favorites, ['existing']); assert.equal(player.tracks[0].id,'existing'); assert.equal(player.settings.volume,.3)
console.log('PASS completed native files auto-merge without changing existing library, playlists or settings')
await downloads.refreshDownloads(); assert.equal(imports.length, 1)
console.log('PASS repeated native snapshots never import a completed song twice')
snapshot.jobs.push({ key:'netease_3', source:'netease', id:'3', status:'failed', file:{...file,id:'failed'} })
await downloads.refreshDownloads(); assert.equal(imports.length, 1)
console.log('PASS failed or cancelled downloads are not imported as music')
await downloads.enqueueDownloads([{id:'2',source:'netease',title:'Second',artist:'Artist',duration:60}])
assert.deepEqual(order, ['notifications','enqueue'])
console.log('PASS enqueue requests notification access before starting the native queue')
await downloads.readOnlinePlaylist('https://music.163.com/playlist?id=1')
assert.equal(downloads.useDownloads.getState().playlist.name, 'Playlist'); assert.equal(downloads.useDownloads.getState().reading,false)
bridge.list = async () => { throw new Error('平台暂不可用') }
await assert.rejects(downloads.readOnlinePlaylist('https://music.163.com/playlist?id=1'), /平台暂不可用/)
assert.equal(downloads.useDownloads.getState().reading,false); assert.match(downloads.useDownloads.getState().error,/平台暂不可用/)
console.log('PASS playlist errors release the read state and expose a useful retry message')
console.log('Mobile download regressions: 5/5 passed (native bridge mocked)')
