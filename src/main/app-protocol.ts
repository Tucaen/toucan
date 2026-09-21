/**
 * The origin a packaged renderer runs on.
 *
 * It is deliberately *not* `file:`: a custom scheme registered as standard, secure and
 * fetch-capable behaves like an HTTP origin - real `fetch`, real workers, cross-origin isolation -
 * without opening a port on the machine. The speech model no longer rides this origin (the whisper
 * engine and its checkpoint live entirely in the main process; see `whisper-engine.ts`), but the
 * scheme stays: `file:` pages have an opaque origin that COOP/COEP can never isolate and a `fetch`
 * that refuses the scheme outright, and going back would re-break whatever next needs either.
 */
export const APP_SCHEME = 'toucan'

/** The single host under the scheme. One origin, so nothing the renderer loads is cross-origin. */
export const APP_HOST = 'app'

export const APP_INDEX_URL = `${APP_SCHEME}://${APP_HOST}/index.html`

/**
 * The bundle-relative path a `toucan://` request is asking for, or null when it is not ours to
 * answer. Traversal is rejected here rather than after joining a path, so no caller can be tricked
 * into reading outside the renderer directory this scheme serves.
 */
export function appRequestTarget(requestUrl: string): string | null {
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
  if (segments.length === 0) return 'index.html'
  // A backslash is a separator on Windows, so a segment carrying one is nesting in disguise.
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.includes('\\'))) return null
  return segments.join('/')
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
