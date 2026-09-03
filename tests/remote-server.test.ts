import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { WebSocket } from 'ws'
import { createAgentEventBroker, type AgentEventBroker } from '../src/main/agent-event-broker'
import { createRemoteAccessStore, type RemoteAccessStore } from '../src/main/remote/remote-access-store'
import { createRemoteAccessServer, type RemoteAccessServer } from '../src/main/remote/remote-server'
import type { AgentEvent } from '../src/shared/agent'
import { foldAgentEvent, type AgentTranscriptState } from '../src/shared/agent-transcript'
import {
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
}

function harness(options: { clientFiles?: Record<string, string>; chats?: AgentEventBroker } = {}): Harness {
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
    ...(options.chats ? { chats: options.chats } : {})
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
