import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createWatchedDirectories } from '../src/main/watched-directories'

type WatchListener = (eventType: string, filename: string | Buffer | null) => void

const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 25))

interface Fake {
  callbacks: Map<string, WatchListener>
  closed: string[]
  watchDirectory: (path: string, listener: WatchListener) => { close(): void }
}

function fakeWatches(): Fake {
  const callbacks = new Map<string, WatchListener>()
  const closed: string[] = []
  return {
    callbacks,
    closed,
    watchDirectory: (path, listener) => {
      callbacks.set(path, listener)
      return { close: () => closed.push(path) }
    }
  }
}

test('several raw events inside the quiet period publish once per key, to every subscribed owner', async () => {
  const fake = fakeWatches()
  const sent: Array<[string, string]> = []
  const watches = createWatchedDirectories({
    channel: 'test:changed',
    debounceMs: 5,
    watchDirectory: fake.watchDirectory
  })
  watches.subscribe({ isDestroyed: () => false, send: (channel, payload) => sent.push([channel, payload]) })
  watches.open('alpha', { directory: '/roots/alpha' })
  watches.open('beta', { directory: '/roots/beta' })

  const alpha = fake.callbacks.get('/roots/alpha')!
  alpha('rename', 'one.md')
  alpha('change', 'one.md')
  alpha('rename', 'two.md')
  fake.callbacks.get('/roots/beta')!('change', 'other.md')

  await settle()
  assert.deepEqual(sent, [
    ['test:changed', 'alpha'],
    ['test:changed', 'beta']
  ])
})

test('a filename the filter refuses is ignored, and a null filename refreshes anyway', async () => {
  const fake = fakeWatches()
  const sent: string[] = []
  const watches = createWatchedDirectories({
    channel: 'test:changed',
    debounceMs: 5,
    watchDirectory: fake.watchDirectory
  })
  watches.subscribe({ isDestroyed: () => false, send: (_channel, payload) => sent.push(payload) })
  watches.open('docs', { directory: '/docs', matches: (name) => name.endsWith('.md') })

  const listener = fake.callbacks.get('/docs')!
  listener('change', 'notes.txt')
  await settle()
  assert.deepEqual(sent, [])

  listener('rename', null)
  await settle()
  assert.deepEqual(sent, ['docs'])
})

test('owners are sent the payload recorded at open, not the key', async () => {
  const fake = fakeWatches()
  const sent: string[] = []
  const watches = createWatchedDirectories({
    channel: 'test:changed',
    debounceMs: 5,
    watchDirectory: fake.watchDirectory
  })
  watches.subscribe({ isDestroyed: () => false, send: (_channel, payload) => sent.push(payload) })
  watches.open('c:\\docs\\plan.md', { directory: 'C:\\Docs', payload: 'C:\\Docs\\Plan.md' })

  fake.callbacks.get('C:\\Docs')!('change', 'Plan.md')
  await settle()
  assert.deepEqual(sent, ['C:\\Docs\\Plan.md'])
})

test('a destroyed owner is pruned instead of sent, whether subscribed or holding', async () => {
  const fake = fakeWatches()
  let destroyed = false
  const sent: string[] = []
  const unheld: string[] = []
  const watches = createWatchedDirectories({
    channel: 'test:changed',
    debounceMs: 5,
    watchDirectory: fake.watchDirectory,
    onUnheld: (key) => unheld.push(key)
  })
  const owner = { isDestroyed: () => destroyed, send: (_channel: string, payload: string) => sent.push(payload) }
  watches.subscribe(owner)
  watches.open('global', { directory: '/global' })
  watches.hold('held', owner)
  watches.open('held', { directory: '/held' })

  destroyed = true
  fake.callbacks.get('/global')!('change', 'a.md')
  fake.callbacks.get('/held')!('change', 'b.md')
  await settle()
  assert.deepEqual(sent, [])
  // Pruning the last holder is a release signal; pruning a subscriber is not.
  assert.deepEqual(unheld, ['held'])
})

test('an owner both subscribed and holding is sent one change, not two', async () => {
  const fake = fakeWatches()
  const sent: string[] = []
  const watches = createWatchedDirectories({
    channel: 'test:changed',
    debounceMs: 5,
    watchDirectory: fake.watchDirectory
  })
  const owner = { isDestroyed: () => false, send: (_channel: string, payload: string) => sent.push(payload) }
  watches.subscribe(owner)
  watches.hold('a', owner)
  watches.open('a', { directory: '/a' })

  fake.callbacks.get('/a')!('change', 'x.md')
  await settle()
  assert.deepEqual(sent, ['a'])
})

