import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { BrainDumpLibraryApi } from '../src/shared/brain-dump'
import { registerBrainDumpIpc } from '../src/main/brain-dump-ipc'

test('capture IPC rejects malformed input and forwards only the narrow capture request', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const starts: unknown[] = []
  registerBrainDumpIpc(
    { handle: (channel, listener) => void handlers.set(channel, listener as (...args: unknown[]) => unknown) },
    {} as BrainDumpLibraryApi,
    {
      start: async (request) => {
        starts.push(request)
        return { ok: true, state: { status: 'working', jobId: 'job' } }
      },
      current: () => null,
      cancel: () => {},
      disconnectOwner: () => {},
      shutdown: () => {}
    }
  )
  const event = { sender: { isDestroyed: () => false, send: () => {} } }
  const malformed = await handlers.get('brain-dump:capture-start')!(event, { content: 'x', provider: 'other' })
  assert.deepEqual(malformed, { ok: false, code: 'invalid-content', message: 'Capture request is invalid.' })
  await handlers.get('brain-dump:capture-start')!(event, {
    content: 'reviewed',
    provider: 'codex',
    projectPath: 'D:\\Development\\ADE'
  })
  assert.deepEqual(starts, [{ content: 'reviewed', provider: 'codex', projectPath: 'D:\\Development\\ADE' }])
})
