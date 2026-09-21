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

afterEach(() => cleanup())
