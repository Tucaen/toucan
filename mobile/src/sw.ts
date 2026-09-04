import { fetchPlan, PRECACHED_SHELL, CLIENT_CACHE, staleCacheNames, type FetchPlan } from './service-worker-policy'

/**
 * The phone client's service worker: the minimum that makes the app installable, plus a shell the
 * app can reopen from.
 *
 * Only the shell is precached. The hashed assets are cached as the worker serves them, so a first
 * visit populates nothing (the page loaded them before any worker was controlling it) and opening
 * with the host unreachable works from the visit after that. Precaching them would mean parsing
 * the shell for its asset URLs, which is offline work this ticket deliberately does not do.
 *
 * Every decision about *what* it may touch is `service-worker-policy.ts`; this file is the plumbing
 * that carries those verdicts out, and it deliberately holds no caching rules of its own.
 *
 * It is built as its own unhashed entry (`/sw.js`) because a worker's URL is its identity - a
 * fingerprinted one would register as a brand new worker every build. The globals it runs against
 * are declared here rather than pulled in as TypeScript's `WebWorker` lib: that lib redeclares half
 * of `DOM` and so cannot share a program with the rest of `mobile/`, and the worker's real surface
 * is small enough that naming it is cheaper than a second tsconfig for one file.
 */

interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void
}

interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request
  respondWith(response: Response | Promise<Response>): void
}

declare const self: {
  readonly caches: CacheStorage
  readonly clients: { claim(): Promise<void> }
  readonly location: { origin: string }
  skipWaiting(): Promise<void>
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEventLike) => void): void
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await self.caches.open(CLIENT_CACHE)
      // `reload` so an installing worker cannot adopt a stale shell out of the HTTP cache.
      await cache.add(new Request(PRECACHED_SHELL, { cache: 'reload' }))
      // Take over at once: the shell this worker shipped with is the one already loaded, so there
      // is no half-updated page to protect and waiting would only defer control by a visit.
      await self.skipWaiting()
    })()
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await self.caches.keys()
      await Promise.all(staleCacheNames(names, CLIENT_CACHE).map((name) => self.caches.delete(name)))
      await self.clients.claim()
    })()
  )
})

self.addEventListener('fetch', (event) => {
  const plan: FetchPlan = fetchPlan(
    { method: event.request.method, mode: event.request.mode, url: event.request.url },
    self.location.origin
  )
  // Not calling `respondWith` at all is what makes pass-through identical to having no worker: the
  // browser performs the request itself, headers, redirects and all.
  if (plan === 'shell') event.respondWith(shellFirst(event.request))
  else if (plan === 'immutable-asset') event.respondWith(cacheFirst(event.request))
})

/**
 * Network first for a page load, because the desktop is the authority on everything the page then
 * asks for and a cached shell is only ever a way to open the app at all.
 */
async function shellFirst(request: Request): Promise<Response> {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await self.caches.open(CLIENT_CACHE)
      await cache.put(PRECACHED_SHELL, response.clone())
    }
    return response
  } catch (error) {
    const cached = await self.caches.match(PRECACHED_SHELL)
    if (cached) return cached
    throw error
  }
}

/** Cache first, sound only for content-addressed URLs: a changed asset is a different request. */
async function cacheFirst(request: Request): Promise<Response> {
  const cache = await self.caches.open(CLIENT_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) await cache.put(request, response.clone())
  return response
}
