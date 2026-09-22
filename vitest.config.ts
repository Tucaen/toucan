import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * Both test suites, as two projects, so `vitest run` is the whole of `npm test`.
 *
 * They differ only in what they mount: `dom` renders React into jsdom through the same Vite/React
 * transform electron-vite uses for the app itself, `node` covers main-process and shared logic
 * that needs no DOM. Both run as ES modules - which is the point. The node suite used to be
 * compiled to CommonJS by `tsc` and run under `node --test`, and that compile was load-bearing in
 * places it had no business being: it forced `new Function('specifier', 'return import(specifier)')`
 * into a test that only wanted to import an `.mjs` script, and it is the reason the terminal-context
 * MCP server was hand-rolled rather than built on `@modelcontextprotocol/sdk` (#238).
 *
 * The node suite still asserts with `node:assert`; only the runner changed.
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['tests/**/*.dom.test.tsx'],
          setupFiles: ['./tests/dom/setup.ts']
        }
      },
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          // `node --test` imposed no per-test deadline; a handful of these spawn real child
          // processes or walk the whole source tree, and Vitest's 5s default cuts them off.
          testTimeout: 30_000
        }
      }
    ]
  }
})
