import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  EMPTY_REMOTE_WORKSPACE_SNAPSHOT,
  remoteAccessPortProblem,
  type RemoteAccessAddress,
  type RemoteAccessSettings,
  type RemoteAccessState,
  type RemoteWorkspaceProjection,
  type RemoteWorkspaceSnapshot
} from '../../shared/remote-access'
import {
  parseRemoteChatClientMessage,
  promptTextProblem,
  REMOTE_CHAT_PROMPT_LIMIT,
  REMOTE_CHAT_PROTOCOL,
  tokenFromWebSocketProtocols,
  type RemoteChatServerMessage
} from '../../shared/remote-chat'
import type { AgentPromptResult } from '../../shared/agent'
import type { AgentEventBroker } from '../agent-event-broker'
import { describeHostAddresses } from './host-addresses'
import { pairingTokenMatches, presentedPairingToken } from './pairing'
import {
  clientContentType,
  resolveClientAsset,
  resolveRemoteRoute,
  resolveRemoteSocketRoute,
  routeRequiresPairing
} from './remote-routes'
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
  /**
   * Where live chats are read from: the same broker every session publishes to, so a phone and the
   * desktop renderer observe one stream. Without it every chat socket is refused as not found.
   */
  chats?: Pick<AgentEventBroker, 'subscribe'>
  /**
   * What a phone may *do* to a chat. Narrow on purpose: the remote surface reaches the session
   * manager through this one seam, so the set of operations a paired device can perform is
   * readable in a single type rather than inferred from call sites. Absent, chats are read-only.
   */
  sessions?: RemoteChatSessionOperations
  addresses?: () => RemoteAccessAddress[]
  now?: () => number
}

export interface RemoteChatSessionOperations {
  /**
   * Starts a turn with this text, or refuses - and answers as soon as that is decided, not when
   * the turn ends. The refusal is the load-bearing half: this is deliberately the non-steering,
   * non-queuing prompt path, so a chat that is mid-turn answers `ok: false` and the phone shows
   * why. A prompt is therefore never silently dropped and never injected into a turn in flight.
   */
  prompt(chatId: string, text: string): AgentPromptResult | Promise<AgentPromptResult>
}

