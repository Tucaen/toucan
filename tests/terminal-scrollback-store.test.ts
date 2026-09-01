import { strict as assert } from 'node:assert'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createTerminalScrollbackStore } from '../src/main/terminal-scrollback-store'

test('retains ANSI, control data, and Unicode for the exact terminal incarnation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-scrollback-'))
  const store = createTerminalScrollbackStore({ directory, maxBytes: 1024, maxAgeMs: 60_000, now: () => 100 })

  store.begin('session-a', 'incarnation-a')
  store.append('session-a', 'incarnation-a', '\x1b[31mGrüße 👋\x1b[0m\rprogress\r')

  assert.deepEqual(store.load('session-a'), {
    sessionId: 'session-a',
    incarnationId: 'incarnation-a',
    data: '\x1b[31mGrüße 👋\x1b[0m\rprogress\r',
    capturedAt: 100,
    truncated: false,
    incomplete: false
  })
  assert.equal(store.load('session-b'), null)
})

test('bounds UTF-8 output without splitting characters and makes truncation visible', () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-scrollback-'))
  const store = createTerminalScrollbackStore({ directory, maxBytes: 7, maxAgeMs: 60_000, now: () => 100 })

  store.begin('session', 'inc-1')
  store.append('session', 'inc-1', 'old🙂new')

  const snapshot = store.load('session')
  assert.equal(snapshot?.data, '🙂new')
  assert.equal(snapshot?.truncated, true)
  assert.equal(snapshot?.incomplete, true)
  assert.ok(Buffer.byteLength(snapshot?.data ?? '', 'utf8') <= 7)
})

test('a new incarnation retires old output and stale callbacks cannot append to it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-scrollback-'))
  const store = createTerminalScrollbackStore({ directory, maxBytes: 1024, maxAgeMs: 60_000 })

  store.begin('session', 'inc-1')
  store.append('session', 'inc-1', 'old output')
  store.begin('session', 'inc-2')
  store.append('session', 'inc-1', 'late stale output')
  store.append('session', 'inc-2', 'current output')

  assert.equal(store.load('session')?.incarnationId, 'inc-2')
  assert.equal(store.load('session')?.data, 'current output')
})

test('expired and corrupt history is ignored without throwing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-scrollback-'))
  let now = 100
  const store = createTerminalScrollbackStore({ directory, maxBytes: 1024, maxAgeMs: 50, now: () => now })
  store.begin('expired', 'inc')
  store.append('expired', 'inc', 'gone')
  now = 151
  assert.equal(store.load('expired'), null)

  store.begin('corrupt', 'inc')
  const corruptPath = join(
    directory,
    readdirSync(directory).find((name) => name.endsWith('.json'))!
  )
  writeFileSync(corruptPath, '{ definitely not json', 'utf8')
  const restarted = createTerminalScrollbackStore({ directory, maxBytes: 1024, maxAgeMs: 50, now: () => now })
  assert.doesNotThrow(() => restarted.load('corrupt'))
  assert.equal(restarted.load('corrupt'), null)
  assert.equal(readFileSync(corruptPath, 'utf8'), '{ definitely not json')
})

test('removing a terminal removes its retained history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-scrollback-'))
  const store = createTerminalScrollbackStore({ directory, maxBytes: 1024, maxAgeMs: 60_000 })
  store.begin('session', 'inc')
  store.append('session', 'inc', 'sensitive output')

  assert.equal(store.remove('session'), true)

  assert.equal(store.load('session'), null)
})

test('an interrupted promotion marks a gap and cannot expose a retired incarnation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-scrollback-'))
  const store = createTerminalScrollbackStore({ directory, maxBytes: 1024, maxAgeMs: 60_000 })
  store.begin('session', 'inc-1')
  store.append('session', 'inc-1', 'old output')
  const snapshotPath = join(
    directory,
    readdirSync(directory).find((name) => name.endsWith('.json'))!
  )

  writeFileSync(`${snapshotPath}.pending`, JSON.stringify({ sessionId: 'session', incarnationId: 'inc-1' }), 'utf8')
  const sameIncarnationRestart = createTerminalScrollbackStore({ directory, maxBytes: 1024, maxAgeMs: 60_000 })
  assert.equal(sameIncarnationRestart.load('session')?.incomplete, true)

  writeFileSync(`${snapshotPath}.pending`, JSON.stringify({ sessionId: 'session', incarnationId: 'inc-2' }), 'utf8')
  const newIncarnationRestart = createTerminalScrollbackStore({ directory, maxBytes: 1024, maxAgeMs: 60_000 })
  assert.equal(newIncarnationRestart.load('session'), null)
})
