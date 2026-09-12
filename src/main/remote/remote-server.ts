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
  decisionContentProblem,
  parseRemoteChatClientMessage,
  promptTextProblem,
  REMOTE_CHAT_PROMPT_LIMIT,
  REMOTE_CHAT_PROTOCOL,
  tokenFromWebSocketProtocols,
  type RemoteChatClientMessage,
  type RemoteChatServerMessage
} from '../../shared/remote-chat'
import {
  parseRemoteChatSpawnRequest,
  remoteChatSpawnProblem,
  REMOTE_SPAWN_BODY_LIMIT,
  type RemoteChatSpawnRequest,
  type RemoteChatSpawnResult
} from '../../shared/remote-spawn'
import {
  decodePcm16,
  isRemoteVoiceContentType,
  REMOTE_VOICE_BODY_LIMIT,
  REMOTE_VOICE_CONTENT_TYPE,
  REMOTE_VOICE_TOO_LONG_MESSAGE,
  remoteVoiceBodyProblem
} from '../../shared/remote-voice'
import type { AgentDecisionResponseContent, AgentPromptResult } from '../../shared/agent'
import type { AgentEventBroker } from '../agent-event-broker'
import { describeHostAddresses } from './host-addresses'
import { pairingTokenMatches, presentedPairingToken } from './pairing'
import {
  clientContentType,
  REMOTE_CORS_HEADERS,
  resolveClientAsset,
  resolveRemoteRoute,
  resolveRemoteSocketRoute,
  routeRequiresPairing
} from './remote-routes'
import type { RemoteAccessStore } from './remote-access-store'
import type { RemoteVoiceTranscriber } from './voice-transcription'

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
  /**
   * How a chat that does not exist yet is brought into being. Separate from `sessions` because it
   * is not a session operation at all: node identity and geometry are the canvas's, so this seam
   * round-trips through the desktop renderer. Absent, the host cannot start chats and says so.
   */
  spawn?: RemoteChatSpawn
  /**
   * How "a phone read this chat" reaches the attention records behind its unread badge. Separate
   * from `sessions` for the same reason `spawn` is: the record set is the canvas's, not the session
   * manager's, so this seam round-trips through the desktop renderer. Absent, a read frame is
   * accepted and dropped - the phone is told nothing either way, and the badge simply stays.
   */
  read?: RemoteChatRead
  /**
   * Transcribes a phone's recording with the desktop's own speech model, for phones whose browser
   * has no recognizer of its own. Absent, the route says the host does not transcribe.
   */
  transcriber?: Pick<RemoteVoiceTranscriber, 'transcribe'>
  addresses?: () => RemoteAccessAddress[]
  now?: () => number
}

/** Performs one spawn and reports its verdict. Never rejects; a failure is `{ ok: false }`. */
export type RemoteChatSpawn = (request: RemoteChatSpawnRequest) => Promise<RemoteChatSpawnResult>

/**
 * Tells the canvas a paired reader reached this chat. No verdict, because there is none worth
 * having: the read is idempotent, the canvas decides which kinds a *view* clears, and the cleared
 * badge comes back to the phone in the next published projection.
 */
export type RemoteChatRead = (chatId: string) => void

export interface RemoteChatSessionOperations {
  /**
   * Starts a turn with this text, or refuses - and answers as soon as that is decided, not when
   * the turn ends. The refusal is the load-bearing half: this is deliberately the non-steering,
   * non-queuing prompt path, so a chat that is mid-turn answers `ok: false` and the phone shows
   * why. A prompt is therefore never silently dropped and never injected into a turn in flight.
   */
  prompt(chatId: string, text: string): AgentPromptResult | Promise<AgentPromptResult>
  /**
   * Answers a pending tool permission. Race safety is the host's, not the phone's: the operation
   * is keyed on the approval id, so whichever client arrives first is the one acted on and a
   * second answer for the same id is refused. An omitted `optionId` cancels, as on the desktop.
   */
  approve(chatId: string, approvalId: string, optionId?: string): AgentPromptResult | Promise<AgentPromptResult>
  /** Answers a structured question set, or skips it when `content` is omitted. Same race key rule. */
  answerDecision(
    chatId: string,
    decisionId: string,
    content?: AgentDecisionResponseContent
  ): AgentPromptResult | Promise<AgentPromptResult>
  /**
   * Runs the rest of the conversation on another model, or refuses. Deliberately the *same*
   * operation the desktop's picker calls rather than a remote-only variant: whether a model is
   * selectable, and whether this session exposes a model choice at all, is knowledge the session
   * manager holds, so the phone neither re-derives it nor gets a second answer to it. The change
   * is published to every client as the session's own `models` event, so a pick made here is a
   * pick the desktop's picker shows a moment later.
   */
  setModel(chatId: string, modelId: string): AgentPromptResult | Promise<AgentPromptResult>
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

