import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { registerFileViewIpc } from '../src/main/file-view-ipc'
import type { FileView, FileViewOwner } from '../src/main/file-view'
import type { FileWriteRequest } from '../src/shared/file-view'

interface Harness {
  handlers: Map<string, (...args: unknown[]) => unknown>
  reads: string[]
  writes: FileWriteRequest[]
  watched: Array<[string, FileViewOwner]>
  unwatched: Array<[string, FileViewOwner]>
}

function harness(): Harness {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const reads: string[] = []
  const writes: FileWriteRequest[] = []
  const watched: Array<[string, FileViewOwner]> = []
  const unwatched: Array<[string, FileViewOwner]> = []
  const view: FileView = {
    read: async (path) => {
      reads.push(path)
      return {
        ok: true,
        content: 'x',
        lineEnding: 'lf',
        truncated: false,
        size: 1,
        mtime: '2026-09-05T00:00:00.000Z',
        binary: false
      }
    },
    write: async (request) => {
      writes.push(request)
      return {
        ok: true,
        mtime: '2026-09-05T00:00:01.000Z',
        size: Buffer.byteLength(request.content),
        content: request.content
      }
    },
    watch: async (path, owner) => void watched.push([path, owner]),
    unwatch: (path, owner) => void unwatched.push([path, owner]),
    disconnectOwner: () => {},
    shutdown: () => {}
  }
  registerFileViewIpc(
    { handle: (channel, listener) => void handlers.set(channel, listener as (...args: unknown[]) => unknown) },
    view
  )
  return { handlers, reads, writes, watched, unwatched }
}

const event = { sender: { isDestroyed: () => false, send: () => {} } }

test('a read is forwarded only for a non-empty path string', async () => {
  const { handlers, reads } = harness()
  const refused = await handlers.get('file-view:read')!(event, 42)
  assert.deepEqual(refused, { ok: false, reason: 'unreadable', message: 'A file path is required.' })
  assert.deepEqual(await handlers.get('file-view:read')!(event, ''), {
    ok: false,
    reason: 'unreadable',
    message: 'A file path is required.'
  })
  const result = await handlers.get('file-view:read')!(event, 'D:\\p\\README.md')
  assert.equal((result as { ok: boolean }).ok, true)
  assert.deepEqual(reads, ['D:\\p\\README.md'])
})

test('watch and unwatch carry the requesting window along as the owner', async () => {
  const { handlers, watched, unwatched } = harness()
  await handlers.get('file-view:watch')!(event, 'D:\\p\\README.md')
  await handlers.get('file-view:watch')!(event, 7)
  assert.deepEqual(watched, [['D:\\p\\README.md', event.sender]])
  await handlers.get('file-view:unwatch')!(event, 'D:\\p\\README.md')
  await handlers.get('file-view:unwatch')!(event, undefined)
  assert.deepEqual(unwatched, [['D:\\p\\README.md', event.sender]])
})

test('a write is forwarded only for a well-formed request, never a partial one', async () => {
  const { handlers, writes } = harness()
  const request = { path: 'D:\\p\\README.md', content: '# Hi\n', baseMtime: '2026-09-05T00:00:00.000Z' }
  const result = await handlers.get('file-view:write')!(event, request)
  assert.deepEqual(result, { ok: true, mtime: '2026-09-05T00:00:01.000Z', size: 5, content: '# Hi\n' })
  assert.deepEqual(writes, [request])

  for (const malformed of [
    undefined,
    'D:\\p\\README.md',
    { path: 'D:\\p\\README.md' },
    { path: '', content: 'x', baseMtime: 'm' },
    { path: 'D:\\p\\README.md', content: 42, baseMtime: 'm' },
    { path: 'D:\\p\\README.md', content: 'x', baseMtime: null }
  ]) {
    const refused = (await handlers.get('file-view:write')!(event, malformed)) as { ok: boolean; reason: string }
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, 'unwritable')
  }
  assert.equal(writes.length, 1)
})
