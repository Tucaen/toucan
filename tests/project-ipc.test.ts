import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { PROJECT_CHANNELS, SHELL_CHANNELS, WORKSPACE_CHANNELS } from '../src/shared/ipc-channels'
import { registerProjectIpc, type ProjectIpcDependencies } from '../src/main/project-ipc'
import type { WorkspaceState } from '../src/shared/terminal'

interface Harness {
  handlers: Map<string, (...args: unknown[]) => unknown>
  opened: string[]
  revealed: string[]
  openedLocally: string[]
  saved: WorkspaceState[]
}

function harness(overrides: Partial<ProjectIpcDependencies> = {}): Harness {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const opened: string[] = []
  const revealed: string[] = []
  const openedLocally: string[] = []
  const saved: WorkspaceState[] = []
  registerProjectIpc(
    { handle: (channel, listener) => void handlers.set(channel, listener as (...args: unknown[]) => unknown) },
    {
      workspace: {
        load: async () => ({ state: null, recovered: false, unrecoverable: false }),
        save: async (state) => {
          saved.push(state)
          return { ok: true }
        }
      },
      initialProjectPath: () => 'D:\\projects\\toucan',
      pickProjectDirectory: async () => 'D:\\projects/other',
      openExternal: async (url) => void opened.push(url),
      showItemInFolder: (path) => void revealed.push(path),
      openLocalFile: async (path) => {
        openedLocally.push(path)
        return { ok: true }
      },
      ...overrides
    }
  )
  return { handlers, opened, revealed, openedLocally, saved }
}

const event = { sender: {} }

test('the initial project is the launch directory, displayed by its base name', async () => {
  const { handlers } = harness()
  assert.deepEqual(await handlers.get(PROJECT_CHANNELS.initial)!(event), {
    name: 'toucan',
    path: 'D:\\projects\\toucan'
  })
})

test('a picked folder is normalized and named; a cancelled picker is null', async () => {
  const { handlers } = harness()
  assert.deepEqual(await handlers.get(PROJECT_CHANNELS.pick)!(event), {
    name: 'other',
    path: 'D:\\projects\\other'
  })

  const cancelled = harness({ pickProjectDirectory: async () => null })
  assert.equal(await cancelled.handlers.get(PROJECT_CHANNELS.pick)!(event), null)
})

test('only web URLs leave the app through shell:open-external', async () => {
  const { handlers, opened } = harness()
  const openExternal = handlers.get(SHELL_CHANNELS.openExternal)!
  await openExternal(event, 'https://example.com/docs')
  await openExternal(event, 'http://localhost:5173/page')
  await openExternal(event, 'file:///C:/Windows/System32/calc.exe')
  await openExternal(event, 'ms-settings:privacy')
  await openExternal(event, 'javascript:alert(1)')
  await openExternal(event, 'not a url')
  await openExternal(event, 42)
  assert.deepEqual(opened, ['https://example.com/docs', 'http://localhost:5173/page'])
})

test('shell:show-item-in-folder normalizes the path and ignores anything blank or non-string', async () => {
  const { handlers, revealed } = harness()
  const reveal = handlers.get(SHELL_CHANNELS.showItemInFolder)!
  await reveal(event, 'D:/projects/toucan/README.md')
  await reveal(event, '   ')
  await reveal(event, undefined)
  assert.deepEqual(revealed, ['D:\\projects\\toucan\\README.md'])
})

test('shell:open-local-file hands the path to the opener and returns its verdict', async () => {
  const { handlers, openedLocally } = harness()
  const open = handlers.get(SHELL_CHANNELS.openLocalFile)!
  assert.deepEqual(await open(event, 'D:\\Projects\\My Game\\docs\\studies.png'), { ok: true })
  assert.deepEqual(openedLocally, ['D:\\Projects\\My Game\\docs\\studies.png'])

  // A non-string cannot be a path, and it is still answered: the opener refuses the empty path in
  // its own words, so there is never a second wording of the same refusal here.
  await open(event, 42)
  assert.deepEqual(openedLocally, ['D:\\Projects\\My Game\\docs\\studies.png', ''])
})

test('workspace load and save go to the injected store', async () => {
  const { handlers, saved } = harness()
  assert.deepEqual(await handlers.get(WORKSPACE_CHANNELS.load)!(event), {
    state: null,
    recovered: false,
    unrecoverable: false
  })
  const state = { projects: [] } as unknown as WorkspaceState
  assert.deepEqual(await handlers.get(WORKSPACE_CHANNELS.save)!(event, state), { ok: true })
  assert.equal(saved[0], state)
})
