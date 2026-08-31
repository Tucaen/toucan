import { strict as assert } from 'node:assert'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBrainDumpCaptureStore } from '../src/main/brain-dump-capture-store'

test('capture store persists terminal conversation identity independently of workspace nodes', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'ade-capture-store-')), 'capture.json')
  const store = createBrainDumpCaptureStore(path)
  assert.equal(await store.load(), null)
  const state = {
    status: 'failed' as const,
    jobId: 'job-1',
    code: 'skill' as const,
    message: 'Skill failed.',
    conversation: { provider: 'codex' as const, conversationId: 'conversation-1', cwd: 'C:\\Users\\Ada' }
  }
  await store.save(state)
  assert.deepEqual(await store.load(), state)
})