  /**
   * `POST /api/chats`. The only request that changes the canvas rather than a session, and the one
   * place a phone learns about a chat before the workspace projection does.
   *
   * The order of the gates is the point. Shape and size are settled before anything is asked of the
   * desktop, so a malformed body never costs a round-trip; the project is checked against the
   * published projection, exactly as a chat socket checks the chat id, so the canvas stays the
   * authority on what a phone may address; and only then is the spawn performed. The response
   * carries an id only for a session that actually came up - a `201` here is the phone's licence to
   * navigate, so an optimistic one would be a chat that is not there.
   */
  const createChat = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const refuse = (status: number, message: string): void =>
      send(request, response, status, JSON.stringify({ error: message }), {
        'content-type': 'application/json; charset=utf-8'
      })

    const spawn = options.spawn
    if (!spawn) {
      refuse(503, 'This host is not accepting new chats.')
      return
    }
    const body = await readBoundedBody(request, REMOTE_SPAWN_BODY_LIMIT)
    if (body === null) {
      refuse(413, 'That request was too large to read.')
      return
    }
    const spawnRequest = parseRemoteChatSpawnRequest(body)
    if (!spawnRequest) {
      refuse(400, 'That request was not a chat this host knows how to start.')
      return
    }
    const problem = remoteChatSpawnProblem(spawnRequest)
    if (problem) {
      refuse(400, problem)
      return
    }
    if (!snapshot.projects.some((project) => project.id === spawnRequest.projectId)) {
      refuse(400, 'That project is not open on the desktop.')
      return
    }

