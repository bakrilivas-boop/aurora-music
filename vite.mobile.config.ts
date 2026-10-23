import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5274, watch: { ignored: ['**/.tools/**', '**/.private/**', '**/android/**', '**/release/**', '**/archive/**', '**/.qa/**', '**/dist/**', '**/dist-mobile/**'] } },
  build: { outDir: 'dist-mobile', target: 'es2020', copyPublicDir: false,
    rollupOptions: { input: 'mobile.html' } },
})
