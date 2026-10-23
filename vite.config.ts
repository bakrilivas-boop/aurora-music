import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5273, strictPort: false },
  preview: { host: '127.0.0.1', port: 5273 },
  build: { target: 'es2020', chunkSizeWarningLimit: 1200, copyPublicDir: false },
})
