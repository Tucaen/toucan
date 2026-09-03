import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import {
  EMPTY_REMOTE_WORKSPACE_SNAPSHOT,
  remoteAccessPortProblem,
  type RemoteAccessAddress,
  type RemoteAccessSettings,
  type RemoteAccessState,
  type RemoteWorkspaceProjection,
  type RemoteWorkspaceSnapshot
} from '../../shared/remote-access'
import { describeHostAddresses } from './host-addresses'
import { pairingTokenMatches, presentedPairingToken } from './pairing'
import { clientContentType, resolveClientAsset, resolveRemoteRoute, routeRequiresPairing } from './remote-routes'
import type { RemoteAccessStore } from './remote-access-store'

/**
 * Toucan's only network surface: an HTTP listener the phone talks to, off unless the user turned
 * it on.
 *
 * Three properties define it. It is **off by default** and every transition goes through
 * `applySettings`, so one place decides whether a socket is open. It **binds all interfaces**,
 * because reachability is Tailscale's job and narrowing the bind would only break the tailnet
 * address that makes this useful. And it is **gated by one pairing token** rather than by network
 * location: a device on the tailnet is reachable, not trusted, so every `/api` request presents
 * the token as a bearer header and an unauthorized one learns nothing but `401`.
 *
 * The workspace projection is *pushed in* rather than read out. The canvas is the authority on
 * what nodes exist, what they are called and what they are doing, so the renderer publishes a
 * snapshot whenever that changes and this module only serves the latest one. That keeps the host
 * from growing a second, quietly diverging model of the canvas.
 */
export interface RemoteAccessServer {
  state(): RemoteAccessState
  /** Brings the listener into line with the stored settings; the boot path calls this. */
  start(): Promise<RemoteAccessState>
  applySettings(settings: RemoteAccessSettings): Promise<RemoteAccessState>
  regenerateToken(): Promise<RemoteAccessState>
  /** The desktop's latest canvas projection. Replaces the previous one wholesale. */
  publishWorkspace(projection: RemoteWorkspaceProjection): void
  onChange(listener: (state: RemoteAccessState) => void): () => void
  shutdown(): Promise<void>
}

export interface RemoteAccessServerOptions {
  store: RemoteAccessStore
  /** Directory holding the built mobile client, served at `/`. */
  clientRoot: string
  addresses?: () => RemoteAccessAddress[]
  now?: () => number
}

const UNAUTHORIZED_BODY = JSON.stringify({ error: 'unauthorized' })

