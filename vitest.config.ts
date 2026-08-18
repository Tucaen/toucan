import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Renderer component tests. Shares the same Vite/React transform electron-vite uses for the
// app itself, unlike tests/*.test.ts (compiled by tsc, run with `node --test`), which cover
// non-UI logic and don't need a DOM. See tests/dom/setup.ts for the jsdom/RTL wiring.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.dom.test.tsx'],
    setupFiles: ['./tests/dom/setup.ts']
  }
})
