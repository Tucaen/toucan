import { cacheFirst, shellFirst, type ServiceWorkerRuntime } from './service-worker-cache'
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
 * Every decision about *what* it may touch is `service-worker-policy.ts` and every strategy that
 * carries a verdict out is `service-worker-cache.ts`; this file is the wiring between those two and
 * the worker's own globals, and it deliberately holds no caching rules of its own.
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

declare const self: ServiceWorkerRuntime & {
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
  if (plan === 'shell') event.respondWith(shellFirst(self, event.request))
  else if (plan === 'immutable-asset') event.respondWith(cacheFirst(self, event.request))
})
