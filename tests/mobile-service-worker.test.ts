import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  fetchPlan,
  IMMUTABLE_ASSET_PREFIX,
  PRECACHED_SHELL,
  CLIENT_CACHE,
  staleCacheNames
} from '../mobile/src/service-worker-policy'

/**
 * What the phone's service worker is allowed to touch.
 *
 * The worker exists to make the client installable, not to keep a copy of the workspace: a
 * transcript, a chat list and a pairing verdict are all live reads on a desktop that may have
 * moved on, so serving any of them from a cache would be showing the reader a lie. That makes the
 * interesting assertions here the negative ones - the API, the chat socket and every other host
 * the phone talks to pass through untouched - and the whole cache is the app shell plus Vite's
 * content-hashed assets, which are immutable by construction.
 */

const ORIGIN = 'https://work-pc.tail1234.ts.net'

function plan(url: string, extra: { method?: string; mode?: string } = {}): string {
  return fetchPlan({ method: extra.method ?? 'GET', mode: extra.mode ?? 'no-cors', url }, ORIGIN)
}

describe('what the worker serves from its own cache', () => {
  test('a page load is the shell, so a reloaded deep link opens even while the host is unreachable', () => {
    assert.equal(plan(`${ORIGIN}/chats/node-1`, { mode: 'navigate' }), 'shell')
    assert.equal(plan(`${ORIGIN}/`, { mode: 'navigate' }), 'shell')
  })

  test('hashed bundle assets are cacheable because their URL changes whenever their bytes do', () => {
    assert.equal(plan(`${ORIGIN}${IMMUTABLE_ASSET_PREFIX}index-a1b2c3.js`), 'immutable-asset')
    assert.equal(plan(`${ORIGIN}${IMMUTABLE_ASSET_PREFIX}styles-d4e5f6.css`), 'immutable-asset')
  })
})

describe('what the worker must never touch', () => {
  test('the API is live desktop state, so a cached answer would be a stale workspace', () => {
    assert.equal(plan(`${ORIGIN}/api/workspace`), 'pass-through')
    assert.equal(plan(`${ORIGIN}/api/pairing`), 'pass-through')
    assert.equal(plan(`${ORIGIN}/api/chats/node-1`), 'pass-through')
  })

  test('another host is another Toucan: one phone drives several, and only one of them served the page', () => {
    assert.equal(plan('https://home-pc.tail1234.ts.net/api/workspace'), 'pass-through')
    assert.equal(plan('https://home-pc.tail1234.ts.net/assets/index-a1b2c3.js'), 'pass-through')
    assert.equal(plan('https://home-pc.tail1234.ts.net/chats/node-1', { mode: 'navigate' }), 'pass-through')
  })

  test('a write is never replayed from a cache', () => {
    assert.equal(plan(`${ORIGIN}/api/chats`, { method: 'POST' }), 'pass-through')
    assert.equal(plan(`${ORIGIN}/`, { method: 'POST', mode: 'navigate' }), 'pass-through')
  })

  test('the manifest, the worker itself and anything else unhashed stay on the network', () => {
    assert.equal(plan(`${ORIGIN}/manifest.webmanifest`), 'pass-through')
    assert.equal(plan(`${ORIGIN}/sw.js`), 'pass-through')
    assert.equal(plan(`${ORIGIN}/icon-512.png`), 'pass-through')
  })

  test('a URL the worker cannot parse is passed through rather than guessed at', () => {
    assert.equal(plan('not a url'), 'pass-through')
  })
})

describe('what a new worker version cleans up', () => {
  test('every cache but the current one goes, so an old shell cannot outlive its bundle', () => {
    assert.deepEqual(staleCacheNames(['toucan-client-v0', CLIENT_CACHE, 'something-else'], CLIENT_CACHE), [
      'toucan-client-v0',
      'something-else'
    ])
  })

  test('the shell the worker precaches is the origin root, which is what a page load falls back to', () => {
    assert.equal(PRECACHED_SHELL, '/')
  })
})
