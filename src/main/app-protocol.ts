import { VOICE_MODEL_ASSET_DIRECTORY } from '../shared/remote-voice'

/**
 * The origin a packaged renderer runs on.
 *
 * It is deliberately *not* `file:`. Moonshine's threaded WASM build needs `SharedArrayBuffer`,
 * which Chromium only hands to a cross-origin-isolated page, and a `file:` page has an opaque
 * origin that COOP/COEP can never isolate - the pthread worker then dies on its first
 * `postMessage` inside a promise that never settles, which is what left the microphone stuck on
 * "Preparing local speech model...". A `file:` page cannot load the model either: the Cache API
 * and `fetch` both refuse a non-HTTP scheme outright.
 *
 * A custom scheme registered as standard, secure and fetch-capable behaves like an HTTP origin for
 * all three, without opening a port on the machine. Everything the renderer needs is served from
 * it: its own bundle, and the speech model that is not in the installer.
 */
export const APP_SCHEME = 'toucan'

/** The single host under the scheme. One origin, so nothing the renderer loads is cross-origin. */
export const APP_HOST = 'app'

export const APP_INDEX_URL = `${APP_SCHEME}://${APP_HOST}/index.html`

export type AppRequestTarget =
  /** One file of the speech model, which lives outside the renderer bundle. */
  | { kind: 'model'; name: string }
  /** A path inside the built renderer directory. */
  | { kind: 'renderer'; path: string }

const MODEL_PREFIX = `${VOICE_MODEL_ASSET_DIRECTORY}/`

/**
 * What a `toucan://` request is asking for, or null when it is not ours to answer. Traversal is
 * rejected here rather than after joining a path, so no caller can be tricked into reading outside
 * the two directories this scheme serves.
 */
export function appRequestTarget(requestUrl: string): AppRequestTarget | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 0) return { kind: 'renderer', path: 'index.html' }
  // A backslash is a separator on Windows, so a segment carrying one is nesting in disguise.
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.includes('\\'))) return null
  const path = segments.join('/')
  // The model directory is the host store's, never the bundle's, so a request that lands anywhere
  // inside it is answered from there or not at all - falling through to the bundle would quietly
  // look for 291 MB that `build.files` deliberately excludes.
  if (path === VOICE_MODEL_ASSET_DIRECTORY) return null
  if (path.startsWith(MODEL_PREFIX)) {
    const name = path.slice(MODEL_PREFIX.length)
    // One plain file name directly inside the model directory: no nesting, no directory itself.
    return name && !name.includes('/') ? { kind: 'model', name } : null
  }
  return { kind: 'renderer', path }
}

/**
 * The `Content-Type` a served file needs. Chromium refuses a module script or a streamed
 * `WebAssembly.instantiate` on a guessed type, and a custom scheme has no server to guess for it.
 */
export function appContentType(path: string): string | null {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  switch (extension) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.wasm':
      return 'application/wasm'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.woff2':
      return 'font/woff2'
    default:
      return null
  }
}

/**
 * The headers that make the origin cross-origin-isolated. `require-corp` means every subresource
 * has to opt in as well, which is why the same handler stamps `same-origin` on everything it
 * serves; the renderer loads nothing else over the network.
 */
export const APP_ISOLATION_HEADERS: Readonly<Record<string, string>> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin'
}
