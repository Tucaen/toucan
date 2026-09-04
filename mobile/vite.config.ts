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
 *
 * The service worker is a second entry rather than part of the page bundle, and the one thing that
 * matters about it is its filename: a worker is identified by its URL, so a fingerprinted `sw.js`
 * would register as a brand new worker on every build and never replace its predecessor. It stays
 * unhashed at the root while everything else keeps Vite's content-addressed names.
 */
export default defineConfig({
  root: 'mobile',
  base: '/',
  plugins: [react()],
  build: {
    outDir: '../out/mobile',
    emptyOutDir: true,
    rollupOptions: {
      // Repository-relative rather than `root`-relative: Rollup resolves an entry against the
      // working directory, and `npm run build:mobile` always runs from the repository root.
      input: { index: 'mobile/index.html', sw: 'mobile/src/sw.ts' },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js')
      }
    }
  }
})
