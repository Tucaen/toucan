import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { registerPluginIpc } from '../src/main/plugin-ipc'
import type { PluginRegistry } from '../src/main/plugin-registry'
import { PLUGIN_CHANNELS } from '../src/shared/ipc-channels'

// #55: the plugins dialog's side of main. The registry decides; this narrows what crosses the
// boundary and refuses a malformed call before it reaches the registry.

function boundary(
  projectPathFor?: (path: string) => Promise<string | undefined>,
  pickFolder?: (sender: unknown) => Promise<string | null>
): {
  call: (channel: string, ...args: unknown[]) => Promise<unknown>
  calls: unknown[][]
} {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const calls: unknown[][] = []
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args])
      return Promise.resolve({ ok: true })
    }
  const registry: Omit<PluginRegistry, 'forSession'> = {
    list: record('list') as PluginRegistry['list'],
    add: record('add') as PluginRegistry['add'],
    remove: record('remove') as PluginRegistry['remove'],
    enable: record('enable') as PluginRegistry['enable'],
    disable: record('disable') as PluginRegistry['disable'],
    contributions: record('contributions') as PluginRegistry['contributions']
  }
  registerPluginIpc(
    { handle: (channel, listener) => void handlers.set(channel, (...args) => listener({ sender: {} }, ...args)) },
    registry,
    projectPathFor,
    pickFolder
  )
  return { call: async (channel, ...args) => handlers.get(channel)!(...args), calls }
}

test("a worktree's path enables, disables and lists for its project, which is what sessions look up", async () => {
  const { call, calls } = boundary((path) => Promise.resolve(path === 'D:\\worktrees\\one' ? 'D:\\project' : undefined))
  await call(PLUGIN_CHANNELS.enable, 'D:\\worktrees\\one', 'godot-runtime')
  await call(PLUGIN_CHANNELS.disable, 'D:\\worktrees\\one', 'godot-runtime')
  await call(PLUGIN_CHANNELS.list, 'D:\\worktrees\\one')
  await call(PLUGIN_CHANNELS.enable, 'D:\\project', 'godot-runtime')
  assert.deepEqual(calls, [
    ['enable', 'D:\\project', 'godot-runtime'],
    ['disable', 'D:\\project', 'godot-runtime'],
    ['list', 'D:\\project'],
    ['enable', 'D:\\project', 'godot-runtime']
  ])
})

test('each channel reaches the registry with what the dialog sent', async () => {
  const { call, calls } = boundary()
  await call(PLUGIN_CHANNELS.list)
  await call(PLUGIN_CHANNELS.list, 'D:\\project')
  await call(PLUGIN_CHANNELS.add, 'D:\\plugins\\godot-runtime')
  await call(PLUGIN_CHANNELS.remove, 'godot-runtime')
  await call(PLUGIN_CHANNELS.enable, 'D:\\project', 'godot-runtime')
  await call(PLUGIN_CHANNELS.disable, 'D:\\project', 'godot-runtime')
  await call(PLUGIN_CHANNELS.contributions, 'godot-runtime')
  assert.deepEqual(calls, [
    ['list', undefined],
    ['list', 'D:\\project'],
    ['add', 'D:\\plugins\\godot-runtime'],
    ['remove', 'godot-runtime'],
    ['enable', 'D:\\project', 'godot-runtime'],
    ['disable', 'D:\\project', 'godot-runtime'],
    ['contributions', 'godot-runtime']
  ])
})

test('a malformed call is refused before it reaches the registry', async () => {
  const { call, calls } = boundary()
  for (const [channel, args] of [
    [PLUGIN_CHANNELS.list, [5]],
    [PLUGIN_CHANNELS.add, [undefined]],
    [PLUGIN_CHANNELS.add, ['']],
    [PLUGIN_CHANNELS.remove, [{}]],
    [PLUGIN_CHANNELS.enable, ['D:\\project']],
    [PLUGIN_CHANNELS.disable, [['D:\\project'], 'godot-runtime']],
    [PLUGIN_CHANNELS.contributions, [null]]
  ] as const)
    await assert.rejects(call(channel, ...args), undefined, `${channel} ${JSON.stringify(args)}`)
  assert.deepEqual(calls, [])
})

test('the folder picker answers with the chosen path, or null when none is wired or the user cancels', async () => {
  const picks: unknown[] = []
  const { call } = boundary(undefined, (owner) => {
    picks.push(owner)
    return Promise.resolve('D:\\plugins\\godot')
  })
  assert.equal(await call(PLUGIN_CHANNELS.pick), 'D:\\plugins\\godot')
  assert.equal(picks.length, 1)
  assert.deepEqual(picks[0], {})
  assert.equal(await boundary().call(PLUGIN_CHANNELS.pick), null)
})
