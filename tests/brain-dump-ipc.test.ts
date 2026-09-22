import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import type { BrainDumpLibraryApi } from '../src/shared/brain-dump'
import { registerBrainDumpIpc } from '../src/main/brain-dump-ipc'

test('capture IPC rejects malformed input and forwards only the narrow capture request', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const starts: unknown[] = []
  const subscribers: unknown[] = []
  const assignments: [string, string | undefined][] = []
  const approvals: Array<{ jobId: string; approvalId: string; optionId?: string }> = []
  registerBrainDumpIpc(
    { handle: (channel, listener) => void handlers.set(channel, listener as (...args: unknown[]) => unknown) },
    {
      list: async () => ({ topics: [], diagnostics: [] }),
      resolve: async (slug) => ({ status: 'missing', slug }),
      archive: async () => ({ ok: false, code: 'unused', message: 'Unused.' }),
      assignProject: async (slug, projectPath) => {
        assignments.push([slug, projectPath])
        return { ok: false, code: 'unused', message: 'Unused.' }
      }
    } satisfies BrainDumpLibraryApi,
    {
      start: async (request) => {
        starts.push(request)
        return { ok: true, state: { status: 'working', jobId: 'job' } }
      },
      current: () => null,
      resolveApproval: (jobId, approvalId, optionId) =>
        approvals.push({ jobId, approvalId, ...(optionId ? { optionId } : {}) }),
      cancel: () => {},
      disconnectOwner: () => {},
      shutdown: () => {}
    },
    {
      subscribe: (owner) => subscribers.push(owner),
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
    projectPath: 'D:\\Development\\Toucan'
  })
  assert.deepEqual(starts, [{ content: 'reviewed', provider: 'codex', projectPath: 'D:\\Development\\Toucan' }])

  await handlers.get('brain-dump:capture-approval')!(event, 'job', 'approval', 'allow-once')
  await handlers.get('brain-dump:capture-approval')!(event, 'job', 42, 'allow-once')
  assert.deepEqual(approvals, [{ jobId: 'job', approvalId: 'approval', optionId: 'allow-once' }])

  await handlers.get('brain-dump:list')!(event, 'active')
  assert.deepEqual(subscribers, [event.sender])

  const badAssignment = await handlers.get('brain-dump:assign-project')!(event, 42, 'D:\\Development\\Toucan')
  assert.deepEqual(badAssignment, {
    ok: false,
    code: 'invalid-request',
    message: 'Slug is required and the project must be a path.'
  })
  await handlers.get('brain-dump:assign-project')!(event, 'topic', 'D:\\Development\\Toucan')
  await handlers.get('brain-dump:assign-project')!(event, 'topic', undefined)
  assert.deepEqual(assignments, [
    ['topic', 'D:\\Development\\Toucan'],
    ['topic', undefined]
  ])
})
