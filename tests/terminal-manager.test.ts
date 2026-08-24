import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createTerminalManager } from '../src/main/terminal-manager'
import { createSessionProviders } from '../src/main/session-providers'

test('rejects a session when its project folder no longer exists', () => {
  let spawnCount = 0
  const providers = createSessionProviders({
    homeDirectory: 'C:\\Users\\tester',
    environment: {},
    resolveCommand: (command) => command === 'pwsh.exe' ? 'C:\\Tools\\pwsh.exe' : null
  })
  const manager = createTerminalManager({
    providers,
    pathExists: () => false,
    pathIsDirectory: () => false,
    spawn: () => {
      spawnCount += 1
      throw new Error('should not spawn')
    }
  })

  assert.deepEqual(manager.create({
    id: 'node-1',
    kind: 'terminal',
    cols: 80,
    rows: 24,
    cwd: 'D:\\Deleted'
  }, { isDestroyed: () => false, send: () => undefined }), {
    ok: false,
    message: 'The project folder no longer exists: D:\\Deleted'
  })
  assert.equal(spawnCount, 0)
})

test('announces the conversation ID discovered for a new Codex session', async () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'ade-terminal-discovery-test-'))
  const startedAt = Date.now() - 100
  const date = new Date(startedAt)
  const sessionDirectory = join(
    codexHome,
    'sessions',
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  )
  mkdirSync(sessionDirectory, { recursive: true })
  writeFileSync(join(sessionDirectory, 'rollout-conversation-6.jsonl'), `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id: 'conversation-6',
      cwd: 'D:\\Development\\ADE',
      timestamp: new Date(startedAt + 25).toISOString()
    }
  })}\n`, 'utf8')
  const providers = createSessionProviders({
    homeDirectory: 'C:\\Users\\tester',
    environment: { CODEX_HOME: codexHome },
    resolveCommand: (command) => command === 'codex' ? 'C:\\Tools\\codex.exe' : null
  })
  const events: Array<{ channel: string; payload: unknown }> = []
  const manager = createTerminalManager({
    providers,
    now: () => startedAt,
    discoveryIntervalMs: 1,
    pathExists: () => true,
    pathIsDirectory: () => true,
    spawn: () => ({
      onData: () => undefined,
      onExit: () => undefined,
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined
    })
  })

  const result = manager.create({
    id: 'node-2',
    kind: 'codex',
    cols: 80,
    rows: 24,
    cwd: 'D:\\Development\\ADE'
  }, {
    isDestroyed: () => false,
    send: (channel, payload) => events.push({ channel, payload })
  })
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 'node-2')
  assert.ok(result.incarnationId)
  assert.equal(result.liveness, 'live')
  await new Promise((resolve) => setTimeout(resolve, 30))
  manager.killAll()

  assert.deepEqual(events, [{
    channel: 'terminal:session',
    payload: {
      sessionId: 'node-2', incarnationId: result.incarnationId, attachmentId: 'node-2', conversationId: 'conversation-6'
    }
  }])
})

test('keeps session identity stable while replacing each exited process with a new incarnation', () => {
  const exits: Array<(event: { exitCode: number }) => void> = []
  let incarnation = 0
  const manager = createTerminalManager({
    providers: createSessionProviders({ homeDirectory: 'C:\\Users\\tester', environment: {}, resolveCommand: () => 'pwsh.exe' }),
    pathExists: () => true,
    pathIsDirectory: () => true,
    createIncarnationId: () => `inc-${++incarnation}`,
    spawn: () => ({
      onData: () => undefined,
      onExit: (listener) => { exits.push(listener) },
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined
    })
  })
  const owner = { isDestroyed: () => false, send: () => undefined }
  const request = { id: 'node', sessionId: 'stable-session', kind: 'terminal' as const, cols: 80, rows: 24, cwd: 'D:\\ADE' }
  const first = manager.create(request, owner)
  exits[0]({ exitCode: 0 })
  const second = manager.create(request, owner)

  assert.equal(first.sessionId, second.sessionId)
  assert.notEqual(first.incarnationId, second.incarnationId)
})

