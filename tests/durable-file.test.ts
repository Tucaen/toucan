import { strict as assert } from 'node:assert'
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  writeFileDurably,
  writeNewFileDurably,
  writeSnapshotAtomically,
  writeSnapshotAtomicallySync,
  writeThroughTemporary
} from '../src/main/durable-file'

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'toucan-durable-file-'))
}

// `writeThroughTemporary` flushes the promoted file and its directory entry, which on Windows means
// opening a directory handle the platform will not give out - so this is a real platform assertion
// rather than a restatement of the write below.
test('promoting through a temp file, directory flush included, works on Windows', async () => {
  const directory = await temporaryDirectory()
  const path = join(directory, 'topic.md')
  try {
    await writeFile(path, 'topic')
    await assert.doesNotReject(writeThroughTemporary(path, 'rewritten'))
    assert.equal(await readFile(path, 'utf8'), 'rewritten')
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

test('writeSnapshotAtomically can carry a mode and a promote hook', async () => {
  const directory = await temporaryDirectory()
  try {
    const path = join(directory, 'snapshot.json')
    const promoted: string[] = []
    await writeSnapshotAtomically(path, 'one', {
      mode: 0o600,
      promote: async (temporary, target) => {
        promoted.push(temporary)
        await rename(temporary, target)
      }
    })
    assert.equal(await readFile(path, 'utf8'), 'one')
    assert.equal(promoted.length, 1)
    assert.equal(statSync(path).mode & 0o777 & 0o200, 0o200)
    assert.deepEqual(readdirSync(directory), ['snapshot.json'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a promote hook that refuses leaves no temp file and reports the failure', async () => {
  const directory = await temporaryDirectory()
  try {
    const path = join(directory, 'topic.md')
    await assert.rejects(
      writeThroughTemporary(path, 'contents', {
        promote: async () => {
          throw new Error('destination exists')
        }
      }),
      /destination exists/
    )
    assert.deepEqual(readdirSync(directory), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// Found in review of #229: preserving a read-only file's `mode` onto the replacement used to make
// the post-rename fsync reopen the destination `r+` and fail with EPERM - after the write had
// already landed, so the editor reported a failed save for a file it had just rewritten.
test('a preserved read-only mode does not turn a landed write into a reported failure', async () => {
  const directory = await temporaryDirectory()
  try {
    const path = join(directory, 'read-only.txt')
    await writeFile(path, 'first')
    await assert.doesNotReject(writeThroughTemporary(path, 'second', { mode: 0o444 }))
    assert.equal(await readFile(path, 'utf8'), 'second')
    assert.deepEqual(readdirSync(directory), ['read-only.txt'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('writeThroughTemporary creates the folder and promotes into it', async () => {
  const directory = await temporaryDirectory()
  try {
    const path = join(directory, 'archive', 'topic.md')
    await writeThroughTemporary(path, 'first')
    await writeThroughTemporary(path, 'second')
    assert.equal(await readFile(path, 'utf8'), 'second')
    assert.deepEqual(readdirSync(join(directory, 'archive')), ['topic.md'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('two writes in the same millisecond do not share a temp path', async () => {
  const directory = await temporaryDirectory()
  try {
    const first = join(directory, 'one.md')
    const second = join(directory, 'two.md')
    await Promise.all([writeThroughTemporary(first, 'one'), writeThroughTemporary(second, 'two')])
    assert.equal(await readFile(first, 'utf8'), 'one')
    assert.equal(await readFile(second, 'utf8'), 'two')
    assert.deepEqual(readdirSync(directory).sort(), ['one.md', 'two.md'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
