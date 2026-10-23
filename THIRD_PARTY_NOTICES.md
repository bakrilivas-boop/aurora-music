# Third-party notices

Aurora Music original source is distributed under the MIT License. Dependencies retain their own copyright notices and licenses.

## Main dependencies

| Component | License |
| --- | --- |
| React / React DOM | MIT |
| Zustand | MIT |
| Electron | MIT; bundled Chromium, Node.js and other components have their own notices |
| Vite / esbuild | MIT |
| TypeScript | Apache-2.0 |

Use `package-lock.json` for the resolved dependency versions. Dependency license files and Electron's `LICENSE` / `LICENSES.chromium.html` remain with the corresponding installed or packaged components.

## References and acknowledgments

Interface organization and interaction references: [VutronMusic](https://github.com/stark81/VutronMusic), [Nuclear](https://github.com/nukeop/nuclear), and [Moosync-electron](https://github.com/Moosync/Moosync-electron). Their UI source was not merged into this application. Their own licenses remain applicable to their projects.

The 1.6 interface also draws visual inspiration from the cover-focused layout of [YesPlayMusic](https://github.com/qier222/YesPlayMusic) and the spacing and library hierarchy of [Harmonoid](https://github.com/harmonoid/harmonoid). These are design references only; no source code, artwork, fonts or brand assets from these projects are redistributed.

Public API implementation references are identified in the corresponding source files:

- `electron/metadata.cjs`: [KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi), for lyric endpoint behavior.
- `electron/playlist-sources.cjs`: NeteaseCloudMusicApiEnhanced/api-enhanced and chongya369/qqmusic-api-py, for playlist metadata, pagination and endpoint behavior.

DeepSeek and music platforms are external services, not bundled dependencies. Service access and availability are governed by the respective providers. This repository does not include their credentials, music, lyrics or album artwork. Aurora Music is an independent project and is not an official client of these services.