test('rejects stale input and resize and ignores stale data and exit after replacement', () => {
  const processes: Array<{
    data?: (value: string) => void
    exit?: (event: { exitCode: number }) => void
    writes: string[]
    resizes: Array<[number, number]>
  }> = []
  let incarnation = 0
  const events: Array<{ channel: string; payload: unknown }> = []
  const manager = createTerminalManager({
    providers: createSessionProviders({ homeDirectory: 'C:\\Users\\tester', environment: {}, resolveCommand: () => 'pwsh.exe' }),
    pathExists: () => true,
    pathIsDirectory: () => true,
    createIncarnationId: () => `inc-${++incarnation}`,
    spawn: () => {
      const record: (typeof processes)[number] = { writes: [], resizes: [] }
      processes.push(record)
      return {
        onData: (listener) => { record.data = listener },
        onExit: (listener) => { record.exit = listener },
        write: (value) => record.writes.push(value),
        resize: (cols, rows) => record.resizes.push([cols, rows]),
        kill: () => undefined
      }
    }
  })
  const owner = { isDestroyed: () => false, send: (channel: string, payload: unknown) => events.push({ channel, payload }) }
  const request = { id: 'node', sessionId: 'stable', kind: 'terminal' as const, cols: 80, rows: 24, cwd: 'D:\\ADE' }
  manager.create(request, owner)
  processes[0].exit?.({ exitCode: 0 })
  manager.create(request, owner)
  events.length = 0

  assert.equal(manager.write('stable', 'inc-1', 'stale'), false)
  assert.equal(manager.resize('stable', 'inc-1', 90, 30), false)
  assert.equal(manager.write('stable', 'inc-2', 'current'), true)
  assert.equal(manager.resize('stable', 'inc-2', 100, 40), true)
  processes[0].data?.('late output')
  processes[0].exit?.({ exitCode: 9 })

  assert.deepEqual(processes[0].writes, [])
  assert.deepEqual(processes[1].writes, ['current'])
  assert.deepEqual(processes[1].resizes, [[100, 40]])
  assert.deepEqual(events, [])
  assert.deepEqual(manager.state('stable'), { incarnationId: 'inc-2', liveness: 'live' })
})

test('owner loss is unverifiable while only the process exit callback proves exit', () => {
  let exit: ((event: { exitCode: number }) => void) | undefined
  const manager = createTerminalManager({
    providers: createSessionProviders({ homeDirectory: 'C:\\Users\\tester', environment: {}, resolveCommand: () => 'pwsh.exe' }),
    pathExists: () => true,
    pathIsDirectory: () => true,
    createIncarnationId: () => 'incarnation',
    spawn: () => ({
      onData: () => undefined,
      onExit: (listener) => { exit = listener },
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined
    })
  })
  const owner = { isDestroyed: () => false, send: () => undefined }
  manager.create({ id: 'node', sessionId: 'session', kind: 'terminal', cols: 80, rows: 24, cwd: 'D:\\ADE' }, owner)
  manager.disconnectOwner(owner)
  assert.deepEqual(manager.state('session'), { incarnationId: 'incarnation', liveness: 'unverifiable' })
  exit?.({ exitCode: 12 })
  assert.deepEqual(manager.state('session'), { incarnationId: 'incarnation', liveness: 'exited' })
})

test('a retired attachment cannot kill a session reclaimed by a replacement', () => {
  let killed = 0
  const manager = createTerminalManager({
    providers: createSessionProviders({ homeDirectory: 'C:\\Users\\tester', environment: {}, resolveCommand: () => 'pwsh.exe' }),
    pathExists: () => true,
    pathIsDirectory: () => true,
    createIncarnationId: () => 'incarnation',
    spawn: () => ({
      onData: () => undefined,
      onExit: () => undefined,
      write: () => undefined,
      resize: () => undefined,
      kill: () => { killed += 1 }
    })
  })
  const owner = { isDestroyed: () => false, send: () => undefined }
  const request = { id: 'node', sessionId: 'session', kind: 'terminal' as const, cols: 80, rows: 24, cwd: 'D:\\ADE' }
  const first = manager.create({ ...request, attachmentId: 'old-mount' }, owner)
  manager.create({ ...request, attachmentId: 'new-mount' }, owner)

  assert.equal(manager.kill('session', first.incarnationId!, 'old-mount'), false)
  assert.equal(killed, 0)
  assert.equal(manager.kill('session', first.incarnationId!, 'new-mount'), true)
  assert.equal(killed, 1)
})
