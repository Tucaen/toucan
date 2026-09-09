import { strict as assert } from 'node:assert'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createDurableJsonStore, createDurableJsonStoreSync } from '../src/main/durable-json-store'

interface Counter {
  count: number
}

function parseCounter(value: unknown): Counter | null {
  if (!value || typeof value !== 'object') return null
  const counter = value as Partial<Counter>
  return typeof counter.count === 'number' ? { count: counter.count } : null
}

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'toucan-json-store-')), 'nested', 'store.json')
}

function counterStore(path: string) {
  return createDurableJsonStore<Counter>({ path, parse: parseCounter, fallback: () => ({ count: 0 }) })
}

test('a missing file loads as the fallback and is not created by reading', async () => {
  const path = storePath()
  const store = counterStore(path)
  assert.deepEqual(await store.load(), { count: 0 })
  assert.throws(() => readdirSync(join(path, '..')))
})

test('a corrupt or invalid file degrades to the fallback instead of failing', async () => {
  for (const contents of ['{ not json', '{"count":"three"}', '[]']) {
    const path = join(mkdtempSync(join(tmpdir(), 'toucan-json-store-')), 'store.json')
    writeFileSync(path, contents, 'utf8')
    assert.deepEqual(await counterStore(path).load(), { count: 0 })
  }
})

test('a save creates missing directories and a new instance reads it back', async () => {
  const path = storePath()
  await counterStore(path).save({ count: 3 })
  assert.deepEqual(await counterStore(path).load(), { count: 3 })
})

test('saves leave no temp files beside the store', async () => {
  const path = storePath()
  const store = counterStore(path)
  await store.save({ count: 1 })
  await store.save({ count: 2 })
  assert.deepEqual(readdirSync(join(path, '..')), ['store.json'])
})

test('update reads, mutates and persists under one queue, returning its own result', async () => {
  const path = storePath()
  const store = counterStore(path)
  const results = await Promise.all([
    store.update((current) => ({ value: { count: current.count + 1 }, result: 'a' })),
    store.update((current) => ({ value: { count: current.count + 1 }, result: 'b' })),
    store.update((current) => ({ value: { count: current.count + 1 }, result: 'c' }))
  ])
  assert.deepEqual(results, ['a', 'b', 'c'])
  assert.deepEqual(await counterStore(path).load(), { count: 3 })
})

test('an update returning the current value verbatim writes nothing', async () => {
  const path = storePath()
  const store = counterStore(path)
  assert.equal(await store.update((current) => ({ value: current, result: 'kept' })), 'kept')
  await assert.rejects(readFile(path, 'utf8'))
})

test('a failed write rejects its caller and the next save starts clean', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-json-store-'))
  // A file where the parent directory should be makes every write fail until it is removed.
  writeFileSync(join(directory, 'blocked'), '', 'utf8')
  const path = join(directory, 'blocked', 'store.json')
  const store = counterStore(path)

  await assert.rejects(store.save({ count: 1 }))
  rmSync(join(directory, 'blocked'))
  await store.save({ count: 2 })
  assert.deepEqual(await counterStore(path).load(), { count: 2 })
})

test('the sync store reads at creation, falls back on damage, and survives a reopen', () => {
  const path = storePath()
  const first = createDurableJsonStoreSync<Counter>({ path, parse: parseCounter, fallback: () => ({ count: 7 }) })
  assert.deepEqual(first.read(), { count: 7 })
  first.save({ count: 9 })

  const reopened = createDurableJsonStoreSync<Counter>({ path, parse: parseCounter, fallback: () => ({ count: 7 }) })
  assert.deepEqual(reopened.read(), { count: 9 })

  writeFileSync(path, '{ not json', 'utf8')
  const damaged = createDurableJsonStoreSync<Counter>({ path, parse: parseCounter, fallback: () => ({ count: 7 }) })
  assert.deepEqual(damaged.read(), { count: 7 })
})

test('a sync save that cannot reach disk keeps the in-memory value in force', () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-json-store-'))
  writeFileSync(join(directory, 'blocked'), '', 'utf8')
  const store = createDurableJsonStoreSync<Counter>({
    path: join(directory, 'blocked', 'store.json'),
    parse: parseCounter,
    fallback: () => ({ count: 0 })
  })

  store.save({ count: 5 })
  assert.deepEqual(store.read(), { count: 5 })
})
