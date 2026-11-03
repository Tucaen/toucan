import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import './codemirror-jsdom'

/**
 * jsdom has no ResizeObserver, and every React Flow instance creates one as it mounts - which now
 * includes the canvas inside each worktree node, so a test rendering only a worktree node needs it
 * too. A quiet stub is enough: nothing measures in jsdom. A test that needs measurement installs its
 * own, as `renderApp` does.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
}

afterEach(() => cleanup())
