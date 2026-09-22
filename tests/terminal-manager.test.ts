import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createTerminalManager } from '../src/main/terminal-manager'
import { createTerminalScrollbackStore } from '../src/main/terminal-scrollback-store'
import { createTerminalShell } from '../src/main/terminal-shell'
import type { TerminalLiveness } from '../src/shared/terminal'

test('rejects a session when its project folder no longer exists', () => {
  let spawnCount = 0
  const shell = createTerminalShell({
    environment: {},
    resolveCommand: (command) => (command === 'pwsh.exe' ? 'C:\\Tools\\pwsh.exe' : null)
  })
  const manager = createTerminalManager({
    shell,
    pathExists: () => false,
    pathIsDirectory: () => false,
    spawn: () => {
      spawnCount += 1
      throw new Error('should not spawn')
    }
  })

  assert.deepEqual(
    manager.create(
      {
        id: 'node-1',
        kind: 'terminal',
        cols: 80,
        rows: 24,
        cwd: 'D:\\Deleted'
      },
      { isDestroyed: () => false, send: () => undefined }
    ),
    {
      ok: false,
      message: 'The project folder no longer exists: D:\\Deleted'
    }
  )
  assert.equal(spawnCount, 0)
})

test('keeps session identity stable while replacing each exited process with a new incarnation', () => {
  const exits: Array<(event: { exitCode: number }) => void> = []
  let incarnation = 0
  const manager = createTerminalManager({
    shell: createTerminalShell({
      environment: {},
      resolveCommand: () => 'pwsh.exe'
    }),
    pathExists: () => true,
    pathIsDirectory: () => true,
    createIncarnationId: () => `inc-${++incarnation}`,
    spawn: () => ({
      onData: () => undefined,
      onExit: (listener) => {
        exits.push(listener)
      },
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined
    })
  })
  const owner = { isDestroyed: () => false, send: () => undefined }
  const request = {
    id: 'node',
    sessionId: 'stable-session',
    kind: 'terminal' as const,
    cols: 80,
    rows: 24,
    cwd: 'D:\\Toucan'
  }
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
    shell: createTerminalShell({
      environment: {},
      resolveCommand: () => 'pwsh.exe'
    }),
    pathExists: () => true,
    pathIsDirectory: () => true,
    createIncarnationId: () => `inc-${++incarnation}`,
    spawn: () => {
      const record: (typeof processes)[number] = { writes: [], resizes: [] }
      processes.push(record)
      return {
        onData: (listener) => {
          record.data = listener
        },
        onExit: (listener) => {
          record.exit = listener
        },
        write: (value) => record.writes.push(value),
        resize: (cols, rows) => record.resizes.push([cols, rows]),
        kill: () => undefined
      }
    }
  })
  const owner = {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => events.push({ channel, payload })
  }
  const request = { id: 'node', sessionId: 'stable', kind: 'terminal' as const, cols: 80, rows: 24, cwd: 'D:\\Toucan' }
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
    shell: createTerminalShell({
      environment: {},
      resolveCommand: () => 'pwsh.exe'
    }),
    pathExists: () => true,
    pathIsDirectory: () => true,
    createIncarnationId: () => 'incarnation',
    spawn: () => ({
      onData: () => undefined,
      onExit: (listener) => {
        exit = listener
      },
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined
    })
  })
  const owner = { isDestroyed: () => false, send: () => undefined }
  manager.create({ id: 'node', sessionId: 'session', kind: 'terminal', cols: 80, rows: 24, cwd: 'D:\\Toucan' }, owner)
  manager.disconnectOwner(owner)
  assert.deepEqual(manager.state('session'), { incarnationId: 'incarnation', liveness: 'unverifiable' })
  exit?.({ exitCode: 12 })
  assert.deepEqual(manager.state('session'), { incarnationId: 'incarnation', liveness: 'exited' })
})

