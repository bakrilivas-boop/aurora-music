import { copyFile } from 'node:fs/promises'
await copyFile(new URL('../dist-mobile/mobile.html', import.meta.url), new URL('../dist-mobile/index.html', import.meta.url))
