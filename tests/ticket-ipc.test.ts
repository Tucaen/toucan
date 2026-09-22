import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { registerTicketIpc } from '../src/main/ticket-ipc'
import type { TicketLibrary } from '../src/main/ticket-library'
import type { TicketSkillScaffold } from '../src/main/ticket-skill-scaffold'
import type { TicketChangeOwner, TicketChangeWatcher } from '../src/main/ticket-watcher'

interface Harness {
  handlers: Map<string, (...args: unknown[]) => unknown>
  watched: string[]
  subscribed: TicketChangeOwner[]
  revealed: string[]
  statuses: Array<[string, string, string]>
  removals: Array<[string, string]>
  skillWrites: string[]
}

const SKILL_PATH = 'SKILL-PATH'
const HAS_SKILL = 'D:\\has-skill'

function harness(library: Partial<TicketLibrary> = {}): Harness {
  const skillWrites: string[] = []
  const skill: TicketSkillScaffold = {
    relativePath: SKILL_PATH,
    state: async (projectPath) => ({ status: projectPath === HAS_SKILL ? 'present' : 'absent', path: SKILL_PATH }),
    write: async (projectPath) => {
      skillWrites.push(projectPath)
      return { ok: true, path: SKILL_PATH }
    },
    pathFor: (projectPath) => `${projectPath}\\${SKILL_PATH}`
  }
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
      library: {
        list: async () => ({ cards: [], diagnostics: [] }),
        read: async () => null,
        setStatus: async (projectPath, slug, status) => {
          statuses.push([projectPath, slug, status])
          return { ok: false, code: 'unused', message: 'Unused.' }
        },
        remove: async (projectPath, slug) => {
          removals.push([projectPath, slug])
          return { ok: true }
        },
        pathFor: async (_projectPath, slug) =>
          slug === 'ticket-board' ? 'D:\\p\\docs\\tickets\\ticket-board.md' : null,
        ...library
      },
      changes,
      skill,
      containment: { contains: async (path) => !path.includes('outside') },
      reveal: (path) => revealed.push(path),
      isGitRepository: async (projectPath) => projectPath === 'D:\\p'
    }
  )
  return { handlers, watched, subscribed, revealed, statuses, removals, skillWrites }
}

const event = { sender: { isDestroyed: () => false, send: () => {} } }

test('listing a project subscribes the window and starts watching that project', async () => {
  const { handlers, watched, subscribed } = harness()
  assert.deepEqual(await handlers.get('tickets:list')!(event, 'D:\\p'), { cards: [], diagnostics: [] })
  assert.deepEqual(watched, ['D:\\p'])
  assert.deepEqual(subscribed, [event.sender])
})

test('outside project paths cannot watch, mutate, scaffold, or reveal tickets', async () => {
  const { handlers, watched, subscribed, revealed, statuses, removals, skillWrites } = harness()
  const path = 'D:/outside'
  assert.deepEqual(await handlers.get('tickets:list')!(event, path), { cards: [], diagnostics: [] })
  for (const [channel, args] of [
    ['tickets:set-status', [path, 'ticket-board', 'done']],
    ['tickets:remove', [path, 'ticket-board']],
    ['tickets:write-skill', [path]]
  ] as const)
    assert.equal(((await handlers.get(channel)!(event, ...args)) as { ok: boolean }).ok, false)
  await handlers.get('tickets:reveal')!(event, path, 'ticket-board')
  await handlers.get('tickets:reveal-skill')!(event, path)
  assert.equal(await handlers.get('tickets:is-git-repository')!(event, path), false)
  assert.deepEqual([watched, subscribed, revealed, statuses, removals, skillWrites], [[], [], [], [], [], []])
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

test('a ticket destination outside the workspace cannot be mutated or revealed', async () => {
  const { handlers, statuses, removals, revealed } = harness({
    pathFor: async () => 'D:/outside/ticket-board.md'
  })
  for (const channel of ['tickets:set-status', 'tickets:remove']) {
    const result = await handlers.get(channel)!(event, 'D:/p', 'ticket-board', 'done')
    assert.equal((result as { ok: boolean }).ok, false)
  }
  await handlers.get('tickets:reveal')!(event, 'D:/p', 'ticket-board')
  assert.deepEqual([statuses, removals, revealed], [[], [], []])
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

/**
 * The scaffold's channels. What they owe is a *refusal* that cannot be bypassed from the renderer,
 * so a request that names no project is answered as if a skill were already there: the board then
 * offers nothing, and the one path that could write a file is the one that named a checkout.
 */

test('a project is probed for its own tickets skill', async () => {
  const { handlers } = harness()
  assert.deepEqual(await handlers.get('tickets:skill-state')!(event, 'D:\\p'), {
    status: 'absent',
    path: SKILL_PATH
  })
  assert.deepEqual(await handlers.get('tickets:skill-state')!(event, HAS_SKILL), {
    status: 'present',
    path: SKILL_PATH
  })
})

test('a probe with no project says nothing about a skill rather than guessing either way', async () => {
  const { handlers } = harness()
  assert.deepEqual(await handlers.get('tickets:skill-state')!(event, ''), { status: 'unknown', path: SKILL_PATH })
  assert.deepEqual(await handlers.get('tickets:skill-state')!(event, 7), { status: 'unknown', path: SKILL_PATH })
})

test('writing the skill reaches the scaffold, and a request with no project never does', async () => {
  const { handlers, skillWrites } = harness()
  assert.deepEqual(await handlers.get('tickets:write-skill')!(event, 'D:\\p'), { ok: true, path: SKILL_PATH })
  assert.deepEqual(await handlers.get('tickets:write-skill')!(event, ''), {
    ok: false,
    code: 'invalid-request',
    message: 'A project is required.'
  })
  assert.deepEqual(skillWrites, ['D:\\p'])
})

test('the skill file is revealed where the scaffold says it lives', async () => {
  const { handlers, revealed } = harness()
  await handlers.get('tickets:reveal-skill')!(event, 'D:\\p')
  await handlers.get('tickets:reveal-skill')!(event, undefined)
  assert.deepEqual(revealed, ['D:\\p\\' + SKILL_PATH])
})
