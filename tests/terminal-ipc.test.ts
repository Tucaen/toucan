import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { TERMINAL_CHANNELS } from '../src/shared/ipc-channels'
import { registerTerminalIpc } from '../src/main/terminal-ipc'
import type { TerminalEventOwner } from '../src/main/terminal-events'
import type { TerminalLivenessStore } from '../src/main/terminal-liveness-store'
import type { TerminalManager } from '../src/main/terminal-manager'
import type { TerminalScrollbackStore } from '../src/main/terminal-scrollback-store'
import type { TerminalScrollbackSnapshot } from '../src/shared/terminal'

interface Harness {
  handlers: Map<string, (...args: unknown[]) => unknown>
  ons: Map<string, (...args: unknown[]) => void>
  calls: string[]
  scrollbackRemoved: string[]
  livenessRemoved: string[]
}

const snapshot: TerminalScrollbackSnapshot = {
  sessionId: 's-1',
  incarnationId: 'inc-1',
  data: 'retained',
  capturedAt: 1,
  truncated: false,
  incomplete: false
}

function harness(): Harness {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ons = new Map<string, (...args: unknown[]) => void>()
  const calls: string[] = []
  const scrollbackRemoved: string[] = []
  const livenessRemoved: string[] = []
  const manager: TerminalManager = {
    create: (request, owner) => {
      calls.push(`create:${request.id}:${owner ? 'owned' : 'unowned'}`)
      return { ok: true, sessionId: request.sessionId, incarnationId: 'inc-1' }
    },
    write: (sessionId, incarnationId, data) => {
      calls.push(`write:${sessionId}:${incarnationId}:${data}`)
      return true
    },
    resize: (sessionId, incarnationId, cols, rows) => {
      calls.push(`resize:${sessionId}:${incarnationId}:${cols}x${rows}`)
      return true
    },
    kill: (sessionId, incarnationId, attachmentId) => {
      calls.push(`kill:${sessionId}:${incarnationId}:${attachmentId}`)
      return true
    },
    disconnectOwner: () => {},
    killAll: () => {},
    state: () => undefined,
    readOutput: () => undefined,
    forgetSession: (sessionId) => {
      calls.push(`forget:${sessionId}`)
    }
  }
  const scrollback: TerminalScrollbackStore = {
    begin: () => {},
    append: () => {},
    flush: () => {},
    load: (sessionId) => (sessionId === 's-1' ? snapshot : null),
    remove: (sessionId) => {
      scrollbackRemoved.push(sessionId)
      return sessionId !== 's-stuck'
    }
  }
  const liveness: TerminalLivenessStore = {
    record: () => {},
    read: () => null,
    remove: (sessionId) => void livenessRemoved.push(sessionId)
  }
  registerTerminalIpc(
    {
      handle: (channel, listener) => void handlers.set(channel, listener as (...args: unknown[]) => unknown),
      on: (channel, listener) => void ons.set(channel, listener as (...args: unknown[]) => void)
    },
    manager,
    scrollback,
    liveness,
    { contains: async (path) => path === 'D:/p' }
  )
  return { handlers, ons, calls, scrollbackRemoved, livenessRemoved }
}

const owner: TerminalEventOwner = { isDestroyed: () => false, send: () => {} }
const event = { sender: owner }

test('create hands the request and the asking window to the manager', async () => {
  const { handlers, calls } = harness()
  const result = await handlers.get(TERMINAL_CHANNELS.create)!(event, {
    id: 'n-1',
    sessionId: 's-1',
    kind: 'terminal',
    cols: 80,
    rows: 24,
    cwd: 'D:/p'
  })
  assert.deepEqual(calls, ['create:n-1:owned'])
  assert.deepEqual(result, { ok: true, sessionId: 's-1', incarnationId: 'inc-1' })
})

test('write, resize and kill forward both identity layers', () => {
  const { ons, calls } = harness()
  ons.get(TERMINAL_CHANNELS.write)!(event, 's-1', 'inc-1', 'ls\r')
  ons.get(TERMINAL_CHANNELS.resize)!(event, 's-1', 'inc-1', 120, 30)
  ons.get(TERMINAL_CHANNELS.kill)!(event, 's-1', 'inc-1', 'att-1')
  assert.deepEqual(calls, ['write:s-1:inc-1:ls\r', 'resize:s-1:inc-1:120x30', 'kill:s-1:inc-1:att-1'])
})

test('malformed terminal commands never reach the process', async () => {
  const { handlers, ons, calls } = harness()
  for (const size of [NaN, Infinity, 1.5, -1, '80']) {
    ons.get(TERMINAL_CHANNELS.resize)!(event, 's-1', 'inc-1', size, 24)
    ons.get(TERMINAL_CHANNELS.resize)!(event, 's-1', 'inc-1', 80, size)
    const result = await handlers.get(TERMINAL_CHANNELS.create)!(event, {
      id: 'n-1',
      kind: 'terminal',
      cols: size,
      rows: 24,
      cwd: 'D:/p'
    })
    assert.equal((result as { ok: boolean }).ok, false)
  }
  ons.get(TERMINAL_CHANNELS.write)!(event, 's-1', 'inc-1', {})
  ons.get(TERMINAL_CHANNELS.kill)!(event, 's-1', 'inc-1', undefined)
  assert.deepEqual(calls, [])
})

test('a terminal cannot launch in an unregistered directory', async () => {
  const { handlers, calls } = harness()
  const result = await handlers.get(TERMINAL_CHANNELS.create)!(event, {
    id: 'n-1',
    kind: 'terminal',
    cwd: 'D:/outside',
    cols: 80,
    rows: 24
  })
  assert.equal((result as { ok: boolean }).ok, false)
  assert.deepEqual(calls, [])
})

test('scrollback loads only for a string session id', () => {
  const { handlers } = harness()
  const handler = handlers.get(TERMINAL_CHANNELS.scrollback)!
  assert.equal(handler(event, 's-1'), snapshot)
  assert.equal(handler(event, 7), null)
})

test('removing scrollback retires the liveness verdict and the agent-readable tail with it', () => {
  const { handlers, calls, scrollbackRemoved, livenessRemoved } = harness()
  const handler = handlers.get(TERMINAL_CHANNELS.scrollbackRemove)!
  assert.equal(handler(event, 's-1'), true)
  assert.deepEqual(livenessRemoved, ['s-1'])
  assert.deepEqual(scrollbackRemoved, ['s-1'])
  assert.ok(calls.includes('forget:s-1'))
})

test('a scrollback removal that cannot delete every file reports false, and a bad id touches nothing', () => {
  const { handlers, scrollbackRemoved, livenessRemoved } = harness()
  const handler = handlers.get(TERMINAL_CHANNELS.scrollbackRemove)!
  assert.equal(handler(event, 's-stuck'), false)
  assert.deepEqual(livenessRemoved, ['s-stuck'])
  assert.equal(handler(event, 42), false)
  assert.deepEqual(scrollbackRemoved, ['s-stuck'])
  assert.deepEqual(livenessRemoved, ['s-stuck'])
})
