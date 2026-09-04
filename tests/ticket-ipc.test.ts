import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { registerTicketIpc } from '../src/main/ticket-ipc'
import type { TicketLibrary } from '../src/main/ticket-library'
import type { TicketChangeOwner, TicketChangeWatcher } from '../src/main/ticket-watcher'

interface Harness {
  handlers: Map<string, (...args: unknown[]) => unknown>
  watched: string[]
  subscribed: TicketChangeOwner[]
  revealed: string[]
  statuses: Array<[string, string, string]>
  removals: Array<[string, string]>
}

function harness(library: Partial<TicketLibrary> = {}): Harness {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const watched: string[] = []
  const subscribed: TicketChangeOwner[] = []
  const revealed: string[] = []
  const statuses: Array<[string, string, string]> = []
  const removals: Array<[string, string]> = []
  const changes: TicketChangeWatcher = {
    watchProject: async (projectPath) => void watched.push(projectPath),
    subscribe: (owner) => void subscribed.push(owner),
    disconnectOwner: () => {},
    shutdown: () => {}
  }
  registerTicketIpc(
    { handle: (channel, listener) => void handlers.set(channel, listener as (...args: unknown[]) => unknown) },
    {
      list: async () => ({ cards: [], diagnostics: [] }),
      setStatus: async (projectPath, slug, status) => {
        statuses.push([projectPath, slug, status])
        return { ok: false, code: 'unused', message: 'Unused.' }
      },
      remove: async (projectPath, slug) => {
        removals.push([projectPath, slug])
        return { ok: true }
      },
      pathFor: async (_projectPath, slug) => (slug === 'ticket-board' ? 'D:\\p\\docs\\tickets\\ticket-board.md' : null),
      ...library
    },
    changes,
    (path) => revealed.push(path),
    async (projectPath) => projectPath === 'D:\\p'
  )
  return { handlers, watched, subscribed, revealed, statuses, removals }
}

const event = { sender: { isDestroyed: () => false, send: () => {} } }

test('listing a project subscribes the window and starts watching that project', async () => {
  const { handlers, watched, subscribed } = harness()
  assert.deepEqual(await handlers.get('tickets:list')!(event, 'D:\\p'), { cards: [], diagnostics: [] })
  assert.deepEqual(watched, ['D:\\p'])
  assert.deepEqual(subscribed, [event.sender])
})

test('a request without a project path is answered empty and watches nothing', async () => {
  const { handlers, watched, subscribed } = harness()
  assert.deepEqual(await handlers.get('tickets:list')!(event, 42), { cards: [], diagnostics: [] })
  assert.deepEqual(await handlers.get('tickets:list')!(event, ''), { cards: [], diagnostics: [] })
  assert.deepEqual(watched, [])
  assert.deepEqual(subscribed, [])
})

test('a folder that cannot be read becomes a diagnostic row rather than a rejected board', async () => {
  const { handlers } = harness({
    list: async () => {
      throw new Error('EPERM: permission denied')
    }
  })
  assert.deepEqual(await handlers.get('tickets:list')!(event, 'D:\\p'), {
    cards: [],
    diagnostics: [{ path: 'D:\\p', code: 'unreadable-folder', message: 'EPERM: permission denied' }]
  })
})

test('a malformed status request never reaches the files', async () => {
  const { handlers, statuses } = harness()
  assert.deepEqual(await handlers.get('tickets:set-status')!(event, 'D:\\p', 'ticket-board', 7), {
    ok: false,
    code: 'invalid-request',
    message: 'Project, ticket and status are required.'
  })
  await handlers.get('tickets:set-status')!(event, 'D:\\p', 'ticket-board', 'done')
  assert.deepEqual(statuses, [['D:\\p', 'ticket-board', 'done']])
})

test('reveal only ever hands the shell a path the library resolved', async () => {
  const { handlers, revealed } = harness()
  await handlers.get('tickets:reveal')!(event, 'D:\\p', '../escape')
  assert.deepEqual(revealed, [])
  await handlers.get('tickets:reveal')!(event, 'D:\\p', 'ticket-board')
  assert.deepEqual(revealed, ['D:\\p\\docs\\tickets\\ticket-board.md'])
})

test('a malformed removal request never reaches the files', async () => {
  const { handlers, removals } = harness()
  assert.deepEqual(await handlers.get('tickets:remove')!(event, 'D:\\p', 7), {
    ok: false,
    code: 'invalid-request',
    message: 'Project and ticket are required.'
  })
  assert.deepEqual(await handlers.get('tickets:remove')!(event, '', 'ticket-board'), {
    ok: false,
    code: 'invalid-request',
    message: 'Project and ticket are required.'
  })
  assert.deepEqual(removals, [])
  assert.deepEqual(await handlers.get('tickets:remove')!(event, 'D:\\p', 'ticket-board'), { ok: true })
  assert.deepEqual(removals, [['D:\\p', 'ticket-board']])
})

test('the delete confirmation is told whether the project is a git checkout', async () => {
  const { handlers } = harness()
  assert.equal(await handlers.get('tickets:is-git-repository')!(event, 'D:\\p'), true)
  assert.equal(await handlers.get('tickets:is-git-repository')!(event, 'D:\\not-git'), false)
  // A path that is not one cannot be probed, and an unprobed project gets the cautious answer.
  assert.equal(await handlers.get('tickets:is-git-repository')!(event, 42), false)
})