    const result = await spawn(spawnRequest)
    if (!result.ok) {
      // Everything past the gates above is the *desktop* being unable to comply - no window, a
      // window that closed, a session that died, a project the canvas dropped after the projection
      // said it was there. The request was well-formed and addressable when it was checked, so
      // this is 503 rather than a client error, with the reason passed through verbatim.
      refuse(503, result.message)
      return
    }
    send(request, response, 201, JSON.stringify({ chatId: result.chatId }), {
      'content-type': 'application/json; charset=utf-8'
    })
  }

  /**
   * `POST /api/transcribe`. A phone that cannot recognize speech itself sends what it heard as raw
   * PCM, and gets text back. The gates run cheapest first: the seam, the declared media type, the
   * byte bound while the body arrives (a body that stops arriving is refused the same way, as the
   * spawn route does), then the body's own shape - so the model is only ever handed audio this
   * contract already vouched for. What the model could not do is a 503 in its own words, like a spawn
   * the desktop could not perform: the request was well-formed, the desktop was not able.
   */
  const transcribe = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const refuse = (status: number, message: string): void =>
      send(request, response, status, JSON.stringify({ error: message }), {
        'content-type': 'application/json; charset=utf-8'
      })

    const transcriber = options.transcriber
    if (!transcriber) {
      refuse(503, 'This host does not transcribe dictation.')
      return
    }
    if (!isRemoteVoiceContentType(request.headers['content-type'])) {
      refuse(415, `Dictation must be sent as ${REMOTE_VOICE_CONTENT_TYPE}.`)
      return
    }
    const body = await readBoundedBytes(request, REMOTE_VOICE_BODY_LIMIT)
    if (body === null) {
      refuse(413, REMOTE_VOICE_TOO_LONG_MESSAGE)
      return
    }
    const problem = remoteVoiceBodyProblem(body.byteLength)
    if (problem) {
      refuse(400, problem)
      return
    }
    const result = await transcriber.transcribe(
      decodePcm16(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
    )
    if (!result.ok) {
      refuse(503, result.message)
      return
    }
    send(request, response, 200, JSON.stringify({ text: result.text }), {
      'content-type': 'application/json; charset=utf-8'
    })
  }

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
      case 'create-chat':
        await createChat(request, response)
        return
      case 'transcribe':
        await transcribe(request, response)
        return
      case 'preflight':
        // The CORS headers themselves are added by `send`; what is left to say here is that the
        // question was understood and carries no body.
        send(request, response, 204, null)
        return
      case 'client':
        await sendClientAsset(request, response, options.clientRoot, route.pathname)
        return
      case 'method-not-allowed':
        send(request, response, 405, null, { allow: route.allow })
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
   * The inbound half of a chat socket. Four things *drive* a session across it - a prompt, an
   * answer to a tool permission, an answer to a structured question set, a model change - and every
   * path out of here answers the client: accepted, or refused with a reason. That is the whole no-silent-drop
   * guarantee, and it is why the refusal text is passed through verbatim from the session manager
   * ("The agent session is busy.", "That request was already answered.") rather than flattened.
   *
   * A `read` is the deliberate exception and the only one: it drives nothing, asks for nothing back
   * and cannot fail in a way the reader could act on, so it is answered by the next workspace
   * projection rather than by a frame. Everything else keeps its verdict.
   *
   * Answers are *not* a second prompt path. A pending decision closes the phone's composer, so the
   * only way to answer one is this message, keyed on the request's own id - which is also what
   * makes a race between two clients decidable by the host rather than by whoever rendered last.
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

    /**
     * The published projection gates what a phone may drive, exactly as it gates what it may open:
     * a chat the desktop has since unlisted is not a prompt, an answer or a read target either.
     */
    const listed = (): boolean => snapshot.chats.some((chat) => chat.id === chatId)

    if (message.type === 'read') {
      if (listed()) options.read?.(chatId)
      return
    }

    // Every driving frame is correlated the same way but reported on its own channel, so a client
    // cannot mistake a verdict on one for a verdict on another.
    const resultType =
      message.type === 'prompt' ? 'prompt_result' : message.type === 'set_model' ? 'model_result' : 'answer_result'
    const answer = (result: AgentPromptResult): void =>
      deliver({
        type: resultType,
        requestId: message.requestId,
        ok: result.ok,
        ...(result.message ? { message: result.message } : {})
      })
    const refuse = (reason: string): void => answer({ ok: false, message: reason })

    const sessions = options.sessions
    if (!sessions) {
      refuse('This host is not accepting messages.')
      return
    }
    // The same predicates the phone greys its own controls out with, so the two cannot disagree.
    const problem =
      message.type === 'prompt'
        ? promptTextProblem(message.text)
        : message.type === 'decision' && message.content
          ? decisionContentProblem(message.content)
          : null
    if (problem) {
      refuse(problem)
      return
    }
    if (!listed()) {
      refuse('This chat is no longer open on the desktop.')
      return
    }

    try {
      answer(await perform(sessions, chatId, message))
    } catch (cause) {
      refuse(cause instanceof Error ? cause.message : 'The host could not deliver it.')
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
 * Runs one validated client message against the session operations. Split out so the frame handler
 * reads as the policy it is - gate, then perform, then answer - and so the mapping from message to
 * operation is one exhaustive switch rather than three nested branches. `read` is excluded by type
 * rather than by a default branch: it never reaches a session, so it must not be possible to add a
 * session operation for it here without noticing.
 */
function perform(
  sessions: RemoteChatSessionOperations,
  chatId: string,
  message: Exclude<RemoteChatClientMessage, { type: 'read' }>
): AgentPromptResult | Promise<AgentPromptResult> {
  switch (message.type) {
    case 'prompt':
      // Trimmed once, on the host, so every client sends the message the desktop would have sent.
      return sessions.prompt(chatId, message.text.trim())
    case 'approval':
      return sessions.approve(chatId, message.approvalId, message.optionId)
    case 'decision':
      return sessions.answerDecision(chatId, message.decisionId, message.content)
    case 'set_model':
      return sessions.setModel(chatId, message.modelId)
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
 * Reads a request body, or null once it exceeds `limit`.
 *
 * The bound is enforced while the body arrives rather than after: this is a network surface, so a
 * caller that keeps writing must stop costing memory at the limit, not at the end. Past the limit
 * the remaining bytes are drained and discarded rather than the stream being destroyed, because
 * destroying it takes the socket with it - and the caller still has a `413` to deliver.
 */
async function readBoundedBody(request: IncomingMessage, limit: number): Promise<string | null> {
  const bytes = await readBoundedBytes(request, limit)
  return bytes === null ? null : bytes.toString('utf8')
}

async function readBoundedBytes(request: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const settle = (value: Buffer | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    request.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        chunks.length = 0
        settle(null)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => settle(Buffer.concat(chunks)))
    // A body that never finishes arriving is not a body; the caller refuses it as unreadable.
    request.on('error', () => settle(null))
  })
}

/**
 * The one place a response is written. Every reply on this server is uncached, never sniffed,
 * cross-origin readable, and carries a body only when the request was not a HEAD - four rules that
 * are easy to get right once and easy to forget per route.
 *
 * Cross-origin readability is the default here rather than something each API route opts into. A
 * phone holds connections to hosts that did not serve it (see `REMOTE_CORS_HEADERS`), and the reply
 * a cross-host client most needs to be able to *read* is the `401` - stripping the headers from
 * failures is exactly how a revoked token would present itself as an unreachable host. Only the
 * static bundle opts out, because a navigation has no use for them.
 */
function send(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: string | Buffer | null,
  headers: Record<string, string | number> = {},
  crossOrigin = true
): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(crossOrigin ? REMOTE_CORS_HEADERS : {}),
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
  // Served without CORS headers, unlike every API reply: the bundle is fetched by navigation, so no
  // other origin has reason to read it with script.
  const resolved = resolveClientAsset(root, pathname)
  if (resolved) {
    const file = await readFileIfPresent(resolved)
    if (file) {
      send(
        request,
        response,
        200,
        file,
        {
          'content-type': clientContentType(resolved),
          // Vite fingerprints everything under /assets, so only the shell must never be cached.
          ...(pathname.startsWith('/assets/') ? { 'cache-control': 'public, max-age=31536000, immutable' } : {})
        },
        false
      )
      return
    }
  }

  const shell = await readFileIfPresent(join(root, 'index.html'))
  if (!shell) {
    const message = 'The Toucan mobile client has not been built. Run "npm run build:mobile" on the host.'
    send(request, response, 503, message, { 'content-type': 'text/plain; charset=utf-8' }, false)
    return
  }
  send(request, response, 200, shell, { 'content-type': 'text/html; charset=utf-8' }, false)
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