test('holds are counted per owner, and the last one leaving reports the key unheld', () => {
  const unheld: string[] = []
  const watches = createWatchedDirectories({
    channel: 'test:changed',
    watchDirectory: fakeWatches().watchDirectory,
    onUnheld: (key) => unheld.push(key)
  })
  const owner = { isDestroyed: () => false, send: () => {} }
  const other = { isDestroyed: () => false, send: () => {} }
  watches.hold('a', owner)
  watches.hold('a', owner)
  watches.hold('a', other)
  assert.equal(watches.isHeldBy('a', owner), true)

  watches.unhold('a', owner)
  watches.unhold('a', owner)
  assert.equal(watches.isHeldBy('a', owner), false)
  assert.deepEqual(unheld, [])

  watches.unhold('a', other)
  assert.deepEqual(unheld, ['a'])
})

test('disconnecting an owner drops its subscription and every hold it had', () => {
  const unheld: string[] = []
  const watches = createWatchedDirectories({
    channel: 'test:changed',
    watchDirectory: fakeWatches().watchDirectory,
    onUnheld: (key) => unheld.push(key)
  })
  const leaving = { isDestroyed: () => false, send: () => {} }
  const staying = { isDestroyed: () => false, send: () => {} }
  watches.subscribe(leaving)
  watches.subscribe(staying)
  watches.hold('shared', leaving)
  watches.hold('shared', staying)
  watches.hold('alone', leaving)

  watches.disconnectOwner(leaving)
  assert.deepEqual(unheld, ['alone'])
  assert.equal(watches.hasOwners(), true)

  watches.disconnectOwner(staying)
  assert.equal(watches.hasOwners(), false)
})

test('closing a key cancels its pending publish; closeAll releases every handle', async () => {
  const fake = fakeWatches()
  const sent: string[] = []
  const watches = createWatchedDirectories({
    channel: 'test:changed',
    debounceMs: 5,
    watchDirectory: fake.watchDirectory
  })
  watches.subscribe({ isDestroyed: () => false, send: (_channel, payload) => sent.push(payload) })
  watches.open('a', { directory: '/a' })
  watches.open('b', { directory: '/b' })
  assert.equal(watches.has('a'), true)

  fake.callbacks.get('/a')!('change', 'x.md')
  watches.close('a')
  await settle()
  assert.deepEqual(sent, [])
  assert.equal(watches.has('a'), false)
  assert.deepEqual(fake.closed, ['/a'])

  watches.closeAll()
  assert.deepEqual(fake.closed, ['/a', '/b'])
})

test('a watcher error is swallowed rather than raised, and open propagates a watch failure', async () => {
  const listeners = new Map<string, (error: Error) => void>()
  const watches = createWatchedDirectories({
    channel: 'test:changed',
    watchDirectory: (path) => {
      if (path === '/missing') throw new Error('ENOENT')
      return { close: () => {}, on: (_event, listener) => listeners.set(path, listener) }
    }
  })
  watches.open('ok', { directory: '/ok' })
  // The mechanism registered a swallowing error listener, so the emitter cannot take the app down.
  assert.equal(typeof listeners.get('/ok'), 'function')
  listeners.get('/ok')!(new Error('EPERM'))

  assert.throws(() => watches.open('missing', { directory: '/missing' }), /ENOENT/)
  assert.equal(watches.has('missing'), false)
})

test('shutdown closes every watcher and forgets owners and holds without release callbacks', async () => {
  const fake = fakeWatches()
  const sent: string[] = []
  const unheld: string[] = []
  const watches = createWatchedDirectories({
    channel: 'test:changed',
    debounceMs: 5,
    watchDirectory: fake.watchDirectory,
    onUnheld: (key) => unheld.push(key)
  })
  const owner = { isDestroyed: () => false, send: (_channel: string, payload: string) => sent.push(payload) }
  watches.subscribe(owner)
  watches.hold('a', owner)
  watches.open('a', { directory: '/a' })
  fake.callbacks.get('/a')!('change', 'x.md')

  watches.shutdown()
  assert.deepEqual(fake.closed, ['/a'])
  assert.deepEqual(unheld, [])
  await settle()
  assert.deepEqual(sent, [])
  assert.equal(watches.hasOwners(), false)
})