/** Local close codes the phone can tell apart from a network drop. */
const CLOSE_SESSION_RETIRED = 4001
const CLOSE_UNAUTHORIZED = 1008

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
      send(request, response, 401, UNAUTHORIZED_BODY, {
        'content-type': 'application/json; charset=utf-8',
        'www-authenticate': 'Bearer'
      })
      return
    }

    switch (route.kind) {
      case 'pairing':
        send(request, response, 204, null)
        return
      case 'workspace':
        send(request, response, 200, JSON.stringify(snapshot), {
          'content-type': 'application/json; charset=utf-8'
        })
        return
      case 'client':
        await sendClientAsset(request, response, options.clientRoot, route.pathname)
        return
      case 'method-not-allowed':
        send(request, response, 405, null, { allow: 'GET, HEAD' })
        return
      case 'not-found':
        send(request, response, 404, null)
    }
  }

  /**
   * The chat sockets. `noServer` because the pairing gate must run before the WebSocket handshake
   * is even attempted; the accepted subprotocol is pinned so a client that offered one gets back
   * the one this host actually speaks.
   */
  const chatSockets = new Set<WebSocket>()
  const socketServer = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(REMOTE_CHAT_PROTOCOL) ? REMOTE_CHAT_PROTOCOL : false),
    // Inbound frames are prompts, and a prompt is bounded (see REMOTE_CHAT_PROMPT_LIMIT). The
    // headroom covers the JSON envelope and multi-byte characters; anything larger is dropped by
    // `ws` before it is buffered rather than after.
    maxPayload: REMOTE_CHAT_PROMPT_LIMIT * 4 + 1024
  })

  /**
   * The inbound half of a chat socket. Only one thing may cross it - a prompt - and every path out
   * of here answers the client: accepted, or refused with a reason. That is the whole no-silent-drop
   * guarantee, and it is why the refusal text is passed through verbatim from the session manager
   * ("The agent session is busy.", "The agent session is not ready.") rather than flattened.
   */
  const handleChatFrame = async (
    chatId: string,
    raw: string | null,
    deliver: (message: RemoteChatServerMessage) => void
  ): Promise<void> => {
    const message = raw === null ? null : parseRemoteChatClientMessage(raw)
    // Unrecognizable, so there is no request to answer. The peer is Toucan's own client, so this
    // is a version skew or a probe, not a case worth inventing a correlation id for.
    if (!message) return

    const refuse = (reason: string): void =>
      deliver({ type: 'prompt_result', requestId: message.requestId, ok: false, message: reason })

    if (!options.sessions) {
      refuse('This host is not accepting messages.')
      return
    }
    // The same predicate the composer greys its button out with, so the two cannot disagree.
    const problem = promptTextProblem(message.text)
    if (problem) {
      refuse(problem)
      return
    }
    // The published projection gates what a phone may drive, exactly as it gates what it may open:
    // a chat the desktop has since unlisted is not a prompt target either.
    if (!snapshot.chats.some((chat) => chat.id === chatId)) {
      refuse('This chat is no longer open on the desktop.')
      return
    }

    try {
      const result = await options.sessions.prompt(chatId, message.text.trim())
      deliver({
        type: 'prompt_result',
        requestId: message.requestId,
        ok: result.ok,
        ...(result.message ? { message: result.message } : {})
      })
    } catch (cause) {
      refuse(cause instanceof Error ? cause.message : 'The host could not deliver the message.')
    }
  }

  const attachChatSocket = (
    connection: WebSocket,
    chats: Pick<AgentEventBroker, 'subscribe'>,
    chatId: string
  ): void => {
    chatSockets.add(connection)
    const deliver = (message: RemoteChatServerMessage): void => {
      if (connection.readyState === connection.OPEN) connection.send(JSON.stringify(message))
    }
    // Subscribe-then-send is atomic on this event loop, so the snapshot and the first tail event
    // cannot race: everything published after the subscription lands strictly after the snapshot.
    const subscription = chats.subscribe(chatId, (event) => deliver({ type: 'event', event }), {
      // The session was retired (killed, or about to be recreated). A silently dead subscription
      // would present a stale transcript as live, so the socket closes and the phone rejoins.
      closed: () => connection.close(CLOSE_SESSION_RETIRED, 'session retired'),
      // A session/load replay folded into the snapshot without fanning out; resend it whole. The
      // client treats every snapshot as a full resync, which is what makes this gap-proof.
      resync: (state) => deliver({ type: 'snapshot', state })
    })
    deliver({ type: 'snapshot', state: subscription.snapshot })
    connection.on('message', (data) => {
      void handleChatFrame(chatId, frameText(data), deliver)
    })
    connection.on('close', () => {
      subscription.unsubscribe()
      chatSockets.delete(connection)
    })
    connection.on('error', () => {
      /* 'close' always follows; the subscription is retired there. */
    })
  }

  /**
   * The token gate runs before any route is considered, so a socket route added later can never be
   * an unguarded one. Browsers cannot set an `Authorization` header on an upgrade, so the token is
   * also accepted from the `Sec-WebSocket-Protocol` list - still a header, never a URL.
   */
  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const presented =
      presentedPairingToken(request.headers) ?? tokenFromWebSocketProtocols(request.headers['sec-websocket-protocol'])
    if (!pairingTokenMatches(options.store.read().token, presented)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nwww-authenticate: Bearer\r\nconnection: close\r\n\r\n')
      return
    }
    const route = resolveRemoteSocketRoute(request.url)
    // The published projection is the authority on what a phone may open: a chat the desktop does
    // not list is not joinable, which also keeps unknown ids from minting ghost broker channels.
    const chats = options.chats
    if (route.kind !== 'chat' || !chats || !snapshot.chats.some((chat) => chat.id === route.chatId)) {
      socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n')
      return
    }
    socketServer.handleUpgrade(request, socket, head, (connection) => attachChatSocket(connection, chats, route.chatId))
  }

  const closeChatSockets = (code: number, reason: string): void => {
    for (const connection of [...chatSockets]) connection.close(code, reason)
  }

  const stop = async (): Promise<void> => {
    const running = server
    server = null
    boundPort = undefined
    if (!running) return
    // `Server.close` waits for open connections and does not know about upgraded sockets at all,
    // so the chat sockets are closed first rather than left to strand the shutdown.
    closeChatSockets(1001, 'server stopping')
    await new Promise<void>((resolve) => running.close(() => resolve()))
  }

  const listen = async (port: number): Promise<void> => {
    const next = createServer((request, response) => {
      void handle(request, response).catch(() => {
        if (!response.headersSent) send(request, response, 500, null)
        else response.end()
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
      // The old token stops being accepted the moment the store holds a new one, and every live
      // chat socket was authorized by that old token, so each one is closed rather than left
      // reading a session its holder is no longer allowed to see.
      options.store.regenerateToken()
      closeChatSockets(CLOSE_UNAUTHORIZED, 'token regenerated')
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

/**
 * Reads one inbound frame as text. `ws` hands over a Buffer (or a fragment array) unless told
 * otherwise, and a binary frame is not something this protocol has any meaning for, so anything
 * that is not decodable text is reported as null and refused rather than coerced.
 */
function frameText(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part))) {
    return Buffer.concat(data as Buffer[]).toString('utf8')
  }
  return null
}

/**
 * The one place a response is written. Every reply on this server is uncached, never sniffed, and
 * carries a body only when the request was not a HEAD - three rules that are easy to get right once
 * and easy to forget per route.
 */
function send(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: string | Buffer | null,
  headers: Record<string, string | number> = {}
): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(body === null ? {} : { 'content-length': Buffer.byteLength(body) }),
    ...headers
  })
  response.end(body === null || request.method === 'HEAD' ? undefined : body)
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
      send(request, response, 200, file, {
        'content-type': clientContentType(resolved),
        // Vite fingerprints everything under /assets, so only the shell must never be cached.
        ...(pathname.startsWith('/assets/') ? { 'cache-control': 'public, max-age=31536000, immutable' } : {})
      })
      return
    }
  }

  const shell = await readFileIfPresent(join(root, 'index.html'))
  if (!shell) {
    const message = 'The Toucan mobile client has not been built. Run "npm run build:mobile" on the host.'
    send(request, response, 503, message, { 'content-type': 'text/plain; charset=utf-8' })
    return
  }
  send(request, response, 200, shell, { 'content-type': 'text/html; charset=utf-8' })
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
