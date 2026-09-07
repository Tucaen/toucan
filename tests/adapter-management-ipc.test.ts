import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { registerAdapterManagementIpc } from '../src/main/adapter-management-ipc'
import type { AdapterManager } from '../src/main/adapter-manager'

test('adapter IPC accepts only the two providers and exact versions or the bundled choice', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const selected: unknown[] = []
  registerAdapterManagementIpc(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener as (...args: unknown[]) => unknown)
      }
    },
    {
      select: async (provider: string, version: string | null) => {
        selected.push([provider, version])
        return {}
      },
      check: async () => ({})
    } as unknown as AdapterManager
  )
  const select = handlers.get('adapters:select')!
  for (const value of ['latest', '../escape', '--global', {}, undefined]) {
    assert.throws(() => select({}, 'codex', value), /exact published/)
  }
  assert.throws(() => select({}, 'untrusted-package', '1.0.0'), /Unknown adapter/)
  assert.throws(() => handlers.get('adapters:check')!({}, '__proto__'), /Unknown adapter/)
  await select({}, 'codex', '1.9.0-beta.1')
  await select({}, 'claude', null)
  assert.deepEqual(selected, [
    ['codex', '1.9.0-beta.1'],
    ['claude', null]
  ])
})