test('a retired attachment cannot kill a session reclaimed by a replacement', () => {
  let killed = 0
  const manager = createTerminalManager({
    shell: createTerminalShell({
      environment: {},
      resolveCommand: () => 'pwsh.exe'
    }),
    pathExists: () => true,
    pathIsDirectory: () => true,
    createIncarnationId: () => 'incarnation',
    spawn: () => ({
      onData: () => undefined,
      onExit: () => undefined,
      write: () => undefined,
      resize: () => undefined,
      kill: () => {
        killed += 1
      }
    })
  })
  const owner = { isDestroyed: () => false, send: () => undefined }
  const request = { id: 'node', sessionId: 'session', kind: 'terminal' as const, cols: 80, rows: 24, cwd: 'D:\\Toucan' }
  const first = manager.create({ ...request, attachmentId: 'old-mount' }, owner)
  manager.create({ ...request, attachmentId: 'new-mount' }, owner)

  assert.equal(manager.kill('session', first.incarnationId!, 'old-mount'), false)
  assert.equal(killed, 0)
  assert.equal(manager.kill('session', first.incarnationId!, 'new-mount'), true)
  assert.equal(killed, 1)
})

/** A manager wired to an in-memory stand-in for the durable liveness journal. */
function managerWithJournal(): {
  manager: ReturnType<typeof createTerminalManager>
  recorded: Map<string, { incarnationId: string; liveness: TerminalLiveness }>
  owner: { isDestroyed: () => boolean; send: () => undefined }
  exit: () => void
} {
  const recorded = new Map<string, { incarnationId: string; liveness: TerminalLiveness }>()
  let exitListener: ((event: { exitCode: number }) => void) | undefined
  const manager = createTerminalManager({
    shell: createTerminalShell({
      environment: {},
      resolveCommand: () => 'pwsh.exe'
    }),
    pathExists: () => true,
    pathIsDirectory: () => true,
    createIncarnationId: () => 'incarnation',
    liveness: {
      record: (sessionId, incarnationId, liveness) => recorded.set(sessionId, { incarnationId, liveness }),
      read: (sessionId) => {
        const record = recorded.get(sessionId)
        return record ? { ...record, at: 0 } : null
      },
      remove: (sessionId) => {
        recorded.delete(sessionId)
      }
    },
    spawn: () => ({
      onData: () => undefined,
      onExit: (listener) => {
        exitListener = listener
      },
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined
    })
  })
  return {
    manager,
    recorded,
    owner: { isDestroyed: () => false, send: () => undefined },
    exit: () => exitListener?.({ exitCode: 0 })
  }
}

test('killing every terminal on quit records exited, so the verdict outlives the process that made it', () => {
  const { manager, recorded, owner } = managerWithJournal()
  manager.create({ id: 'node', sessionId: 'session', kind: 'terminal', cols: 80, rows: 24, cwd: 'D:\\Toucan' }, owner)
  assert.deepEqual(recorded.get('session'), { incarnationId: 'incarnation', liveness: 'live' })

  manager.killAll()

  // Toucan issued the kill itself, so the shutdown that destroys the in-memory verdict has
  // already written the durable one; nothing here waits on the exit callback.
  assert.deepEqual(manager.state('session'), { incarnationId: 'incarnation', liveness: 'exited' })
  assert.deepEqual(recorded.get('session'), { incarnationId: 'incarnation', liveness: 'exited' })
})

test('process exit and shutdown flush buffered scrollback before the terminal is retired', () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-scrollback-'))
  const scrollback = createTerminalScrollbackStore({
    directory,
    schedule: () => ({ cancel: () => undefined })
  })
  const dataListeners: Array<(data: string) => void> = []
  const exitListeners: Array<(event: { exitCode: number }) => void> = []
  let incarnation = 0
  const manager = createTerminalManager({
    shell: createTerminalShell({
      environment: {},
      resolveCommand: () => 'pwsh.exe'
    }),
    pathExists: () => true,
    pathIsDirectory: () => true,
    createIncarnationId: () => `inc-${++incarnation}`,
    scrollback,
    spawn: () => ({
      onData: (listener) => dataListeners.push(listener),
      onExit: (listener) => exitListeners.push(listener),
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined
    })
  })
  const owner = { isDestroyed: () => false, send: () => undefined }

  manager.create(
    { id: 'exit-node', sessionId: 'exit-session', kind: 'terminal', cols: 80, rows: 24, cwd: 'D:\\Toucan' },
    owner
  )
  dataListeners[0]('saved on exit')
  assert.equal(createTerminalScrollbackStore({ directory }).load('exit-session')?.data, '')
  exitListeners[0]({ exitCode: 0 })
  assert.equal(createTerminalScrollbackStore({ directory }).load('exit-session')?.data, 'saved on exit')

  manager.create(
    { id: 'quit-node', sessionId: 'quit-session', kind: 'terminal', cols: 80, rows: 24, cwd: 'D:\\Toucan' },
    owner
  )
  dataListeners[1]('saved on shutdown')
  assert.equal(createTerminalScrollbackStore({ directory }).load('quit-session')?.data, '')
  manager.killAll()
  assert.equal(createTerminalScrollbackStore({ directory }).load('quit-session')?.data, 'saved on shutdown')
})

