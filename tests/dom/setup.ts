import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import './codemirror-jsdom'

/**
 * The decision-provider availability probe (issue #213) is asked once as the app mounts, from
 * every surface that renders a composer. It is stubbed here rather than in each App-mounting test
 * because a test that has nothing to say about decision delegation should not have to know it
 * exists; a test that does care redefines the property for itself.
 */
Object.defineProperty(window, 'decisionDelegationApi', {
  configurable: true,
  writable: true,
  value: { availability: async () => false }
})

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
