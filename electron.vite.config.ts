import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()],
    worker: {
      format: 'es'
    },
    server: {
      // Dev has to be cross-origin-isolated for the same reason the packaged origin is: see
      // APP_ISOLATION_HEADERS in src/main/app-protocol.ts, which these two must keep matching.
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp'
      }
    }
  }
})
