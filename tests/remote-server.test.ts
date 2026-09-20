import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { WebSocket } from 'ws'
import { createAgentEventBroker, type AgentEventBroker } from '../src/main/agent-event-broker'
import { createRemoteAccessStore, type RemoteAccessStore } from '../src/main/remote/remote-access-store'
import {
  createRemoteAccessServer,
  type RemoteAccessServer,
  type RemoteChatRead,
  type RemoteChatSessionOperations,
  type RemoteChatSpawn
} from '../src/main/remote/remote-server'
import { REMOTE_SPAWN_BODY_LIMIT, type RemoteChatSpawnRequest } from '../src/shared/remote-spawn'
import {
  encodePcm16,
  REMOTE_VOICE_BODY_LIMIT,
  REMOTE_VOICE_CONTENT_TYPE,
  type RemoteTranscriptionResult
} from '../src/shared/remote-voice'
import type { AgentEvent, ProviderUsageReport } from '../src/shared/agent'
import type { AgentModelCatalogue } from '../src/shared/agent-model-catalogue'
import { foldAgentEvent, type AgentTranscriptState } from '../src/shared/agent-transcript'
import {
  REMOTE_CHAT_ANSWER_VALUE_LIMIT,
  REMOTE_CHAT_MODEL_ID_LIMIT,
  REMOTE_CHAT_PROMPT_LIMIT,
  REMOTE_CHAT_PROTOCOL,
  parseRemoteChatServerMessage,
  remoteChatBearerProtocol,
  type RemoteChatServerMessage
} from '../src/shared/remote-chat'

/**
 * The listener itself: that it is not there until the user asks for it, that the pairing token is
 * the only way past it, that regenerating the token locks out whoever held the old one, and that
 * the mobile bundle is served without ever letting a path out of its directory.
 *
 * Every test binds a port the operating system just handed out, so a suite run never collides
 * with a real Toucan or with another test. Port 0 is deliberately not used: it is not a port a
 * user may choose, so the settings validation refuses it and the server would too.
 */

const running: RemoteAccessServer[] = []
const directories: string[] = []

afterEach(async () => {
  while (running.length > 0) await running.pop()!.shutdown()
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

/** A port the OS confirmed is free, so "enabled" really does mean a listener came up. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-remote-server-'))
  directories.push(directory)
  return directory
}

interface Harness {
  server: RemoteAccessServer
  store: RemoteAccessStore
  clientRoot: string
  port(): number
  get(path: string, token?: string | null): Promise<{ status: number; body: string; headers: Headers }>
  post(path: string, body: string, token?: string | null): Promise<{ status: number; body: string; headers: Headers }>
}

function harness(
  options: {
    clientFiles?: Record<string, string>
    chats?: AgentEventBroker
    sessions?: RemoteChatSessionOperations
    read?: RemoteChatRead
    spawn?: RemoteChatSpawn
    models?: () => AgentModelCatalogue
    usage?: () => ProviderUsageReport | Promise<ProviderUsageReport>
    transcriber?: { transcribe: (audio: Float32Array) => Promise<RemoteTranscriptionResult> }
  } = {}
): Harness {
  const directory = temporaryDirectory()
  const clientRoot = join(directory, 'mobile')
  mkdirSync(clientRoot, { recursive: true })
  for (const [name, contents] of Object.entries(options.clientFiles ?? {})) {
    const target = join(clientRoot, name)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, contents, 'utf8')
  }

  const store = createRemoteAccessStore({ path: join(directory, 'remote-access.json') })
  const server = createRemoteAccessServer({
    store,
    clientRoot,
    addresses: () => [{ kind: 'tailscale', host: '100.1.2.3' }],
    ...(options.chats ? { chats: options.chats } : {}),
    ...(options.sessions ? { sessions: options.sessions } : {}),
    ...(options.read ? { read: options.read } : {}),
    ...(options.spawn ? { spawn: options.spawn } : {}),
    ...(options.models ? { models: options.models } : {}),
    ...(options.usage ? { usage: options.usage } : {}),
    ...(options.transcriber ? { transcriber: options.transcriber } : {})
  })
  running.push(server)

  const port = (): number => {
    const bound = server.state().boundPort
    assert.ok(bound !== undefined, 'server is not listening')
    return bound
  }

  return {
    server,
    store,
    clientRoot,
    port,
    async get(path, token): Promise<{ status: number; body: string; headers: Headers }> {
      const response = await fetch(`http://127.0.0.1:${port()}${path}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {}
      })
      return { status: response.status, body: await response.text(), headers: response.headers }
    },
    async post(path, body, token): Promise<{ status: number; body: string; headers: Headers }> {
      const response = await fetch(`http://127.0.0.1:${port()}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body
      })
      return { status: response.status, body: await response.text(), headers: response.headers }
    }
  }
}

/** Raw handshake rather than a WebSocket client: what matters is the status line the host writes. */
async function upgrade(port: number, token?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        [
          'GET /api/chats/chat-1 HTTP/1.1',
          `host: 127.0.0.1:${port}`,
          'upgrade: websocket',
          'connection: Upgrade',
          'sec-websocket-version: 13',
          'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==',
          ...(token ? [`authorization: Bearer ${token}`] : []),
          '',
          ''
        ].join('\r\n')
      )
    })
    let received = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => (received += chunk))
    socket.on('error', reject)
    socket.on('close', () => resolve(received))
  })
}

