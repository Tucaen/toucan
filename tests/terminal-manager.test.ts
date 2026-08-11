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

  assert.deepEqual(manager.create({
    id: 'node-2',
    kind: 'codex',
    cols: 80,
    rows: 24,
    cwd: 'D:\\Development\\ADE'
  }, {
    isDestroyed: () => false,
    send: (channel, payload) => events.push({ channel, payload })
  }), { ok: true })
  await new Promise((resolve) => setTimeout(resolve, 30))
  manager.killAll()

  assert.deepEqual(events, [{
    channel: 'terminal:session',
    payload: { id: 'node-2', conversationId: 'conversation-6' }
  }])
})
