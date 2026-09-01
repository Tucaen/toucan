import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBrainDumpChangeWatcher } from '../src/main/brain-dump-watcher'
import type { BrainDumpCollection } from '../src/shared/brain-dump'

test('brain-dump watcher coalesces Markdown changes and publishes their collection', async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'ade-brain-dump-watcher-'))
  const callbacks = new Map<string, (eventType: string, filename: string | Buffer | null) => void>()
  const closed: string[] = []
  const sent: Array<[string, BrainDumpCollection]> = []
  const owner = {
    isDestroyed: () => false,
    send: (channel: string, collection: BrainDumpCollection) => sent.push([channel, collection])
  }

  try {
    const watcher = await createBrainDumpChangeWatcher({
      rootDirectory,
      debounceMs: 5,
      watchDirectory: (path, callback) => {
        callbacks.set(path, callback)
        return { close: () => closed.push(path) }
      }
    })
    watcher.subscribe(owner)

    const active = callbacks.get(join(rootDirectory, 'active'))!
    const archived = callbacks.get(join(rootDirectory, 'archived'))!
    active('rename', '.topic.tmp')
    active('rename', 'topic.md')
    active('change', 'topic.md')
    archived('rename', 'old-topic.md')

    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.deepEqual(sent, [
      ['brain-dump:library-change', 'active'],
      ['brain-dump:library-change', 'archived']
    ])

    watcher.shutdown()
    assert.deepEqual(closed.sort(), [join(rootDirectory, 'active'), join(rootDirectory, 'archived')].sort())
  } finally {
    await rm(rootDirectory, { recursive: true, force: true })
  }
})
