import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import type { WorktreeCreateRequest, WorktreeCreateResult } from '../src/shared/worktree'
import type { AgentProvider } from '../src/shared/agent-provider'
import { createWorktreeCreator, type CreatedWorktree } from '../src/renderer/src/worktree-creation'

interface Registered {
  worktreeId: string
  path: string
}

/** Records every step the creator takes, so a test can say how many checkouts and chats it made. */
function harness(options: {
  create?: (request: WorktreeCreateRequest) => Promise<WorktreeCreateResult>
  startChat?: (worktree: Registered, provider: AgentProvider) => string | null
}) {
  const calls = {
    create: [] as WorktreeCreateRequest[],
    register: [] as CreatedWorktree[],
    startChat: [] as { worktree: Registered; provider: AgentProvider }[]
  }
  const creator = createWorktreeCreator<Registered>({
    create: (request) => {
      calls.create.push(request)
      return (
        options.create?.(request) ??
        Promise.resolve({
          ok: true,
          worktree: { path: 'D:\\repo-worktrees\\feature-login', branch: request.branch, baseRef: 'main' }
        })
      )
    },
    register: (created) => {
      calls.register.push(created)
      return { worktreeId: `worktree-${calls.register.length}`, path: created.path }
    },
    startChat: (worktree, provider) => {
      calls.startChat.push({ worktree, provider })
      return options.startChat ? options.startChat(worktree, provider) : `chat-${calls.startChat.length}`
    }
  })
  return { creator, calls }
}

const REQUEST = { projectPath: 'D:\\repo', branch: 'feature/login', baseRef: undefined }

for (const provider of ['claude', 'codex'] as const) {
  test(`a created worktree opens exactly one ${provider} chat in that worktree`, async () => {
    const { creator, calls } = harness({})

    const outcome = await creator.submit({ ...REQUEST, provider })

    assert.deepEqual(outcome, {
      status: 'created',
      worktree: { worktreeId: 'worktree-1', path: 'D:\\repo-worktrees\\feature-login' },
      chatId: 'chat-1'
    })
    assert.equal(calls.create.length, 1)
    assert.equal(calls.register.length, 1)
    assert.deepEqual(calls.startChat, [
      { worktree: { worktreeId: 'worktree-1', path: 'D:\\repo-worktrees\\feature-login' }, provider }
    ])
  })
}

test('the git request carries only branch and base, never the chat provider', async () => {
  const { creator, calls } = harness({})

  await creator.submit({ projectPath: 'D:\\repo', branch: 'feature/login', baseRef: 'develop', provider: 'codex' })

  assert.deepEqual(calls.create, [{ projectPath: 'D:\\repo', branch: 'feature/login', baseRef: 'develop' }])
})

test('a refused git creation registers nothing and starts no chat', async () => {
  const { creator, calls } = harness({
    create: () => Promise.resolve({ ok: false, message: "fatal: a branch named 'feature/login' already exists" })
  })

  const outcome = await creator.submit({ ...REQUEST, provider: 'claude' })

  assert.deepEqual(outcome, { status: 'failed', message: "fatal: a branch named 'feature/login' already exists" })
  assert.equal(calls.register.length, 0)
  assert.equal(calls.startChat.length, 0)
})

test('a git creation that throws is a failure with its message, not a stuck submission', async () => {
  const { creator, calls } = harness({ create: () => Promise.reject(new Error('IPC channel closed')) })

  const outcome = await creator.submit({ ...REQUEST, provider: 'claude' })

  assert.deepEqual(outcome, { status: 'failed', message: 'IPC channel closed' })
  assert.equal(calls.startChat.length, 0)
  assert.equal(creator.pending(), false)
})

test('a repeated submission while one is pending creates nothing a second time', async () => {
  let resolveCreate: (result: WorktreeCreateResult) => void = () => {}
  const { creator, calls } = harness({
    create: () =>
      new Promise((resolve) => {
        resolveCreate = resolve
      })
  })

  const first = creator.submit({ ...REQUEST, provider: 'claude' })
  const second = creator.submit({ ...REQUEST, provider: 'claude' })

  assert.equal(second, null)
  assert.equal(creator.pending(), true)
  resolveCreate({
    ok: true,
    worktree: { path: 'D:\\repo-worktrees\\feature-login', branch: 'feature/login', baseRef: 'main' }
  })
  await first
  assert.equal(calls.create.length, 1)
  assert.equal(calls.startChat.length, 1)
  assert.equal(creator.pending(), false)
})

test('after a failure the same creator can submit again', async () => {
  let attempt = 0
  const { creator, calls } = harness({
    create: (request) => {
      attempt += 1
      return Promise.resolve(
        attempt === 1
          ? { ok: false, message: 'locked' }
          : {
              ok: true,
              worktree: { path: 'D:\\repo-worktrees\\feature-login', branch: request.branch, baseRef: 'main' }
            }
      )
    }
  })

  assert.equal((await creator.submit({ ...REQUEST, provider: 'codex' }))?.status, 'failed')
  assert.equal((await creator.submit({ ...REQUEST, provider: 'codex' }))?.status, 'created')
  assert.equal(calls.create.length, 2)
  assert.equal(calls.startChat.length, 1)
})

test('a chat that cannot start leaves the registered worktree standing', async () => {
  const { creator, calls } = harness({ startChat: () => null })

  const outcome = await creator.submit({ ...REQUEST, provider: 'claude' })

  assert.equal(outcome?.status, 'chat-failed')
  assert.deepEqual(outcome?.status === 'chat-failed' && outcome.worktree, {
    worktreeId: 'worktree-1',
    path: 'D:\\repo-worktrees\\feature-login'
  })
  assert.equal(calls.create.length, 1)
  assert.equal(calls.register.length, 1)
})

test('a chat start that throws is the same partial success, never a failed creation', async () => {
  const { creator, calls } = harness({
    startChat: () => {
      throw new Error('renderer state unavailable')
    }
  })

  const outcome = await creator.submit({ ...REQUEST, provider: 'codex' })

  assert.deepEqual(outcome, {
    status: 'chat-failed',
    worktree: { worktreeId: 'worktree-1', path: 'D:\\repo-worktrees\\feature-login' },
    message: 'renderer state unavailable'
  })
  assert.equal(calls.register.length, 1)
  assert.equal(creator.pending(), false)
})
