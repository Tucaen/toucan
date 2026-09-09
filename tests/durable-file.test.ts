import { strict as assert } from 'node:assert'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  syncPromotedFile,
  writeFileDurably,
  writeNewFileDurably,
  writeSnapshotAtomically,
  writeSnapshotAtomicallySync
} from '../src/main/durable-file'

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'toucan-durable-file-'))
}

test('syncing a promoted file works on Windows', async () => {
  const directory = await temporaryDirectory()
  const path = join(directory, 'topic.md')
  try {
    await writeFile(path, 'topic')
    await assert.doesNotReject(syncPromotedFile(path, directory))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('writeNewFileDurably refuses to replace an existing file', async () => {
  const directory = await temporaryDirectory()
  const path = join(directory, 'topic.md')
  try {
    await writeNewFileDurably(path, 'first')
    await assert.rejects(writeNewFileDurably(path, 'second'))
    assert.equal(await readFile(path, 'utf8'), 'first')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('writeFileDurably writes the whole file and unlinks it on failure', async () => {
  const directory = await temporaryDirectory()
  try {
    const path = join(directory, 'file.json')
    await writeFileDurably(path, '{"ok":true}')
    assert.equal(await readFile(path, 'utf8'), '{"ok":true}')

    // A directory in the way makes the open fail; nothing may be left behind.
    const blocked = join(directory, 'blocked')
    mkdirSync(blocked)
    await assert.rejects(writeFileDurably(blocked, 'contents'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('writeSnapshotAtomically replaces the target and leaves no temp file', async () => {
  const directory = await temporaryDirectory()
  try {
    const path = join(directory, 'snapshot.json')
    await writeSnapshotAtomically(path, 'one')
    await writeSnapshotAtomically(path, 'two')
    assert.equal(await readFile(path, 'utf8'), 'two')
    assert.deepEqual(readdirSync(directory), ['snapshot.json'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a failed atomic rename cleans its temp file up and reports the failure', async () => {
  const directory = await temporaryDirectory()
  try {
    // Renaming a file onto a non-empty directory fails on every platform.
    const target = join(directory, 'occupied')
    mkdirSync(target)
    await writeFile(join(target, 'occupant'), '')
    await assert.rejects(writeSnapshotAtomically(target, 'contents'))
    assert.throws(() => writeSnapshotAtomicallySync(target, 'contents', { durable: true }))
    assert.deepEqual(readdirSync(directory), ['occupied'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the sync writer replaces the target atomically with and without a durability barrier', async () => {
  const directory = await temporaryDirectory()
  try {
    const path = join(directory, 'snapshot.json')
    writeSnapshotAtomicallySync(path, 'one', { durable: true })
    writeSnapshotAtomicallySync(path, 'two', { durable: false })
    assert.equal(readFileSync(path, 'utf8'), 'two')
    assert.deepEqual(readdirSync(directory), ['snapshot.json'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
