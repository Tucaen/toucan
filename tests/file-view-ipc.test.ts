import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { registerFileViewIpc } from '../src/main/file-view-ipc'
import type { FileView, FileViewOwner } from '../src/main/file-view'

interface Harness {
  handlers: Map<string, (...args: unknown[]) => unknown>
  reads: string[]
  watched: Array<[string, FileViewOwner]>
  unwatched: Array<[string, FileViewOwner]>
}

function harness(): Harness {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const reads: string[] = []
  const watched: Array<[string, FileViewOwner]> = []
  const unwatched: Array<[string, FileViewOwner]> = []
  const view: FileView = {
    read: async (path) => {
      reads.push(path)
      return { ok: true, content: 'x', truncated: false, size: 1, mtime: '2026-09-05T00:00:00.000Z', binary: false }
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
  return { handlers, reads, watched, unwatched }
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
