import assert from 'node:assert/strict'
import { build } from 'esbuild'
await build({ entryPoints: ['src/lib/metadata.ts'], bundle: true, platform: 'node', format: 'esm', outfile: '.tmp/metadata-merge.mjs' })
const { mergeMetadata } = await import('../.tmp/metadata-merge.mjs')
const track = { id: 'test', title: 'Test', artist: 'Artist' }
const online = { matched: true, cover: 'data:image/png;base64,AQID', lyrics: '[00:01.00]test' }
assert.equal(mergeMetadata(track, { ...online, matched: false }), track)
assert.equal(mergeMetadata(track, online).embeddedLyrics, online.lyrics)
assert.equal(mergeMetadata(track, { ...online, cover: 'https://evil.invalid/image.png' }).cover, undefined)
assert.equal(mergeMetadata(track, { ...online, cover: 'data:image/svg+xml;base64,AQID' }).cover, undefined)
const local = { ...track, cover: 'blob:local', embeddedLyrics: 'local' }
assert.equal(mergeMetadata(local, online), local)
assert.equal(mergeMetadata({ ...track, embeddedLyrics: '  ' }, online).embeddedLyrics, online.lyrics)
assert.equal(mergeMetadata(track, { matched: true, lyrics: 'x'.repeat(200_010) }).embeddedLyrics.length, 200_000)
console.log('7 metadata merge checks passed')