test('losing the renderer records nothing durable because that process is still running', () => {
  const { manager, recorded, owner, exit } = managerWithJournal()
  manager.create({ id: 'node', sessionId: 'session', kind: 'terminal', cols: 80, rows: 24, cwd: 'D:\\Toucan' }, owner)

  manager.disconnectOwner(owner)

  assert.deepEqual(manager.state('session'), { incarnationId: 'incarnation', liveness: 'unverifiable' })
  // Transport loss is not process death: the journal must still say live, or a crash here
  // would restore as exited and claim a running shell is gone.
  assert.deepEqual(recorded.get('session'), { incarnationId: 'incarnation', liveness: 'live' })

  exit()
  assert.deepEqual(recorded.get('session'), { incarnationId: 'incarnation', liveness: 'exited' })
})

test('a read after the process crashed still returns its output, labelled with the exit verdict', () => {
  const datas: Array<(data: string) => void> = []
  const exits: Array<(event: { exitCode: number }) => void> = []
  let incarnation = 0
  const manager = createTerminalManager({
    shell: createTerminalShell({
      environment: {},
      resolveCommand: () => 'pwsh.exe'
    }),
    pathExists: () => true,
    pathIsDirectory: () => true,
    createIncarnationId: () => `inc-${++incarnation}`,
    spawn: () => ({
      onData: (listener) => {
        datas.push(listener)
      },
      onExit: (listener) => {
        exits.push(listener)
      },
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined
    })
  })
  const owner = { isDestroyed: () => false, send: () => undefined }
  const request = {
    id: 'node',
    sessionId: 'dev-server',
    kind: 'terminal' as const,
    cols: 80,
    rows: 24,
    cwd: 'D:\Toucan'
  }
  manager.create(request, owner)
  datas[0]('\u001B[31mError\u001B[0m: build failed\n')
  exits[0]({ exitCode: 1 })

  assert.deepEqual(manager.readOutput('agent-1', 'dev-server'), {
    terminalSessionId: 'dev-server',
    incarnationId: 'inc-1',
    liveness: 'exited',
    text: 'Error: build failed\n',
    delta: false,
    skippedBytes: 0
  })

  // The next read continues where the first stopped, even though the process is long gone.
  assert.deepEqual(manager.readOutput('agent-1', 'dev-server')?.text, '')

  // A restart starts a new stream, so the cursor into the crashed run means nothing any more.
  manager.create(request, owner)
  datas[1]('serving\n')
  const restarted = manager.readOutput('agent-1', 'dev-server')
  assert.equal(restarted?.liveness, 'live')
  assert.equal(restarted?.incarnationId, 'inc-2')
  assert.equal(restarted?.delta, false)
  assert.equal(restarted?.text, 'serving\n')
})

test('a terminal this manager never started reads as nothing, and a retired one stops reading', () => {
  const datas: Array<(data: string) => void> = []
  const manager = createTerminalManager({
    shell: createTerminalShell({
      environment: {},
      resolveCommand: () => 'pwsh.exe'
    }),
    pathExists: () => true,
    pathIsDirectory: () => true,
    createIncarnationId: () => 'inc-1',
    spawn: () => ({
      onData: (listener) => {
        datas.push(listener)
      },
      onExit: () => undefined,
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined
    })
  })

  assert.equal(manager.readOutput('agent-1', 'never-started'), undefined)

  manager.create(
    { id: 'node', sessionId: 'shell', kind: 'terminal', cols: 80, rows: 24, cwd: 'D:\Toucan' },
    { isDestroyed: () => false, send: () => undefined }
  )
  datas[0]('hello\n')
  assert.equal(manager.readOutput('agent-1', 'shell')?.text, 'hello\n')

  manager.forgetSession('shell')
  assert.equal(manager.readOutput('agent-1', 'shell'), undefined)
})
