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
    optimizeDeps: {
      // Keep Emscripten's generated module beside its moonshine.wasm sibling.
      exclude: ['@moonshine-ai/moonshine-wasm']
    },
    worker: {
      format: 'es'
    },
    server: {
      // Moonshine's threaded WASM build requires SharedArrayBuffer; see registerVoiceCrossOriginIsolation.
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp'
      }
    }
  }
})