describe('remote access server', () => {
  test('is not listening until the user enables it, and stops when they turn it off', async () => {
    const { server } = harness()

    const port = await freePort()

    await server.start()
    assert.equal(server.state().listening, false)
    assert.equal(server.state().boundPort, undefined)

    await server.applySettings({ enabled: true, port })
    assert.equal(server.state().listening, true)
    assert.equal(server.state().boundPort, port)

    await server.applySettings({ enabled: false, port })
    assert.equal(server.state().listening, false)
  })

  test('a stored enabled setting is what makes the listener come up at boot', async () => {
    const { server, store } = harness()
    store.saveSettings({ enabled: true, port: await freePort() })
    await server.start()
    assert.equal(server.state().listening, true)
  })

  test('the workspace endpoint needs the token and reports the published projection', async () => {
    const { server, store, get } = harness()
    await server.applySettings({ enabled: true, port: await freePort() })
    server.publishWorkspace({
      projects: [{ id: 'toucan', name: 'Toucan', color: '#71a9ff' }],
      chats: [
        { id: 'chat-1', kind: 'claude', title: 'Fix the parser', projectId: 'toucan', status: 'working', unread: 1 }
      ]
    })

    const missing = await get('/api/workspace')
    assert.equal(missing.status, 401)
    assert.equal(missing.headers.get('www-authenticate'), 'Bearer')
    // No detail: an unauthorized caller learns nothing about why.
    assert.equal(missing.body, JSON.stringify({ error: 'unauthorized' }))

    assert.equal((await get('/api/workspace', 'not-the-token')).status, 401)

    const authorized = await get('/api/workspace', store.read().token)
    assert.equal(authorized.status, 200)
    const snapshot = JSON.parse(authorized.body) as { updatedAt: number; chats: { id: string }[] }
    assert.deepEqual(
      snapshot.chats.map((chat) => chat.id),
      ['chat-1']
    )
    assert.ok(snapshot.updatedAt > 0, 'the host stamps the projection it received')
  })

  test('a token in the query string is not a token', async () => {
    const { server, store, get } = harness()
    await server.applySettings({ enabled: true, port: await freePort() })
    assert.equal((await get(`/api/workspace?token=${store.read().token}`)).status, 401)
  })

  test('regenerating the token unauthorizes the client holding the old one', async () => {
    const { server, store, get } = harness()
    await server.applySettings({ enabled: true, port: await freePort() })
    const paired = store.read().token
    assert.equal((await get('/api/pairing', paired)).status, 204)

    await server.regenerateToken()
    assert.equal((await get('/api/pairing', paired)).status, 401)
    assert.equal((await get('/api/pairing', store.read().token)).status, 204)
  })

  test('an unauthorized upgrade is refused before any route is considered', async () => {
    const { server, store } = harness()
    await server.applySettings({ enabled: true, port: await freePort() })

    assert.match(await upgrade(server.state().boundPort!), /^HTTP\/1\.1 401 Unauthorized/)
    // Authorized, but the desktop never listed chat-1 (and no chat source is wired here at all).
    assert.match(await upgrade(server.state().boundPort!, store.read().token), /^HTTP\/1\.1 404 Not Found/)
  })

  test('serves the client bundle unauthenticated and falls back to its shell', async () => {
    const { server, get } = harness({
      clientFiles: { 'index.html': '<!doctype html><title>Toucan</title>', 'assets/app.js': 'console.log(1)' }
    })
    await server.applySettings({ enabled: true, port: await freePort() })

    const shell = await get('/')
    assert.equal(shell.status, 200)
    assert.match(shell.body, /Toucan/)
    assert.match(shell.headers.get('content-type') ?? '', /text\/html/)

    const asset = await get('/assets/app.js')
    assert.equal(asset.status, 200)
    assert.match(asset.headers.get('content-type') ?? '', /javascript/)
    assert.match(asset.headers.get('cache-control') ?? '', /immutable/)

    // A deep link the client routes itself must land on the shell, not on a 404.
    const deep = await get('/chats/chat-1')
    assert.equal(deep.status, 200)
    assert.match(deep.body, /Toucan/)
  })

  test('serves the install surface: the manifest typed as one, and a worker the browser cannot cache', async () => {
    const { server, get } = harness({
      clientFiles: {
        'index.html': '<!doctype html><title>Toucan</title>',
        'manifest.webmanifest': '{"name":"Toucan Companion"}',
        'sw.js': 'self.addEventListener("fetch", () => {})',
        'icon-192.png': 'PNG'
      }
    })
    await server.applySettings({ enabled: true, port: await freePort() })

    // Unauthenticated like the rest of the bundle: a phone cannot set a header on the navigation
    // that loads the pairing screen, and none of these files carry workspace data.
    const manifest = await get('/manifest.webmanifest')
    assert.equal(manifest.status, 200)
    // Chrome refuses a manifest served as anything else, and refuses it silently.
    assert.match(manifest.headers.get('content-type') ?? '', /application\/manifest\+json/)

    const worker = await get('/sw.js')
    assert.equal(worker.status, 200)
    assert.match(worker.headers.get('content-type') ?? '', /javascript/)
    // Unhashed, so it must never be served from the HTTP cache: a cached worker would outlive the
    // bundle it shipped with. Only /assets/ is content-addressed enough to be immutable.
    assert.match(worker.headers.get('cache-control') ?? '', /no-store/)

    const icon = await get('/icon-192.png')
    assert.equal(icon.status, 200)
    assert.match(icon.headers.get('content-type') ?? '', /image\/png/)
  })

  test('a path that escapes the bundle directory cannot read a file', async () => {
    const directory = temporaryDirectory()
    const clientRoot = join(directory, 'mobile')
    mkdirSync(clientRoot, { recursive: true })
    writeFileSync(join(clientRoot, 'index.html'), 'shell', 'utf8')
    writeFileSync(join(directory, 'secret.txt'), 'PAIRING SECRET', 'utf8')

    const server = createRemoteAccessServer({
      store: createRemoteAccessStore({ path: join(directory, 'remote-access.json') }),
      clientRoot
    })
    running.push(server)
    await server.applySettings({ enabled: true, port: await freePort() })

    const response = await fetch(`http://127.0.0.1:${server.state().boundPort}/%2e%2e/secret.txt`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'shell')
  })

  test('a missing client build says so rather than pretending the page is gone', async () => {
    const { server, get } = harness()
    await server.applySettings({ enabled: true, port: await freePort() })
    const response = await get('/')
    assert.equal(response.status, 503)
    assert.match(response.body, /has not been built/)
  })

  test('an unbindable port is reported without leaving a listener behind', async () => {
    const { server } = harness()
    await server.applySettings({ enabled: true, port: await freePort() })
    const taken = server.state().boundPort!

    const second = harness()
    await second.server.applySettings({ enabled: true, port: taken })
    assert.equal(second.server.state().listening, false)
    assert.match(second.server.state().error ?? '', /already in use/)
  })

  test('a rejected port is refused without being stored', async () => {
    const { server, store } = harness()
    await server.applySettings({ enabled: true, port: 80 })
    assert.equal(server.state().listening, false)
    assert.match(server.state().error ?? '', /1024 or higher/)
    assert.equal(store.read().settings.port, 7391)
  })
})

/** One socket under test: messages queue up, and waiting for the next one is a promise. */
interface ChatSocket {
  next(): Promise<RemoteChatServerMessage>
  closed: Promise<{ code: number }>
  rejected: Promise<number>
  /** Writes one raw frame; raw on purpose, so malformed input can be driven at the host too. */
  send(raw: string): Promise<void>
  close(): void
}

