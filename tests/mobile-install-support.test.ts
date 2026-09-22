import { strict as assert } from 'node:assert'
import { describe, test } from 'vitest'
import {
  installServiceWorker,
  pageInstallCapabilities,
  SERVICE_WORKER_PATH,
  serviceWorkerVerdict,
  type InstallScope,
  type ServiceWorkerContainerLike
} from '../mobile/src/install-support'

/**
 * Whether the phone client makes itself installable, and - the load-bearing half - what happens
 * when it cannot. Toucan's remote listener speaks plain HTTP; only `tailscale serve` puts a real
 * certificate in front of it, so the *normal* state of this code is "not a secure context, carry
 * on as an ordinary web page". A registration that threw, or a hard requirement on
 * `navigator.serviceWorker`, would turn the documented fallback path into a broken app.
 */

const SECURE = { secureContext: true, serviceWorkerApi: true }

function scope(register: ServiceWorkerContainerLike['register']): InstallScope {
  return { isSecureContext: true, navigator: { serviceWorker: { register } } }
}

describe('when the client tries to install a service worker', () => {
  test('a secure context with the API registers the root-scoped worker', () => {
    assert.deepEqual(serviceWorkerVerdict(SECURE), { kind: 'register', path: SERVICE_WORKER_PATH })
  })

  test('plain HTTP is named as such, because it is the expected state and not a fault', () => {
    assert.deepEqual(serviceWorkerVerdict({ secureContext: false, serviceWorkerApi: false }), {
      kind: 'skip',
      reason: 'insecure-context'
    })
  })

  test('an insecure context outranks a missing API, since it is the reason the API is missing', () => {
    assert.deepEqual(serviceWorkerVerdict({ secureContext: false, serviceWorkerApi: true }), {
      kind: 'skip',
      reason: 'insecure-context'
    })
  })

  test('a secure context without the API is a browser that cannot, not a misconfiguration', () => {
    assert.deepEqual(serviceWorkerVerdict({ secureContext: true, serviceWorkerApi: false }), {
      kind: 'skip',
      reason: 'unsupported'
    })
  })
})

describe('what the page reports about itself', () => {
  test('the API is read off the navigator, which a browser withholds outside a secure context', () => {
    assert.deepEqual(
      pageInstallCapabilities({ isSecureContext: true, navigator: { serviceWorker: { register: reject } } }),
      {
        secureContext: true,
        serviceWorkerApi: true
      }
    )
    assert.deepEqual(pageInstallCapabilities({ isSecureContext: false, navigator: {} }), {
      secureContext: false,
      serviceWorkerApi: false
    })
  })

  test('a scope missing either field is treated as incapable rather than assumed capable', () => {
    assert.deepEqual(pageInstallCapabilities({}), { secureContext: false, serviceWorkerApi: false })
  })
})

describe('installing it for real', () => {
  test('the worker is registered as a module, at the origin root', async () => {
    const calls: { path: string; type: string }[] = []
    const outcome = await installServiceWorker(
      scope((path, options) => {
        calls.push({ path, type: options.type })
        return Promise.resolve({})
      })
    )

    assert.deepEqual(outcome, { kind: 'registered' })
    assert.deepEqual(calls, [{ path: SERVICE_WORKER_PATH, type: 'module' }])
  })

  test('a skipped context never touches the container', async () => {
    let registered = false
    const outcome = await installServiceWorker({
      isSecureContext: false,
      navigator: {
        serviceWorker: {
          register: () => {
            registered = true
            return Promise.resolve({})
          }
        }
      }
    })

    assert.deepEqual(outcome, { kind: 'skipped', reason: 'insecure-context' })
    assert.equal(registered, false)
  })

  test('a rejected registration is reported, never thrown: the app has to keep loading without it', async () => {
    const outcome = await installServiceWorker(scope(() => Promise.reject(new Error('no worker for you'))))

    assert.deepEqual(outcome, { kind: 'failed', message: 'no worker for you' })
  })

  test('a browser with no container at all skips rather than throwing on the loading path', async () => {
    assert.deepEqual(await installServiceWorker({ isSecureContext: true, navigator: {} }), {
      kind: 'skipped',
      reason: 'unsupported'
    })
  })
})

function reject(): Promise<unknown> {
  return Promise.reject(new Error('not called'))
}
