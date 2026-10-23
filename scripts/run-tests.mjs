import { build } from 'esbuild'

await build({
  entryPoints: ['src/lib/tags.ts', 'src/lib/lyrics.ts'], bundle: true,
  format: 'esm', platform: 'neutral', outdir: '.tmp', outExtension: { '.js': '.mjs' },
})
await import('./unit.mjs')
if (!process.exitCode) await import('./player-regression.mjs')
if (!process.exitCode) await import('./local-assets-regression.mjs')
if (!process.exitCode) await import('./metadata-merge-regression.mjs')
if (!process.exitCode) await import('./metadata-regression.mjs')
if (!process.exitCode) await import('./deepseek-ai-regression.mjs')
if (!process.exitCode) await import('./music-mirror-regression.mjs')
if (!process.exitCode) await import('./playlist-sources-regression.mjs')
if (!process.exitCode) await import('./download-queue-regression.mjs')
if (!process.exitCode) await import('./desktop-state-regression.mjs')
