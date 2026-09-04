import { normalize, sep } from 'node:path'

/**
 * What a remote request is, decided before anything touches the filesystem or the workspace.
 *
 * Two rules are load-bearing here. Every `/api` route is authorized - the pairing token gates all
 * of them - while the client bundle is not: a phone cannot set an `Authorization` header on the
 * navigation that loads a page, so the pairing screen has to be servable before the user has
 * pasted anything. The bundle is Toucan's own static build and carries no workspace data, so
 * serving it unauthenticated exposes nothing; the API behind it stays shut.
 */
export type RemoteRoute =
  | { kind: 'workspace' }
  /** Lets a phone check a token the moment it is entered instead of at the first real request. */
  | { kind: 'pairing' }
  /** The one write the phone makes over HTTP: start a chat that does not exist yet. */
  | { kind: 'create-chat' }
  | { kind: 'client'; pathname: string }
  | { kind: 'not-found' }
  /** Carries the methods this path *does* accept, so `Allow` is never a guess at the call site. */
  | { kind: 'method-not-allowed'; allow: string }

export function resolveRemoteRoute(method: string | undefined, target: string | undefined): RemoteRoute {
  const pathname = requestPathname(target)
  if (pathname === null) return { kind: 'not-found' }

  if (pathname === '/api/workspace' || pathname === '/api/pairing') {
    if (method !== 'GET' && method !== 'HEAD') return { kind: 'method-not-allowed', allow: 'GET, HEAD' }
    return pathname === '/api/workspace' ? { kind: 'workspace' } : { kind: 'pairing' }
  }
  if (pathname === '/api/chats') {
    // `POST` and nothing else: a collection this host does not enumerate over HTTP, because what
    // chats exist is already the workspace projection's answer.
    return method === 'POST' ? { kind: 'create-chat' } : { kind: 'method-not-allowed', allow: 'POST' }
  }
  if (pathname.startsWith('/api/')) return { kind: 'not-found' }
  if (method !== 'GET' && method !== 'HEAD') return { kind: 'method-not-allowed', allow: 'GET, HEAD' }
  return { kind: 'client', pathname }
}

/** Route authorization is a property of the route, not of the handler that happens to run it. */
export function routeRequiresPairing(route: RemoteRoute): boolean {
  return route.kind === 'workspace' || route.kind === 'pairing' || route.kind === 'create-chat'
}

/**
 * What a WebSocket upgrade may become. Resolved separately from the HTTP routes because an upgrade
 * is not a method - the only socket the host speaks is the live view of one chat, and everything
 * else is refused after the pairing gate has already run.
 */
export type RemoteSocketRoute = { kind: 'chat'; chatId: string } | { kind: 'not-found' }

export function resolveRemoteSocketRoute(target: string | undefined): RemoteSocketRoute {
  const pathname = requestPathname(target)
  if (pathname === null) return { kind: 'not-found' }
  const match = /^\/api\/chats\/([^/]+)$/.exec(pathname)
  return match ? { kind: 'chat', chatId: match[1] } : { kind: 'not-found' }
}

function requestPathname(target: string | undefined): string | null {
  if (!target) return null
  try {
    // The base is a placeholder: only the path is ever used, and a request line is always a path
    // or an absolute URL, both of which resolve against it.
    return decodeURIComponent(new URL(target, 'http://remote.invalid').pathname)
  } catch {
    return null
  }
}

/**
 * Resolves a client-bundle request to a file inside the build directory, or null. A single-page
 * client also needs unknown paths to land on its shell, so that fallback is the caller's, not a
 * silent rewrite here.
 */
export function resolveClientAsset(root: string, pathname: string): string | null {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  if (!relative || relative.includes('\0')) return null
  const resolved = normalize(`${root}${sep}${relative}`)
  // Containment is checked on the normalized path, so `..` segments and encoded separators are
  // both caught after they have been collapsed rather than by pattern-matching the request.
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return resolved.startsWith(prefix) ? resolved : null
}

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2'
}

export function clientContentType(path: string): string {
  const dot = path.lastIndexOf('.')
  const extension = dot === -1 ? '' : path.slice(dot).toLowerCase()
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}