function connectChat(port: number, chatId: string, auth: { header?: string; protocolToken?: string }): ChatSocket {
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/api/chats/${chatId}`,
    auth.protocolToken ? [REMOTE_CHAT_PROTOCOL, remoteChatBearerProtocol(auth.protocolToken)] : [],
    { headers: auth.header ? { authorization: `Bearer ${auth.header}` } : {} }
  )
  const queue: RemoteChatServerMessage[] = []
  const waiting: ((message: RemoteChatServerMessage) => void)[] = []
  socket.on('message', (data: Buffer) => {
    const message = parseRemoteChatServerMessage(data.toString('utf8'))
    assert.ok(message, 'the host sent an unparsable frame')
    const waiter = waiting.shift()
    if (waiter) waiter(message)
    else queue.push(message)
  })
  socket.on('error', () => {
    /* handshake rejections surface through `rejected`; a bare error must not crash the test */
  })
  return {
    next: () =>
      new Promise((resolve) => {
        const queued = queue.shift()
        if (queued) resolve(queued)
        else waiting.push(resolve)
      }),
    closed: new Promise((resolve) => socket.on('close', (code: number) => resolve({ code }))),
    rejected: new Promise((resolve) =>
      socket.on('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0)
        response.destroy()
      })
    ),
    send: (raw) => new Promise((resolve, reject) => socket.send(raw, (error) => (error ? reject(error) : resolve()))),
    close: () => socket.close()
  }
}

const CHAT_PROJECTION = {
  projects: [{ id: 'toucan', name: 'Toucan', color: '#71a9ff' }],
  chats: [
    {
      id: 'chat-1',
      kind: 'claude' as const,
      title: 'Fix the parser',
      projectId: 'toucan',
      status: 'working' as const,
      unread: 0
    }
  ]
}

function assistantChunk(messageId: string, text: string): AgentEvent {
  return { type: 'message', role: 'assistant', messageId, text }
}

describe('remote chat socket', () => {
  test('joining a listed chat delivers the snapshot, then the live tail folds to the same transcript', async () => {
    const chats = createAgentEventBroker()
    const { server, store } = harness({ chats })
    await server.applySettings({ enabled: true, port: await freePort() })
    server.publishWorkspace(CHAT_PROJECTION)

    chats.publish('chat-1', { type: 'status', status: 'working' })
    chats.publish('chat-1', assistantChunk('a1', 'first '))

    // The pairing token rides in the subprotocol list: a browser cannot set a header on an upgrade.
    const socket = connectChat(server.state().boundPort!, 'chat-1', { protocolToken: store.read().token })
    const first = await socket.next()
    assert.equal(first.type, 'snapshot')
    let transcript = (first as { state: AgentTranscriptState }).state
    assert.equal(transcript.messages[0]?.text, 'first ')

    chats.publish('chat-1', assistantChunk('a1', 'half'))
    chats.publish('chat-1', { type: 'turn_complete', stopReason: 'end_turn' })

    for (let i = 0; i < 2; i += 1) {
      const message = await socket.next()
      assert.equal(message.type, 'event')
      transcript = foldAgentEvent(transcript, (message as { event: AgentEvent }).event, Date.now())
    }
    // Snapshot + tail converges with the host's own snapshot: no duplicates, no gaps.
    assert.equal(transcript.messages[0]?.text, 'first half')
    assert.equal(transcript.messages[0]?.complete, true)
    assert.equal(chats.snapshot('chat-1')?.messages[0]?.text, 'first half')
    socket.close()
  })

  test('a chat the desktop has not listed is refused even with a valid token', async () => {
    const chats = createAgentEventBroker()
    const { server, store } = harness({ chats })
    await server.applySettings({ enabled: true, port: await freePort() })
    server.publishWorkspace(CHAT_PROJECTION)

    const socket = connectChat(server.state().boundPort!, 'not-a-chat', { header: store.read().token })
    assert.equal(await socket.rejected, 404)
  })

  test('a wrong token in the subprotocol is a 401, not a 404', async () => {
    const chats = createAgentEventBroker()
    const { server } = harness({ chats })
    await server.applySettings({ enabled: true, port: await freePort() })
    server.publishWorkspace(CHAT_PROJECTION)

    const socket = connectChat(server.state().boundPort!, 'chat-1', { protocolToken: 'not-the-token' })
    assert.equal(await socket.rejected, 401)
  })

  test('regenerating the token closes live chat sockets', async () => {
    const chats = createAgentEventBroker()
    const { server, store } = harness({ chats })
    await server.applySettings({ enabled: true, port: await freePort() })
    server.publishWorkspace(CHAT_PROJECTION)

    const socket = connectChat(server.state().boundPort!, 'chat-1', { header: store.read().token })
    assert.equal((await socket.next()).type, 'snapshot')

    await server.regenerateToken()
    const { code } = await socket.closed
    assert.equal(code, 1008)
  })

  test('retiring the session closes the socket so the phone rejoins for a fresh snapshot', async () => {
    const chats = createAgentEventBroker()
    const { server, store } = harness({ chats })
    await server.applySettings({ enabled: true, port: await freePort() })
    server.publishWorkspace(CHAT_PROJECTION)

    const socket = connectChat(server.state().boundPort!, 'chat-1', { header: store.read().token })
    assert.equal((await socket.next()).type, 'snapshot')

    // The desktop's kill-then-recreate cycle: a silently stale socket here is exactly the bug.
    chats.close('chat-1')
    const { code } = await socket.closed
    assert.equal(code, 4001)
  })

  test('a replay folded behind a live subscriber is resynced as a fresh snapshot', async () => {
    const chats = createAgentEventBroker()
    const { server, store } = harness({ chats })
    await server.applySettings({ enabled: true, port: await freePort() })
    server.publishWorkspace(CHAT_PROJECTION)

    const socket = connectChat(server.state().boundPort!, 'chat-1', { header: store.read().token })
    assert.equal((await socket.next()).type, 'snapshot')

    // A session resumed on the desktop replays its history through `fold`, which never fans out;
    // the create result is when every remote subscriber is handed the settled transcript again.
    chats.fold('chat-1', { type: 'message', role: 'user', messageId: 'u1', text: 'question' })
    chats.fold('chat-1', assistantChunk('a1', 'replayed answer'))
    chats.applyCreateResult('chat-1', { ok: true, status: 'ready', sessionId: 's-1' })

    const resynced = await socket.next()
    assert.equal(resynced.type, 'snapshot')
    const state = (resynced as { state: AgentTranscriptState }).state
    assert.equal(state.messages.length, 2)
    assert.equal(state.messages[1]?.text, 'replayed answer')
    assert.equal(state.messages[1]?.complete, true)
    socket.close()
  })

  test('disabling the listener closes live chat sockets instead of stranding them', async () => {
    const chats = createAgentEventBroker()
    const { server, store } = harness({ chats })
    const port = await freePort()
    await server.applySettings({ enabled: true, port })
    server.publishWorkspace(CHAT_PROJECTION)

    const socket = connectChat(server.state().boundPort!, 'chat-1', { header: store.read().token })
    assert.equal((await socket.next()).type, 'snapshot')

    await server.applySettings({ enabled: false, port })
    await socket.closed
    assert.equal(server.state().listening, false)
  })
})

/**
 * Sending from the phone. Every path out of an inbound frame answers the client - accepted, or
 * refused with a reason - because a prompt that vanishes without a verdict is the one outcome the
 * composer cannot recover from. The refused-while-busy case is the policy: the host does not
 * queue and does not steer, it says no out loud.
 */

/** The next frame, asserted to be a verdict, so the union is narrowed once per call site. */
async function verdict(socket: ChatSocket): Promise<{ requestId: string; ok: boolean; message?: string }> {
  const message = await socket.next()
  assert.equal(message.type, 'prompt_result')
  return message as { requestId: string; ok: boolean; message?: string }
}

interface RecordedPrompt {
  chatId: string
  text: string
}

function recordingSessions(outcome: (prompt: RecordedPrompt) => { ok: boolean; message?: string }): {
  operations: RemoteChatSessionOperations
  prompts: RecordedPrompt[]
} {
  const prompts: RecordedPrompt[] = []
  return {
    prompts,
    operations: {
      prompt: (chatId, text) => {
        const recorded = { chatId, text }
        prompts.push(recorded)
        return outcome(recorded)
      },
      ...refusingAnswers
    }
  }
}

/** Answering is exercised by its own recorder; a prompt test must not accidentally drive it. */
const refusingAnswers = {
  approve: () => ({ ok: false, message: 'not under test' }),
  answerDecision: () => ({ ok: false, message: 'not under test' }),
  setModel: () => ({ ok: false, message: 'not under test' })
}

async function joinedChat(options: {
  sessions?: RemoteChatSessionOperations
  read?: RemoteChatRead
}): Promise<{ server: RemoteAccessServer; chats: AgentEventBroker; socket: ChatSocket }> {
  const chats = createAgentEventBroker()
  const { server, store } = harness({
    chats,
    ...(options.sessions ? { sessions: options.sessions } : {}),
    ...(options.read ? { read: options.read } : {})
  })
  await server.applySettings({ enabled: true, port: await freePort() })
  server.publishWorkspace(CHAT_PROJECTION)
  const socket = connectChat(server.state().boundPort!, 'chat-1', { header: store.read().token })
  assert.equal((await socket.next()).type, 'snapshot')
  return { server, chats, socket }
}

describe('sending a message over a chat socket', () => {
  test('a prompt reaches the session and its acceptance is reported back', async () => {
    const sessions = recordingSessions(() => ({ ok: true }))
    const { socket } = await joinedChat({ sessions: sessions.operations })

    await socket.send(JSON.stringify({ type: 'prompt', requestId: 'r1', text: '  ship it  ' }))
    assert.deepEqual(await verdict(socket), { type: 'prompt_result', requestId: 'r1', ok: true })
    // Trimmed once, on the host, so every client sends the same message the desktop would.
    assert.deepEqual(sessions.prompts, [{ chatId: 'chat-1', text: 'ship it' }])
    socket.close()
  })

  test('the sent message echoes to every subscriber as an event, not as a host-invented bubble', async () => {
    const sessions = recordingSessions(() => ({ ok: true }))
    const { chats, socket } = await joinedChat({ sessions: sessions.operations })

    await socket.send(JSON.stringify({ type: 'prompt', requestId: 'r1', text: 'ship it' }))
    assert.equal((await verdict(socket)).ok, true)

    // What the provider echoes is the one source of the user bubble, shared by phone and desktop.
    chats.publish('chat-1', { type: 'message', role: 'user', messageId: 'u1', text: 'ship it' })
    const echoed = await socket.next()
    assert.deepEqual(echoed, {
      type: 'event',
      event: { type: 'message', role: 'user', messageId: 'u1', text: 'ship it' }
    })
    assert.equal(chats.snapshot('chat-1')?.messages.length, 1)
    socket.close()
  })

  test('a busy session refuses with its own reason rather than queueing or steering', async () => {
    const sessions = recordingSessions(() => ({ ok: false, message: 'The agent session is busy.' }))
    const { socket } = await joinedChat({ sessions: sessions.operations })

    await socket.send(JSON.stringify({ type: 'prompt', requestId: 'r1', text: 'and also this' }))
    assert.deepEqual(await verdict(socket), {
      type: 'prompt_result',
      requestId: 'r1',
      ok: false,
      message: 'The agent session is busy.'
    })
    socket.close()
  })

  test('a host with no session operations answers read-only instead of swallowing the prompt', async () => {
    const { socket } = await joinedChat({})
    await socket.send(JSON.stringify({ type: 'prompt', requestId: 'r1', text: 'ship it' }))
    assert.equal((await verdict(socket)).ok, false)
    socket.close()
  })

  test('an empty or oversized prompt is refused without reaching the session', async () => {
    const sessions = recordingSessions(() => ({ ok: true }))
    const { socket } = await joinedChat({ sessions: sessions.operations })

    await socket.send(JSON.stringify({ type: 'prompt', requestId: 'r1', text: '   ' }))
    // The wording is the shared predicate's, so the host refuses in exactly the words the phone
    // greys its own button out with.
    assert.equal((await verdict(socket)).message, 'Type a message first.')

    await socket.send(
      JSON.stringify({ type: 'prompt', requestId: 'r2', text: 'x'.repeat(REMOTE_CHAT_PROMPT_LIMIT + 1) })
    )
    assert.match((await verdict(socket)).message ?? '', /at most/)

    assert.deepEqual(sessions.prompts, [])
    socket.close()
  })

  test('a chat the desktop has since unlisted is not a prompt target either', async () => {
    const sessions = recordingSessions(() => ({ ok: true }))
    const chats = createAgentEventBroker()
    const { server, store } = harness({ chats, sessions: sessions.operations })
    await server.applySettings({ enabled: true, port: await freePort() })
    server.publishWorkspace(CHAT_PROJECTION)
    const socket = connectChat(server.state().boundPort!, 'chat-1', { header: store.read().token })
    assert.equal((await socket.next()).type, 'snapshot')

    // The node was closed on the canvas; the socket may still be draining when a send arrives.
    server.publishWorkspace({ projects: CHAT_PROJECTION.projects, chats: [] })
    await socket.send(JSON.stringify({ type: 'prompt', requestId: 'r1', text: 'ship it' }))
    assert.match((await verdict(socket)).message ?? '', /no longer open/)
    assert.deepEqual(sessions.prompts, [])
    socket.close()
  })

  test('a session that throws is reported as a failed send, not as a dead socket', async () => {
    const { socket } = await joinedChat({
      sessions: {
        prompt: () => {
          throw new Error('the adapter went away')
        },
        ...refusingAnswers
      }
    })

    await socket.send(JSON.stringify({ type: 'prompt', requestId: 'r1', text: 'ship it' }))
    assert.deepEqual(await verdict(socket), {
      type: 'prompt_result',
      requestId: 'r1',
      ok: false,
      message: 'the adapter went away'
    })
    socket.close()
  })

  test('a frame that is not a recognizable prompt is ignored, and the socket keeps working', async () => {
    const sessions = recordingSessions(() => ({ ok: true }))
    const { chats, socket } = await joinedChat({ sessions: sessions.operations })

    for (const raw of ['not json', JSON.stringify({ type: 'prompt' }), JSON.stringify({ type: 'mystery' })]) {
      await socket.send(raw)
    }
    // Nothing was acted on, and the live tail still flows: a junk frame is not a fatal one.
    chats.publish('chat-1', assistantChunk('a1', 'still here'))
    assert.equal((await socket.next()).type, 'event')
    assert.deepEqual(sessions.prompts, [])
    socket.close()
  })
})

/**
 * Answering from the phone. The host is the referee: it keys acceptance on the pending request's
 * own id, so two clients answering the same card produce one answer to the agent and one refusal
 * with a reason. Everything else here is the same no-silent-drop rule the prompt path has - an
 * answer that is malformed, oversized, or aimed at an unlisted chat comes back refused rather than
 * disappearing, because a card that never resolves is a chat the reader cannot unblock.
 */

interface RecordedApproval {
  chatId: string
  approvalId: string
  optionId?: string
}

interface RecordedDecision {
  chatId: string
  decisionId: string
  content?: Record<string, unknown>
}

/**
 * Session operations backed by a set of pending request ids, which is exactly how the real manager
 * decides a race: the first answer removes the id, later ones find nothing to answer.
 */
function answeringSessions(pending: readonly string[]): {
  operations: RemoteChatSessionOperations
  approvals: RecordedApproval[]
  decisions: RecordedDecision[]
} {
  const open = new Set(pending)
  const approvals: RecordedApproval[] = []
  const decisions: RecordedDecision[] = []
  const take = (id: string): { ok: boolean; message?: string } =>
    open.delete(id) ? { ok: true } : { ok: false, message: 'That request was already answered.' }
  return {
    approvals,
    decisions,
    operations: {
      prompt: () => ({ ok: false, message: 'not under test' }),
      setModel: () => ({ ok: false, message: 'not under test' }),
      approve: (chatId, approvalId, optionId) => {
        approvals.push({ chatId, approvalId, ...(optionId === undefined ? {} : { optionId }) })
        return take(approvalId)
      },
      answerDecision: (chatId, decisionId, content) => {
        decisions.push({ chatId, decisionId, ...(content === undefined ? {} : { content }) })
        return take(decisionId)
      }
    }
  }
}

/** The next frame, asserted to be an *answer* verdict, so a prompt verdict cannot pass for one. */
async function answerVerdict(socket: ChatSocket): Promise<{ requestId: string; ok: boolean; message?: string }> {
  const message = await socket.next()
  assert.equal(message.type, 'answer_result')
  return message as { requestId: string; ok: boolean; message?: string }
}

describe('answering a pending request over a chat socket', () => {
  test('a tool permission answer reaches the session with the option the phone tapped', async () => {
    const sessions = answeringSessions(['approval-1'])
    const { socket } = await joinedChat({ sessions: sessions.operations })

    await socket.send(
      JSON.stringify({ type: 'approval', requestId: 'r1', approvalId: 'approval-1', optionId: 'allow' })
    )
    assert.deepEqual(await answerVerdict(socket), { type: 'answer_result', requestId: 'r1', ok: true })
    assert.deepEqual(sessions.approvals, [{ chatId: 'chat-1', approvalId: 'approval-1', optionId: 'allow' }])
    socket.close()
  })

  test('an answer with no option is a cancellation, not a malformed frame', async () => {
    const sessions = answeringSessions(['approval-1'])
    const { socket } = await joinedChat({ sessions: sessions.operations })

    await socket.send(JSON.stringify({ type: 'approval', requestId: 'r1', approvalId: 'approval-1' }))
    assert.equal((await answerVerdict(socket)).ok, true)
    assert.deepEqual(sessions.approvals, [{ chatId: 'chat-1', approvalId: 'approval-1' }])
    socket.close()
  })

  test('losing the race to the desktop is reported, and the resolution still arrives as an event', async () => {
    const sessions = answeringSessions(['approval-1'])
    const { chats, socket } = await joinedChat({ sessions: sessions.operations })

    // The desktop answered first: the request id is no longer pending by the time this lands.
    sessions.operations.approve('chat-1', 'approval-1', 'allow')
    await socket.send(
      JSON.stringify({ type: 'approval', requestId: 'r1', approvalId: 'approval-1', optionId: 'reject' })
    )
    const refused = await answerVerdict(socket)
    assert.equal(refused.ok, false)
    assert.match(refused.message ?? '', /already answered/)

    // The card retires from the session's own event, the same one the winner sees.
    chats.publish('chat-1', { type: 'approval_resolved', approvalId: 'approval-1' })
    assert.deepEqual(await socket.next(), {
      type: 'event',
      event: { type: 'approval_resolved', approvalId: 'approval-1' }
    })
    socket.close()
  })

  test('a structured answer travels verbatim, and an omitted content is a skip', async () => {
    const sessions = answeringSessions(['decision-1', 'decision-2', 'decision-3'])
    const { socket } = await joinedChat({ sessions: sessions.operations })

    const content = { scope: 'Read-only', tags: ['a', 'b'], retries: 3, verbose: true }
    await socket.send(JSON.stringify({ type: 'decision', requestId: 'r1', decisionId: 'decision-1', content }))
    assert.equal((await answerVerdict(socket)).ok, true)

    await socket.send(JSON.stringify({ type: 'decision', requestId: 'r2', decisionId: 'decision-2' }))
    assert.equal((await answerVerdict(socket)).ok, true)

    // An accept with no fields is a valid answer to a set with nothing required, and it says
    // something different from the skip above: accepted, rather than cancelled.
    await socket.send(JSON.stringify({ type: 'decision', requestId: 'r3', decisionId: 'decision-3', content: {} }))
    assert.equal((await answerVerdict(socket)).ok, true)

    assert.deepEqual(sessions.decisions, [
      { chatId: 'chat-1', decisionId: 'decision-1', content },
      { chatId: 'chat-1', decisionId: 'decision-2' },
      { chatId: 'chat-1', decisionId: 'decision-3', content: {} }
    ])
    socket.close()
  })

  test('an answer value the elicitation contract has no shape for never reaches the session', async () => {
    const sessions = answeringSessions(['decision-1'])
    const { chats, socket } = await joinedChat({ sessions: sessions.operations })

    for (const content of [{ scope: { nested: true } }, { scope: [1, 2] }, { scope: null }]) {
      await socket.send(JSON.stringify({ type: 'decision', requestId: 'r1', decisionId: 'decision-1', content }))
    }
    // Unparsable frames get no verdict (there is no request the host can trust it read), so the
    // proof they were dropped is that the socket still works and nothing was answered.
    chats.publish('chat-1', assistantChunk('a1', 'still here'))
    assert.equal((await socket.next()).type, 'event')
    assert.deepEqual(sessions.decisions, [])
    socket.close()
  })

  test('an oversized structured answer is refused in the words the phone would use', async () => {
    const sessions = answeringSessions(['decision-1'])
    const { socket } = await joinedChat({ sessions: sessions.operations })

    const oversized = { note: 'x'.repeat(REMOTE_CHAT_ANSWER_VALUE_LIMIT + 1) }
    await socket.send(
      JSON.stringify({ type: 'decision', requestId: 'r2', decisionId: 'decision-1', content: oversized })
    )
    assert.match((await answerVerdict(socket)).message ?? '', /at most/)

    assert.deepEqual(sessions.decisions, [])
    socket.close()
  })

  test('a read-only host answers the card instead of leaving it pending forever', async () => {
    const { socket } = await joinedChat({})
    await socket.send(
      JSON.stringify({ type: 'approval', requestId: 'r1', approvalId: 'approval-1', optionId: 'allow' })
    )
    const refused = await answerVerdict(socket)
    assert.equal(refused.ok, false)
    assert.match(refused.message ?? '', /not accepting/)
    socket.close()
  })

  test('a chat the desktop has since unlisted is not an answer target either', async () => {
    const sessions = answeringSessions(['approval-1'])
    const chats = createAgentEventBroker()
    const { server, store } = harness({ chats, sessions: sessions.operations })
    await server.applySettings({ enabled: true, port: await freePort() })
    server.publishWorkspace(CHAT_PROJECTION)
    const socket = connectChat(server.state().boundPort!, 'chat-1', { header: store.read().token })
    assert.equal((await socket.next()).type, 'snapshot')

    server.publishWorkspace({ projects: CHAT_PROJECTION.projects, chats: [] })
    await socket.send(
      JSON.stringify({ type: 'approval', requestId: 'r1', approvalId: 'approval-1', optionId: 'allow' })
    )
    assert.match((await answerVerdict(socket)).message ?? '', /no longer open/)
    assert.deepEqual(sessions.approvals, [])
    socket.close()
  })
})

/**
 * Reporting a read. The only client frame with no verdict, so what the tests have to pin down is
 * that the silence is *deliberate*: the read reaches the canvas seam, the socket stays usable for
 * the frames that do get answered, and neither an unlisted chat nor a host with no canvas attached
 * turns it into an error the phone would have to make sense of.
 */
describe('reporting a chat as read over a chat socket', () => {
  /** A prompt sent after the read, whose verdict proves the socket carried no frame in between. */
  const proveNothingCameBack = async (socket: ChatSocket): Promise<{ ok: boolean; message?: string }> => {
    await socket.send(JSON.stringify({ type: 'prompt', requestId: 'after-read', text: 'still here' }))
    const answer = await verdict(socket)
    assert.equal(answer.requestId, 'after-read')
    return answer
  }

  test('the read reaches the canvas and the socket answers nothing', async () => {
    const reads: string[] = []
    const sessions = recordingSessions(() => ({ ok: true }))
    const { socket } = await joinedChat({ sessions: sessions.operations, read: (chatId) => reads.push(chatId) })

    await socket.send(JSON.stringify({ type: 'read' }))
    assert.equal((await proveNothingCameBack(socket)).ok, true)
    assert.deepEqual(reads, ['chat-1'])
    socket.close()
  })

  test('a chat the desktop has unlisted is not a read target either', async () => {
    const reads: string[] = []
    const sessions = recordingSessions(() => ({ ok: true }))
    const chats = createAgentEventBroker()
    const { server, store } = harness({ chats, sessions: sessions.operations, read: (chatId) => reads.push(chatId) })
    await server.applySettings({ enabled: true, port: await freePort() })
    server.publishWorkspace(CHAT_PROJECTION)
    const socket = connectChat(server.state().boundPort!, 'chat-1', { header: store.read().token })
    assert.equal((await socket.next()).type, 'snapshot')

    server.publishWorkspace({ projects: CHAT_PROJECTION.projects, chats: [] })
    await socket.send(JSON.stringify({ type: 'read' }))
    assert.match((await proveNothingCameBack(socket)).message ?? '', /no longer open/)
    assert.deepEqual(reads, [])
    socket.close()
  })

  // A host with no canvas attached has no attention records to clear, and the phone has nothing to
  // do about that: the frame is accepted and dropped rather than refused.
  test('a host with no canvas seam drops it without breaking the socket', async () => {
    const sessions = recordingSessions(() => ({ ok: true }))
    const { socket } = await joinedChat({ sessions: sessions.operations })

    await socket.send(JSON.stringify({ type: 'read' }))
    assert.equal((await proveNothingCameBack(socket)).ok, true)
    socket.close()
  })
})

/**
 * `POST /api/chats`: the one request that changes the desktop rather than a session.
 *
 * The gates are what matter here. A body is validated before anything is asked of the renderer,
 * the project is checked against the published projection exactly as a chat id is, and the `201`
 * is only ever written for a spawn the desktop said actually came up - because a phone reads that
 * status as permission to navigate.
 */
describe('spawning a chat over HTTP', () => {
  async function spawnHarness(spawn?: RemoteChatSpawn): Promise<Harness> {
    const created = harness(spawn ? { spawn } : {})
    await created.server.applySettings({ enabled: true, port: await freePort() })
    created.server.publishWorkspace(CHAT_PROJECTION)
    return created
  }

  const body = (overrides: Partial<RemoteChatSpawnRequest> = {}): string =>
    JSON.stringify({ projectId: 'toucan', kind: 'claude', ...overrides })

  test('an unpaired caller cannot start a chat', async () => {
    const asked: RemoteChatSpawnRequest[] = []
    const { post } = await spawnHarness(async (request) => {
      asked.push(request)
      return { ok: true, chatId: 'node-1' }
    })

    const response = await post('/api/chats', body(), 'wrong-token')
    assert.equal(response.status, 401)
    // The gate runs before the body is read, so an unauthorized caller cannot reach the desktop.
    assert.deepEqual(asked, [])
  })

  test('a spawn the desktop performed answers with the id it minted', async () => {
    const asked: RemoteChatSpawnRequest[] = []
    const created = await spawnHarness(async (request) => {
      asked.push(request)
      return { ok: true, chatId: 'node-1' }
    })

    const response = await created.post(
      '/api/chats',
      body({ kind: 'codex', input: 'fix it' }),
      created.store.read().token
    )
    assert.equal(response.status, 201)
    assert.deepEqual(JSON.parse(response.body), { chatId: 'node-1' })
    assert.deepEqual(asked, [{ projectId: 'toucan', kind: 'codex', input: 'fix it' }])
  })

  test('a desktop that could not do it refuses in its own words', async () => {
    const created = await spawnHarness(async () => ({
      ok: false,
      message: 'Toucan is not open on the desktop, so there is nothing to start the chat in.'
    }))

    const response = await created.post('/api/chats', body(), created.store.read().token)
    assert.equal(response.status, 503)
    // The reason is passed through verbatim: "no window" and "the session died" are different
    // problems, and flattening them would leave the phone with nothing to act on.
    assert.deepEqual(JSON.parse(response.body), {
      error: 'Toucan is not open on the desktop, so there is nothing to start the chat in.'
    })
  })

  test('a host with no spawn seam says so instead of failing obscurely', async () => {
    const created = await spawnHarness()
    const response = await created.post('/api/chats', body(), created.store.read().token)
    assert.equal(response.status, 503)
    assert.deepEqual(JSON.parse(response.body), { error: 'This host is not accepting new chats.' })
  })

  test('a project the desktop does not list is not a spawn target', async () => {
    const asked: RemoteChatSpawnRequest[] = []
    const created = await spawnHarness(async (request) => {
      asked.push(request)
      return { ok: true, chatId: 'node-1' }
    })

    const response = await created.post('/api/chats', body({ projectId: 'not-listed' }), created.store.read().token)
    assert.equal(response.status, 400)
    assert.deepEqual(JSON.parse(response.body), { error: 'That project is not open on the desktop.' })
    assert.deepEqual(asked, [])
  })

  test('a malformed body and an unsendable prompt are both refused before the desktop is asked', async () => {
    const asked: RemoteChatSpawnRequest[] = []
    const created = await spawnHarness(async (request) => {
      asked.push(request)
      return { ok: true, chatId: 'node-1' }
    })
    const token = created.store.read().token

    const malformed = await created.post('/api/chats', '{"kind":"claude"}', token)
    assert.equal(malformed.status, 400)
    assert.match((JSON.parse(malformed.body) as { error: string }).error, /not a chat this host knows how to start/)

    const blank = await created.post('/api/chats', body({ input: '   ' }), token)
    assert.equal(blank.status, 400)
    assert.equal(JSON.parse(blank.body).error, 'Type a message first.')

    assert.deepEqual(asked, [])
  })

  test('an oversized body is answered rather than buffered', async () => {
    const created = await spawnHarness(async () => ({ ok: true, chatId: 'node-1' }))
    const response = await created.post(
      '/api/chats',
      body({ input: 'x'.repeat(REMOTE_SPAWN_BODY_LIMIT + 1) }),
      created.store.read().token
    )
    assert.equal(response.status, 413)
    assert.deepEqual(JSON.parse(response.body), { error: 'That request was too large to read.' })
  })

  test('the collection is not readable over HTTP; the projection is where chats are listed', async () => {
    const created = await spawnHarness(async () => ({ ok: true, chatId: 'node-1' }))
    const response = await created.get('/api/chats', created.store.read().token)
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'POST')
  })
})

/**
 * The cross-origin half of multiple hosts. The phone is served by one host and holds connections to
 * another, so every reply has to be readable from a page the host did not serve - and the reply that
 * matters most is the `401`, because without CORS headers a browser turns it into an opaque network
 * error and the client cannot tell a revoked token from an unreachable PC.
 */
describe('cross-origin requests from a client another host served', () => {
  async function listening(): Promise<Harness> {
    const created = harness()
    await created.server.applySettings({ enabled: true, port: await freePort() })
    return created
  }

  async function options(port: number, path: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://other-host:1789',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type'
      }
    })
  }

  test('a preflight is answered without the token it is asking permission to send', async () => {
    const created = await listening()
    // The gate cannot apply here: a browser sends the preflight *without* the Authorization header,
    // so requiring the token would refuse every cross-host request before it was ever attempted.
    for (const path of ['/api/workspace', '/api/pairing', '/api/chats']) {
      const response = await options(created.port(), path)
      assert.equal(response.status, 204, path)
      assert.equal(response.headers.get('access-control-allow-origin'), '*')
      assert.match(response.headers.get('access-control-allow-headers') ?? '', /authorization/)
      assert.match(response.headers.get('access-control-allow-methods') ?? '', /POST/)
    }
  })

  test('an authorized reply is readable cross-origin, and grants no ambient authority', async () => {
    const created = await listening()
    created.server.publishWorkspace({ projects: [], chats: [] })
    const response = await created.get('/api/workspace', created.store.read().token)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
    // `*` is only safe because there is nothing ambient to send: no cookies, no session, so a
    // hostile page reaching a tailnet host has no way to be authorized. Allowing credentials
    // alongside `*` would be exactly the mistake this asserts against.
    assert.equal(response.headers.get('access-control-allow-credentials'), null)
  })

  test('a refusal is readable too, so a revoked token does not present itself as an outage', async () => {
    const created = await listening()
    const response = await created.get('/api/workspace', 'not-the-token')
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
  })

  test('the client bundle is served without them: a navigation has no use for CORS', async () => {
    const created = harness({ clientFiles: { 'index.html': '<!doctype html>' } })
    await created.server.applySettings({ enabled: true, port: await freePort() })
    const response = await created.get('/')
    assert.equal(response.status, 200)
    // Scoped to the API and its preflights, which is the spec's "authorized bearer requests" read
    // literally: nothing else on this host is meant to be read cross-origin by script.
    assert.equal(response.headers.get('access-control-allow-origin'), null)
  })

  test('a preflight is not a way past the method rules of the request that follows', async () => {
    const created = await listening()
    // Answering the preflight says what the host permits, not that a `PUT` will be served.
    const response = await fetch(`http://127.0.0.1:${created.port()}/api/workspace`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${created.store.read().token}` }
    })
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'GET, HEAD')
  })
})

