import { strict as assert } from 'node:assert'
import { describe, test } from 'vitest'
import { cacheFirst, shellFirst, type ServiceWorkerRuntime } from '../mobile/src/service-worker-cache'
import {
  cacheableAsShell,
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

/**
 * What the worker *does* with a request it decided to handle, against a fake `caches`.
 *
 * The case worth having a test for is the one the address bar produces: `/sw.js` and
 * `/icon-192.png` are navigations too, the host answers both with a 200, and a worker that cached
 * either under the shell's key would open the app to a PNG the next time the host was unreachable.
 */

/** Enough of `CacheStorage` for one named cache, with the entries readable afterwards. */
function fakeCaches(): CacheStorage & { entries: Map<string, Response> } {
  const entries = new Map<string, Response>()
  const keyOf = (request: RequestInfo | URL): string =>
    typeof request === 'string' ? request : request instanceof URL ? request.href : request.url
  const cache = {
    match: (request: RequestInfo | URL) => Promise.resolve(entries.get(keyOf(request))),
    put: (request: RequestInfo | URL, response: Response) => {
      entries.set(keyOf(request), response)
      return Promise.resolve()
    }
  }
  return {
    entries,
    open: () => Promise.resolve(cache),
    match: (request: RequestInfo | URL) => Promise.resolve(entries.get(keyOf(request)))
  } as unknown as CacheStorage & { entries: Map<string, Response> }
}

function runtime(
  caches: CacheStorage,
  fetched: (request: Request) => Promise<Response>
): ServiceWorkerRuntime & { caches: CacheStorage } {
  return { caches, fetch: fetched }
}

function html(body = '<!doctype html>'): Response {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

describe('what a navigation is allowed to leave in the cache', () => {
  test('only an HTML reply is the shell, whatever the address bar was pointed at', () => {
    assert.equal(cacheableAsShell(html()), true)
    assert.equal(
      cacheableAsShell(new Response('{}', { headers: { 'content-type': 'application/manifest+json' } })),
      false
    )
    assert.equal(cacheableAsShell(new Response('PNG', { headers: { 'content-type': 'image/png' } })), false)
    assert.equal(cacheableAsShell(new Response('', { status: 500 })), false)
    assert.equal(cacheableAsShell(new Response('')), false)
  })

  test('a page load replaces the cached shell', async () => {
    const caches = fakeCaches()
    const response = await shellFirst(
      runtime(caches, async () => html('<!doctype html>fresh')),
      new Request(`${ORIGIN}/`)
    )

    assert.equal(await response.text(), '<!doctype html>fresh')
    assert.equal(await caches.entries.get(PRECACHED_SHELL)?.text(), '<!doctype html>fresh')
  })

  test('navigating to the manifest, the worker or an icon leaves the shell alone', async () => {
    const caches = fakeCaches()
    await caches.open(CLIENT_CACHE).then((cache) => cache.put(PRECACHED_SHELL, html('<!doctype html>the app')))

    for (const reply of [
      new Response('{"name":"Toucan"}', { headers: { 'content-type': 'application/manifest+json' } }),
      new Response('PNG', { headers: { 'content-type': 'image/png' } })
    ]) {
      await shellFirst(
        runtime(caches, async () => reply),
        new Request(`${ORIGIN}/manifest.webmanifest`)
      )
    }

    assert.equal(await caches.entries.get(PRECACHED_SHELL)?.text(), '<!doctype html>the app')
  })

  test('an unreachable host opens from the cached shell, and says so when there is none', async () => {
    const caches = fakeCaches()
    const offline = runtime(caches, () => Promise.reject(new Error('Failed to fetch')))

    await assert.rejects(shellFirst(offline, new Request(`${ORIGIN}/`)), /Failed to fetch/)

    await caches.open(CLIENT_CACHE).then((cache) => cache.put(PRECACHED_SHELL, html('<!doctype html>the app')))
    assert.equal(await (await shellFirst(offline, new Request(`${ORIGIN}/`))).text(), '<!doctype html>the app')
  })
})

describe('what a hashed asset does', () => {
  test('the cache answers when it can, and fills from the network when it cannot', async () => {
    const caches = fakeCaches()
    let fetches = 0
    const asset = runtime(caches, async () => {
      fetches += 1
      return new Response('console.log(1)', { headers: { 'content-type': 'text/javascript' } })
    })
    const request = new Request(`${ORIGIN}${IMMUTABLE_ASSET_PREFIX}index-a1b2c3.js`)

    assert.equal(await (await cacheFirst(asset, request)).text(), 'console.log(1)')
    assert.equal(await (await cacheFirst(asset, request)).text(), 'console.log(1)')
    assert.equal(fetches, 1, 'a content-addressed URL is fetched once')
  })

  test('a failed fetch is not cached, so a 404 cannot become the asset', async () => {
    const caches = fakeCaches()
    const missing = runtime(caches, async () => new Response('not found', { status: 404 }))
    const request = new Request(`${ORIGIN}${IMMUTABLE_ASSET_PREFIX}gone-a1b2c3.js`)

    assert.equal((await cacheFirst(missing, request)).status, 404)
    assert.equal(caches.entries.size, 0)
  })
})
