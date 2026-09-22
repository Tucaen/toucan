/**
 * What the phone's service worker is allowed to cache, kept out of the worker itself so it can be
 * reasoned about and tested without a worker runtime.
 *
 * The worker exists to make the client installable and to reopen, not to keep a copy of the
 * workspace. A transcript, a chat list and a pairing verdict are all live reads on a desktop
 * that may have moved on, so answering any of them from a cache would show the reader a lie. Two
 * things are therefore cacheable and nothing else is: the app shell, and Vite's content-hashed
 * assets - immutable by construction, since their URL changes whenever their bytes do.
 *
 * The other half of the rule is cross-origin. One phone drives several hosts, so most of what this
 * page fetches belongs to a *different* Toucan than the one that served it; the worker only ever
 * considers its own origin and passes everything else straight to the network.
 */

/**
 * The client's one cache, holding both cacheable kinds below - so bumping it for a shell change
 * also drops the assets, which is the point: they are versions of the same build. Activation
 * deletes every other cache, so an old bundle cannot outlive the worker that shipped it.
 */
export const CLIENT_CACHE = 'toucan-client-v1'

/** The one entry precached at install: a page load falls back to it, whatever the pathname was. */
export const PRECACHED_SHELL = '/'

/** @internal exported for tests */
export const IMMUTABLE_ASSET_PREFIX = '/assets/'

export interface RequestFacts {
  method: string
  /** `Request.mode`; `navigate` is a page load, which is the only thing the shell answers. */
  mode: string
  url: string
}

export type FetchPlan =
  /** Network first, cached shell as the fallback. */
  | 'shell'
  /** Cache first, then network - safe only because the URL is content-addressed. */
  | 'immutable-asset'
  /** The worker adds nothing; the request goes to the network as if no worker existed. */
  | 'pass-through'

export function fetchPlan(request: RequestFacts, origin: string): FetchPlan {
  if (request.method !== 'GET') return 'pass-through'
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    // Unparseable, so there is nothing to reason about. Handing it to the network is the one
    // behaviour indistinguishable from having no worker at all.
    return 'pass-through'
  }
  if (url.origin !== origin) return 'pass-through'
  // Named explicitly even though it would fall through anyway: this is the rule that keeps live
  // desktop state out of the cache, and it should not be an accident of the ordering below.
  if (url.pathname.startsWith('/api/')) return 'pass-through'
  if (request.mode === 'navigate') return 'shell'
  if (url.pathname.startsWith(IMMUTABLE_ASSET_PREFIX)) return 'immutable-asset'
  return 'pass-through'
}

/**
 * Caches a newly activated worker should drop, so an old shell cannot outlive its bundle.
 *
 * It keeps exactly one, which is right while there *is* one: anything a later ticket caches
 * separately (push payloads, say) has to be named here too, or activating a new worker will delete
 * it out from under its owner.
 */
export function staleCacheNames(names: readonly string[], keep: string = CLIENT_CACHE): string[] {
  return names.filter((name) => name !== keep)
}