/**
 * Dictation from a phone that cannot recognize speech itself: raw PCM in, text out. The gates are
 * ordered so the model is only ever handed audio the contract vouched for - the pairing token first,
 * then the declared media type, then the byte bound as the body arrives, then its shape - and what
 * the desktop could not do comes back in its own words rather than as a generic failure.
 */
describe('transcribing a recording over HTTP', () => {
  type Transcriber = (audio: Float32Array) => Promise<RemoteTranscriptionResult>

  async function voiceHarness(transcribe?: Transcriber): Promise<Harness & { postBytes: PostBytes }> {
    const created = harness(transcribe ? { transcriber: { transcribe } } : {})
    await created.server.applySettings({ enabled: true, port: await freePort() })
    return { ...created, postBytes: postBytesTo(created) }
  }

  type PostBytes = (
    body: Uint8Array<ArrayBuffer>,
    token: string | null,
    contentType?: string
  ) => Promise<{ status: number; body: string }>

  function postBytesTo(created: Harness): PostBytes {
    return async (body, token, contentType = REMOTE_VOICE_CONTENT_TYPE) => {
      const response = await fetch(`http://127.0.0.1:${created.port()}/api/transcribe`, {
        method: 'POST',
        headers: { 'content-type': contentType, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body
      })
      return { status: response.status, body: await response.text() }
    }
  }

  const speech = encodePcm16(new Float32Array(16_000).fill(0.2))

  test('an unpaired caller gets nothing transcribed', async () => {
    let asked = 0
    const { postBytes } = await voiceHarness(async () => {
      asked += 1
      return { ok: true, text: 'hi' }
    })
    const response = await postBytes(speech, 'wrong-token')
    assert.equal(response.status, 401)
    assert.equal(asked, 0)
  })

  test('a recording is decoded to samples and answered with the text', async () => {
    const heard: Float32Array[] = []
    const created = await voiceHarness(async (audio) => {
      heard.push(audio)
      return { ok: true, text: 'fix the parser' }
    })
    const response = await created.postBytes(speech, created.store.read().token)
    assert.equal(response.status, 200)
    assert.deepEqual(JSON.parse(response.body), { text: 'fix the parser' })
    assert.equal(heard.length, 1)
    assert.equal(heard[0].length, 16_000)
    assert.ok(Math.abs(heard[0][100] - 0.2) < 0.001)
  })

  test('a host without a transcriber says so', async () => {
    const created = await voiceHarness()
    const response = await created.postBytes(speech, created.store.read().token)
    assert.equal(response.status, 503)
    assert.deepEqual(JSON.parse(response.body), { error: 'This host does not transcribe dictation.' })
  })

  test('anything but 16 kHz PCM is refused before it is read', async () => {
    let asked = 0
    const created = await voiceHarness(async () => {
      asked += 1
      return { ok: true, text: 'hi' }
    })
    const response = await created.postBytes(speech, created.store.read().token, 'audio/webm')
    assert.equal(response.status, 415)
    assert.match((JSON.parse(response.body) as { error: string }).error, /audio\/L16/)
    assert.equal(asked, 0)
  })

  test('an empty recording and a half-sample one are malformed, not silence', async () => {
    const created = await voiceHarness(async () => ({ ok: true, text: '' }))
    const token = created.store.read().token
    assert.equal((await created.postBytes(new Uint8Array(0), token)).status, 400)
    assert.equal((await created.postBytes(new Uint8Array(3), token)).status, 400)
  })

  test('a recording past the bound is cut off at 413 while it is still arriving', async () => {
    let asked = 0
    const created = await voiceHarness(async () => {
      asked += 1
      return { ok: true, text: 'hi' }
    })
    const response = await created.postBytes(new Uint8Array(REMOTE_VOICE_BODY_LIMIT + 2), created.store.read().token)
    assert.equal(response.status, 413)
    assert.equal(asked, 0)
  })

  test('what the desktop could not transcribe is refused in its own words', async () => {
    const created = await voiceHarness(async () => ({
      ok: false,
      message: 'The desktop has no prepared speech model.'
    }))
    const response = await created.postBytes(speech, created.store.read().token)
    assert.equal(response.status, 503)
    assert.deepEqual(JSON.parse(response.body), { error: 'The desktop has no prepared speech model.' })
  })
})

/**
 * Choosing a model from the phone. This is the one driving frame whose *effect* is not reported on
 * its own channel: the verdict says whether the change was accepted, and the change itself reaches
 * every client as the session's own `models` event - which is what keeps the phone's picker and
 * the desktop's reading one selection rather than two copies.
 */

interface RecordedModelChange {
  chatId: string
  modelId: string
}

function modelSessions(outcome: (change: RecordedModelChange) => { ok: boolean; message?: string }): {
  operations: RemoteChatSessionOperations
  changes: RecordedModelChange[]
} {
  const changes: RecordedModelChange[] = []
  return {
    changes,
    operations: {
      prompt: () => ({ ok: false, message: 'not under test' }),
      approve: () => ({ ok: false, message: 'not under test' }),
      answerDecision: () => ({ ok: false, message: 'not under test' }),
      setModel: (chatId, modelId) => {
        const recorded = { chatId, modelId }
        changes.push(recorded)
        return outcome(recorded)
      }
    }
  }
}

/** The next frame, asserted to be a *model* verdict, so a prompt verdict cannot pass for one. */
async function modelVerdict(socket: ChatSocket): Promise<{ requestId: string; ok: boolean; message?: string }> {
  const message = await socket.next()
  assert.equal(message.type, 'model_result')
  return message as { requestId: string; ok: boolean; message?: string }
}

describe('choosing a model over a chat socket', () => {
  test('a model change reaches the session and is answered on its own channel', async () => {
    const sessions = modelSessions(() => ({ ok: true }))
    const { socket } = await joinedChat({ sessions: sessions.operations })

    await socket.send(JSON.stringify({ type: 'set_model', requestId: 'r1', modelId: 'opus' }))
    assert.deepEqual(await modelVerdict(socket), { type: 'model_result', requestId: 'r1', ok: true })
    assert.deepEqual(sessions.changes, [{ chatId: 'chat-1', modelId: 'opus' }])
    socket.close()
  })

  test('the new selection arrives as the session\u2019s own models event, not in the verdict', async () => {
    const sessions = modelSessions(() => ({ ok: true }))
    const { chats, socket } = await joinedChat({ sessions: sessions.operations })

    await socket.send(JSON.stringify({ type: 'set_model', requestId: 'r1', modelId: 'opus' }))
    assert.equal((await modelVerdict(socket)).ok, true)

    const models = { currentModelId: 'opus', availableModels: [{ id: 'opus', name: 'Opus' }] }
    chats.publish('chat-1', { type: 'models', models })
    assert.deepEqual(await socket.next(), { type: 'event', event: { type: 'models', models } })
    socket.close()
  })

  test('the session manager\u2019s own refusal is passed through verbatim', async () => {
    const sessions = modelSessions(() => ({ ok: false, message: 'This agent does not expose model selection.' }))
    const { socket } = await joinedChat({ sessions: sessions.operations })

    await socket.send(JSON.stringify({ type: 'set_model', requestId: 'r1', modelId: 'opus' }))
    assert.deepEqual(await modelVerdict(socket), {
      type: 'model_result',
      requestId: 'r1',
      ok: false,
      message: 'This agent does not expose model selection.'
    })
    socket.close()
  })

  test('a read-only host answers the pick instead of leaving the picker waiting', async () => {
    const { socket } = await joinedChat({})
    await socket.send(JSON.stringify({ type: 'set_model', requestId: 'r1', modelId: 'opus' }))
    const refused = await modelVerdict(socket)
    assert.equal(refused.ok, false)
    assert.match(refused.message ?? '', /not accepting/)
    socket.close()
  })

  test('a chat the desktop has since unlisted is not a model target either', async () => {
    const sessions = modelSessions(() => ({ ok: true }))
    const chats = createAgentEventBroker()
    const { server, store } = harness({ chats, sessions: sessions.operations })
    await server.applySettings({ enabled: true, port: await freePort() })
    server.publishWorkspace(CHAT_PROJECTION)
    const socket = connectChat(server.state().boundPort!, 'chat-1', { header: store.read().token })
    assert.equal((await socket.next()).type, 'snapshot')

    server.publishWorkspace({ projects: CHAT_PROJECTION.projects, chats: [] })
    await socket.send(JSON.stringify({ type: 'set_model', requestId: 'r1', modelId: 'opus' }))
    assert.match((await modelVerdict(socket)).message ?? '', /no longer open/)
    assert.deepEqual(sessions.changes, [])
    socket.close()
  })

  test('a model id the frame contract refuses never reaches the session', async () => {
    const sessions = modelSessions(() => ({ ok: true }))
    const { chats, socket } = await joinedChat({ sessions: sessions.operations })

    for (const modelId of [42, '', 'x'.repeat(REMOTE_CHAT_MODEL_ID_LIMIT + 1)]) {
      await socket.send(JSON.stringify({ type: 'set_model', requestId: 'r1', modelId }))
    }
    // Unparsable frames get no verdict at all, so the proof they were dropped is that the socket
    // still works and nothing was changed.
    chats.publish('chat-1', assistantChunk('a1', 'still here'))
    assert.equal((await socket.next()).type, 'event')
    assert.deepEqual(sessions.changes, [])
    socket.close()
  })
})

/**
 * Choosing a model for a chat that does not exist yet.
 *
 * The catalogue is the host's answer to a question with no live one - a model list is advertised by
 * a running session, so before a spawn there is only what the desktop last saw. Two rules keep that
 * honest: an empty catalogue is an ordinary answer (a desktop that has never run that agent knows
 * nothing), and a named model is checked against the same catalogue the client picked it from,
 * exactly as a project is checked against the projection it was listed in.
 */

const CATALOGUE = {
  claude: [
    { id: 'sonnet', name: 'Sonnet' },
    { id: 'opus', name: 'Opus' }
  ],
  codex: [{ id: 'gpt-5-codex', name: 'GPT-5 Codex' }]
}

describe('the model catalogue route', () => {
  test('needs the token and reports what the providers were last seen to offer', async () => {
    const { server, store, get } = harness({ models: () => CATALOGUE })
    await server.applySettings({ enabled: true, port: await freePort() })

    assert.equal((await get('/api/models')).status, 401)
    const authorized = await get('/api/models', store.read().token)
    assert.equal(authorized.status, 200)
    assert.deepEqual(JSON.parse(authorized.body), CATALOGUE)
  })

  test('a host that has seen nothing answers an empty catalogue, not an error', async () => {
    const { server, store, get } = harness()
    await server.applySettings({ enabled: true, port: await freePort() })
    const response = await get('/api/models', store.read().token)
    assert.equal(response.status, 200)
    assert.deepEqual(JSON.parse(response.body), {})
  })

  test('it is a read, so anything but GET is refused with what it does accept', async () => {
    const { server, store, post } = harness({ models: () => CATALOGUE })
    await server.applySettings({ enabled: true, port: await freePort() })
    const response = await post('/api/models', '{}', store.read().token)
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'GET, HEAD')
  })
})