export function createRemoteAccessServer(options: RemoteAccessServerOptions): RemoteAccessServer {
  const readAddresses = options.addresses ?? describeHostAddresses
  const now = options.now ?? Date.now
  const listeners = new Set<(state: RemoteAccessState) => void>()
  let snapshot: RemoteWorkspaceSnapshot = EMPTY_REMOTE_WORKSPACE_SNAPSHOT
  let server: Server | null = null
  let boundPort: number | undefined
  let error: string | undefined

  const state = (): RemoteAccessState => {
    const record = options.store.read()
    return {
      settings: record.settings,
      token: record.token,
      tokenUpdatedAt: record.tokenUpdatedAt,
      listening: server !== null,
      addresses: readAddresses(),
      ...(boundPort === undefined ? {} : { boundPort }),
      ...(error === undefined ? {} : { error })
    }
  }

  const publishState = (): RemoteAccessState => {
    const next = state()
    for (const listener of listeners) listener(next)
    return next
  }

  const authorized = (headers: IncomingMessage['headers']): boolean =>
    pairingTokenMatches(options.store.read().token, presentedPairingToken(headers))

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const route = resolveRemoteRoute(request.method, request.url)
    if (routeRequiresPairing(route) && !authorized(request.headers)) {
      // Deliberately featureless: whether the token was missing, malformed or simply wrong is not
      // information an unauthorized caller gets to collect.
      response.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(UNAUTHORIZED_BODY),
        'www-authenticate': 'Bearer',
        'cache-control': 'no-store'
      })
      response.end(request.method === 'HEAD' ? undefined : UNAUTHORIZED_BODY)
      return
    }

    switch (route.kind) {
      case 'pairing':
        response.writeHead(204, { 'cache-control': 'no-store' })
        response.end()
        return
      case 'workspace':
        sendJson(request, response, snapshot)
        return
      case 'client':
        await sendClientAsset(request, response, options.clientRoot, route.pathname)
        return
      case 'method-not-allowed':
        response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
        response.end()
        return
      case 'not-found':
        response.writeHead(404, { 'cache-control': 'no-store' })
        response.end()
    }
  }

  /**
   * Reading a chat live is a later ticket, so no socket route exists yet - but the token gate does,
   * and it runs before anything else. An unauthorized upgrade is refused with the same bare 401 an
   * HTTP request gets, so adding the chat socket later cannot accidentally add an unguarded one.
   */
  const handleUpgrade = (request: IncomingMessage, socket: Duplex): void => {
    if (!authorized(request.headers)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nwww-authenticate: Bearer\r\nconnection: close\r\n\r\n')
      return
    }
    socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n')
  }

  const stop = async (): Promise<void> => {
    const running = server
    server = null
    boundPort = undefined
    if (!running) return
    await new Promise<void>((resolve) => running.close(() => resolve()))
  }

  const listen = async (port: number): Promise<void> => {
    const next = createServer((request, response) => {
      void handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500, { 'cache-control': 'no-store' })
        response.end()
      })
    })
    next.on('upgrade', handleUpgrade)

    await new Promise<void>((resolve) => {
      const failed = (cause: Error & { code?: string }): void => {
        error =
          cause.code === 'EADDRINUSE'
            ? `Port ${port} is already in use. Choose another port.`
            : `Could not start the remote server: ${cause.message}`
        next.close()
        resolve()
      }
      next.once('error', failed)
      // No host argument: every interface, because the tailnet address is the point and the
      // pairing token - not the bind address - is what authorizes a caller.
      next.listen(port, () => {
        next.removeListener('error', failed)
        const address = next.address()
        boundPort = typeof address === 'object' && address ? address.port : port
        server = next
        error = undefined
        // A later failure must not leave the state claiming to listen, so the long-lived handler
        // replaces the startup one rather than sharing it.
        next.on('error', (cause: Error) => {
          error = cause.message
          void stop().then(() => publishState())
        })
        resolve()
      })
    })
  }

  const apply = async (settings: RemoteAccessSettings): Promise<RemoteAccessState> => {
    await stop()
    error = undefined
    const problem = remoteAccessPortProblem(settings.port)
    if (problem) {
      error = problem
    } else if (settings.enabled) {
      await listen(settings.port)
    }
    return publishState()
  }

  return {
    state,
    start: () => apply(options.store.read().settings),
    async applySettings(settings): Promise<RemoteAccessState> {
      const problem = remoteAccessPortProblem(settings.port)
      const stored = options.store.saveSettings(settings)
      // A rejected port is reported without being persisted, so a typo cannot strand the listener
      // on a port the user never chose.
      return problem ? apply({ ...stored.settings, port: settings.port }) : apply(stored.settings)
    },
    regenerateToken(): Promise<RemoteAccessState> {
      // Nothing to await: the old token stops being accepted the moment the store holds a new one,
      // and there are no long-lived connections to tear down yet.
      options.store.regenerateToken()
      return Promise.resolve(publishState())
    },
    publishWorkspace(projection): void {
      // The host stamps the clock, so a client can tell how fresh the list is without trusting a
      // timestamp that travelled through the renderer.
      snapshot = { ...projection, updatedAt: now() }
    },
    onChange(listener): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async shutdown(): Promise<void> {
      listeners.clear()
      await stop()
    }
  }
}

function sendJson(request: IncomingMessage, response: ServerResponse, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  response.end(request.method === 'HEAD' ? undefined : payload)
}

/**
 * Serves the built client, falling back to its shell for unknown paths so the phone can reload
 * anywhere. A missing build is reported as such rather than as a 404: the difference between "you
 * never built the client" and "that page does not exist" is the whole diagnosis.
 */
async function sendClientAsset(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  pathname: string
): Promise<void> {
  const resolved = resolveClientAsset(root, pathname)
  if (resolved) {
    const file = await readFileIfPresent(resolved)
    if (file) {
      response.writeHead(200, {
        'content-type': clientContentType(resolved),
        'content-length': file.byteLength,
        'x-content-type-options': 'nosniff',
        // Vite fingerprints everything under /assets, so only the shell must never be cached.
        'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store'
      })
      response.end(request.method === 'HEAD' ? undefined : file)
      return
    }
  }

  const shell = await readFileIfPresent(join(root, 'index.html'))
  if (!shell) {
    const message = 'The Toucan mobile client has not been built. Run "npm run build:mobile" on the host.'
    response.writeHead(503, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': Buffer.byteLength(message),
      'cache-control': 'no-store'
    })
    response.end(request.method === 'HEAD' ? undefined : message)
    return
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': shell.byteLength,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  response.end(request.method === 'HEAD' ? undefined : shell)
}

async function readFileIfPresent(path: string): Promise<Buffer | null> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return null
    return await readFile(path)
  } catch {
    return null
  }
}
