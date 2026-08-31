import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { syncPromotedFile } from '../src/main/durable-file'

test('syncing a promoted file works on Windows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ade-promoted-file-'))
  const path = join(directory, 'topic.md')
  try {
    await writeFile(path, 'topic')
    await assert.doesNotReject(syncPromotedFile(path, directory))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