const USAGE: ProviderUsageReport = {
  claude: {
    status: { fiveHour: { usedPercent: 42, resetsAt: 1_700_000_000_000 }, weekly: { usedPercent: 91 } },
    readAt: 1_699_999_000_000,
    stale: false
  }
}

/**
 * `GET /api/usage`. Waiting out a plan limit happens away from the desk, so the phone needs the
 * same answer the desktop header shows - and it must not be able to buy that answer with a process
 * spawn on the desktop, which is what makes this read-only and cache-served.
 */
describe('the account usage route', () => {
  test('needs the token and reports each provider reading verbatim', async () => {
    const { server, store, get } = harness({ usage: () => USAGE })
    await server.applySettings({ enabled: true, port: await freePort() })

    assert.equal((await get('/api/usage')).status, 401)
    const authorized = await get('/api/usage', store.read().token)
    assert.equal(authorized.status, 200)
    assert.deepEqual(JSON.parse(authorized.body), USAGE)
  })

  test('a host with no usage reader answers an empty report rather than an error', async () => {
    const { server, store, get } = harness()
    await server.applySettings({ enabled: true, port: await freePort() })
    const response = await get('/api/usage', store.read().token)
    assert.equal(response.status, 200)
    assert.deepEqual(JSON.parse(response.body), {})
  })

  test('a reader that throws costs the reading, not the listener', async () => {
    const { server, store, get } = harness({
      usage: () => {
        throw new Error('the CLI is not installed')
      }
    })
    await server.applySettings({ enabled: true, port: await freePort() })
    const response = await get('/api/usage', store.read().token)
    assert.equal(response.status, 200)
    // Empty rather than a 500: "this desktop cannot read its plan usage" is a state every client
    // already renders, and it is not worth presenting to a phone as the host being broken.
    assert.deepEqual(JSON.parse(response.body), {})
    assert.equal((await get('/api/pairing', store.read().token)).status, 204)
  })

  test('it is a read, so anything but GET is refused with what it does accept', async () => {
    const { server, store, post } = harness({ usage: () => USAGE })
    await server.applySettings({ enabled: true, port: await freePort() })
    const response = await post('/api/usage', '{}', store.read().token)
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'GET, HEAD')
  })

  test('the reading is taken per request, so a phone sees what the desktop has since learnt', async () => {
    let report: ProviderUsageReport = {}
    const { server, store, get } = harness({ usage: () => report })
    await server.applySettings({ enabled: true, port: await freePort() })

    assert.deepEqual(JSON.parse((await get('/api/usage', store.read().token)).body), {})
    report = USAGE
    assert.deepEqual(JSON.parse((await get('/api/usage', store.read().token)).body), USAGE)
  })
})

