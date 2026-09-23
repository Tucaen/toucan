import { cacheableAsShell, CLIENT_CACHE, PRECACHED_SHELL } from './service-worker-policy'

/**
 * The two caching strategies the worker carries out, with the runtime handed in.
 *
 * They live here rather than in `sw.ts` for one reason: `sw.ts` registers its listeners against
 * the worker's own `self` the moment it is imported, so nothing inside it can be reached from a
 * test. Taking `caches` and `fetch` as an argument makes the strategies ordinary functions, and
 * leaves `sw.ts` as what its docblock already claims it is - plumbing that carries verdicts out.
 *
 * Which requests reach either of these is `service-worker-policy.ts`; neither decides that here.
 */
export interface ServiceWorkerRuntime {
  caches: CacheStorage
  fetch(request: Request): Promise<Response>
}

/**
 * Network first for a page load, because the desktop is the authority on everything the page then
 * asks for and a cached shell is only ever a way to open the app at all.
 *
 * The reply is cached only when it *is* a shell: a navigation to `/sw.js` or `/icon-192.png` is
 * still a navigation, and caching one under the shell's key is how the next offline open would
 * serve a PNG in place of the app. See `cacheableAsShell`.
 */
export async function shellFirst(runtime: ServiceWorkerRuntime, request: Request): Promise<Response> {
  try {
    const response = await runtime.fetch(request)
    if (cacheableAsShell(response)) {
      const cache = await runtime.caches.open(CLIENT_CACHE)
      await cache.put(PRECACHED_SHELL, response.clone())
    }
    return response
  } catch (error) {
    const cached = await runtime.caches.match(PRECACHED_SHELL)
    if (cached) return cached
    throw error
  }
}

/** Cache first, sound only for content-addressed URLs: a changed asset is a different request. */
export async function cacheFirst(runtime: ServiceWorkerRuntime, request: Request): Promise<Response> {
  const cache = await runtime.caches.open(CLIENT_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await runtime.fetch(request)
  if (response.ok) await cache.put(request, response.clone())
  return response
}
