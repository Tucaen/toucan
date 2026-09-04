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
  /**
   * A CORS preflight. Never authorized, and it cannot be: a browser sends the preflight *without*
   * the `Authorization` header it is asking permission to send, so gating this on the pairing token
   * would refuse every cross-host request before the real one was ever attempted.
   */
  | { kind: 'preflight' }
  | { kind: 'not-found' }
  /** Carries the methods this path *does* accept, so `Allow` is never a guess at the call site. */
  | { kind: 'method-not-allowed'; allow: string }

export function resolveRemoteRoute(method: string | undefined, target: string | undefined): RemoteRoute {
  const pathname = requestPathname(target)
  if (pathname === null) return { kind: 'not-found' }
  // Before every other method rule, and before the pairing gate: a preflight is a question about a
  // request, not the request, so it is answered for any path this host serves at all.
  if (method === 'OPTIONS') return { kind: 'preflight' }

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
 * Why this surface is cross-origin at all, and why `*` is the honest answer.
 *
 * The mobile client is *served by* a host but may hold connections *to* another: one phone, several
 * Toucan hosts (work PC, private PC), and only the serving host is same-origin. The alternative -
 * bookmarking each host separately - is not a host switcher at all, because the saved host list
 * lives in `localStorage` and `localStorage` is per origin: each bookmark would keep its own list
 * and its own tokens, and switching would mean leaving the app.
 *
 * `*` is safe here precisely because this surface has no ambient authority to hand out.
 * Authorization is the pairing token and nothing else - it travels as an `Authorization` header the
 * requesting page must already know, there is no cookie and no session state, and
 * `Access-Control-Allow-Credentials` is deliberately absent, which also forbids `*` from ever being
 * paired with credentials by a later edit. A hostile page that reaches a tailnet host therefore
 * learns exactly what any unauthorized caller learns: `401`.
 *
 * What the headers buy is the honest failure. A `401` without them reaches the client as an opaque
 * network error, so the phone would read a revoked token as an unreachable host and retry forever
 * instead of dropping that one host into re-pairing.
 *
 * They are scoped to the API and its preflights: the client bundle is fetched by navigation, not by
 * script from another origin, so `sendClientAsset` serves it without them.
 */
export const REMOTE_CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '600'
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