describe('spawning a chat on a chosen model', () => {
  test('a model the catalogue lists reaches the canvas with the spawn', async () => {
    const spawned: RemoteChatSpawnRequest[] = []
    const { server, store, post } = harness({
      models: () => CATALOGUE,
      spawn: async (request) => {
        spawned.push(request)
        return { ok: true, chatId: 'chat-9' }
      }
    })
    await server.applySettings({ enabled: true, port: await freePort() })
    server.publishWorkspace(CHAT_PROJECTION)

    const response = await post(
      '/api/chats',
      JSON.stringify({ projectId: 'toucan', kind: 'claude', modelId: 'opus' }),
      store.read().token
    )
    assert.equal(response.status, 201)
    assert.deepEqual(spawned, [{ projectId: 'toucan', kind: 'claude', modelId: 'opus' }])
  })

  test('naming no model is the normal case and still spawns', async () => {
    const spawned: RemoteChatSpawnRequest[] = []
    const { server, store, post } = harness({
      models: () => CATALOGUE,
      spawn: async (request) => {
        spawned.push(request)
        return { ok: true, chatId: 'chat-9' }
      }
    })
    await server.applySettings({ enabled: true, port: await freePort() })
    server.publishWorkspace(CHAT_PROJECTION)

    const response = await post(
      '/api/chats',
      JSON.stringify({ projectId: 'toucan', kind: 'claude' }),
      store.read().token
    )
    assert.equal(response.status, 201)
    assert.equal(spawned[0]?.modelId, undefined)
  })

  test('a model this desktop has never seen that agent offer never reaches the canvas', async () => {
    const spawned: RemoteChatSpawnRequest[] = []
    const { server, store, post } = harness({
      models: () => CATALOGUE,
      spawn: async (request) => {
        spawned.push(request)
        return { ok: true, chatId: 'chat-9' }
      }
    })
    await server.applySettings({ enabled: true, port: await freePort() })
    server.publishWorkspace(CHAT_PROJECTION)

    // Invented outright, and - the case that actually happens - the *other* provider's model,
    // since the two share no ids.
    for (const modelId of ['gpt-4', 'gpt-5-codex']) {
      const response = await post(
        '/api/chats',
        JSON.stringify({ projectId: 'toucan', kind: 'claude', modelId }),
        store.read().token
      )
      assert.equal(response.status, 400)
      assert.match((JSON.parse(response.body) as { error: string }).error, /has seen that agent offer/)
    }
    assert.deepEqual(spawned, [])
  })

  test('an empty model id is a malformed body rather than "no preference"', async () => {
    const { server, store, post } = harness({
      models: () => CATALOGUE,
      spawn: async () => ({ ok: true, chatId: 'chat-9' })
    })
    await server.applySettings({ enabled: true, port: await freePort() })
    server.publishWorkspace(CHAT_PROJECTION)

    const response = await post(
      '/api/chats',
      JSON.stringify({ projectId: 'toucan', kind: 'claude', modelId: '' }),
      store.read().token
    )
    assert.equal(response.status, 400)
  })
})
