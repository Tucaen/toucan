import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { createRemoteAccessStore, type RemoteAccessStore } from '../src/main/remote/remote-access-store'
import { createRemoteAccessServer, type RemoteAccessServer } from '../src/main/remote/remote-server'

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

function harness(options: { clientFiles?: Record<string, string> } = {}): Harness {
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
    addresses: () => [{ kind: 'tailscale', host: '100.1.2.3' }]
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
    // Reading a chat over a socket arrives with a later ticket; the gate is what exists now.
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
