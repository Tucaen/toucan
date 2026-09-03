import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The mobile companion is a separate page, not a second Electron renderer: it is built to plain
 * static assets that Toucan's own remote server hands to the phone, so there is no second server
 * process and nothing to deploy. It builds beside the main and renderer bundles in `out/` so one
 * path resolves it in development and inside a packaged build.
 *
 * Asset URLs are absolute because the remote server always serves this at the origin root, which
 * is what keeps a reloaded deep link resolving its bundle instead of asking for it one directory
 * down.
 */
export default defineConfig({
  root: 'mobile',
  base: '/',
  plugins: [react()],
  build: {
    outDir: '../out/mobile',
    emptyOutDir: true
  }
})
