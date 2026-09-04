/**
 * Whether this page can become an installed app, and what to do when it cannot.
 *
 * Toucan's remote listener speaks plain HTTP and deliberately owns no certificates: reachability
 * and TLS are Tailscale's job, so an installable origin means the user ran `tailscale serve` in
 * front of the host. That makes "not a secure context" the *ordinary* state of this module rather
 * than a fault - over plain HTTP the client is a normal web page and every feature except install
 * works identically - so the decision is a verdict with a named reason instead of a boolean, and a
 * registration that fails is reported rather than thrown. Nothing on the loading path may depend
 * on the worker existing.
 */

/**
 * Root-scoped on purpose: the client is served at the origin root and routes by pathname, so a
 * worker parked one directory down would control none of the deep links a reader reloads.
 */
export const SERVICE_WORKER_PATH = '/sw.js'

/** The one call this module needs from `navigator.serviceWorker`. */
export interface ServiceWorkerContainerLike {
  register(path: string, options: { type: 'module' }): Promise<unknown>
}

/** The window-shaped facts this module reads. Passed whole, so there is one source of truth. */
export interface InstallScope {
  isSecureContext?: boolean
  navigator?: { serviceWorker?: ServiceWorkerContainerLike }
}

export interface PageInstallCapabilities {
  secureContext: boolean
  serviceWorkerApi: boolean
}

export type ServiceWorkerSkipReason = 'insecure-context' | 'unsupported'

export type ServiceWorkerVerdict =
  { kind: 'register'; path: string } | { kind: 'skip'; reason: ServiceWorkerSkipReason }

export function serviceWorkerVerdict(page: PageInstallCapabilities): ServiceWorkerVerdict {
  // Checked before the API, because an insecure context is *why* a browser withholds the API, and
  // reporting "unsupported browser" for a plain-HTTP tailnet address would misdiagnose the fix.
  if (!page.secureContext) return { kind: 'skip', reason: 'insecure-context' }
  if (!page.serviceWorkerApi) return { kind: 'skip', reason: 'unsupported' }
  return { kind: 'register', path: SERVICE_WORKER_PATH }
}

/** Reads the two facts off the scope. Anything missing counts as incapable. */
export function pageInstallCapabilities(scope: InstallScope): PageInstallCapabilities {
  return {
    secureContext: scope.isSecureContext === true,
    serviceWorkerApi: scope.navigator?.serviceWorker != null
  }
}

export type ServiceWorkerOutcome =
  { kind: 'registered' } | { kind: 'failed'; message: string } | { kind: 'skipped'; reason: ServiceWorkerSkipReason }

/**
 * Registers the worker if this page can have one. Never rejects: an unregistered worker costs the
 * install prompt and nothing else, while a rejection on the loading path would cost the app. The
 * caller still gets the outcome, because a *failed* registration and a skipped one send a reader
 * to two different fixes.
 */
export async function installServiceWorker(scope: InstallScope): Promise<ServiceWorkerOutcome> {
  const verdict = serviceWorkerVerdict(pageInstallCapabilities(scope))
  if (verdict.kind === 'skip') return { kind: 'skipped', reason: verdict.reason }
  const container = scope.navigator?.serviceWorker
  if (!container) return { kind: 'skipped', reason: 'unsupported' }
  try {
    // A module worker. The built `sw.js` happens to have no imports today, so a classic worker
    // would also load it - but the entry is bundled, and a future shared chunk would turn it into
    // one that only a module worker can run. A browser without module workers falls into the
    // already-supported "no worker" path: no install prompt, everything else unchanged.
    await container.register(verdict.path, { type: 'module' })
    return { kind: 'registered' }
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}
