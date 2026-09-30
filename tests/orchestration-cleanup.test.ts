import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createWorktreeManager, runGitWithExecFile } from '../src/main/git-worktree'
import { createOrchestrationCleanup } from '../src/main/orchestration-cleanup'
import { createWorkspaceContainment } from '../src/main/workspace-containment'
import { applyPlan, recordTicketSession } from '../src/shared/orchestration'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'toucan-cleanup-'))
  const project = join(root, 'project')
  const remote = join(root, 'remote.git')
  const git = async (args: string[], cwd = project) => {
    const result = await runGitWithExecFile(args, cwd)
    assert.equal(result.code, 0, result.stderr)
    return result.stdout.trim()
  }
  await git(['init', '--bare', remote], root)
  await git(['init', '-b', 'main', project], root)
  await git(['config', 'user.email', 'test@example.invalid'])
  await git(['config', 'user.name', 'Test'])
  await git(['commit', '--allow-empty', '-m', 'base'])
  await git(['remote', 'add', 'origin', remote])
  await git(['push', '-u', 'origin', 'main'])
  let record = applyPlan(
    undefined,
    {
      task: 'cleanup',
      targetBranch: 'main',
      tickets: [
        { id: '1', title: 'merged', blockedBy: [] },
        { id: '2', title: 'unmerged', blockedBy: [] }
      ]
    },
    { provider: 'claude', conversationId: 'orch', projectPath: project },
    'now'
  ).record!
  for (const id of ['1', '2']) {
    const path = join(root, `ticket-${id}`)
    await git(['worktree', 'add', '-b', `ticket/${id}`, path, 'main'])
    await git(['commit', '--allow-empty', '-m', `ticket ${id}`], path)
    record = recordTicketSession(
      record,
      id,
      { nodeId: `node-${id}`, conversationId: `c-${id}`, worktreePath: path, branch: `ticket/${id}` },
      'now'
    )
  }
  record.tickets[0].mergeStatus = 'merged'
  const canvas: string[] = []
  const cleanup = createOrchestrationCleanup({
    containment: createWorkspaceContainment({ roots: () => [root] }),
    runGit: runGitWithExecFile,
    worktrees: createWorktreeManager(),
    canvas: async (request) => {
      canvas.push(`${request.phase}:${request.session.nodeId}`)
      return { ok: true }
    }
  })
  return { root, project, git, record, canvas, cleanup }
}

test('cleanup removes only published merged worktrees and branches, and can be repeated', async () => {
  const { git, record, cleanup, canvas } = await fixture()
  await git(['merge', '--ff-only', 'ticket/1'])
  await git(['push'])
  const result = await cleanup.run(record)
  assert.deepEqual(
    result.removed.map((entry) => entry.ticket),
    ['1']
  )
  assert.deepEqual(
    result.retained.map((entry) => entry.ticket),
    ['2']
  )
  assert.equal(existsSync(record.tickets[0].session!.worktreePath!), false)
  assert.equal(existsSync(record.tickets[1].session!.worktreePath!), true)
  assert.equal(await git(['branch', '--list', 'ticket/1']), '')
  assert.ok(await git(['branch', '--list', 'ticket/2']))
  assert.deepEqual(canvas, ['close:node-1', 'remove:node-1'])
  assert.deepEqual(
    (await cleanup.run(record)).removed.map((entry) => entry.ticket),
    ['1']
  )
})

test('a merged flag cannot delete unpublished, unmerged, dirty or occupied work', async () => {
  const { git, record, cleanup, canvas } = await fixture()
  assert.equal((await cleanup.run(record)).removed.length, 0)
  await git(['merge', '--ff-only', 'ticket/1'])
  assert.equal((await cleanup.run(record)).removed.length, 0)
  await git(['push'])
  const path = record.tickets[0].session!.worktreePath!
  writeFileSync(join(path, 'keep.txt'), 'keep this untracked work')
  const dirty = await cleanup.run(record)
  assert.match(dirty.retained[0].reason!, /uncommitted|untracked/)
  assert.equal(existsSync(join(path, 'keep.txt')), true)
  assert.deepEqual(canvas, [])
})

test('cleanup retains a worktree when its canvas cannot safely close the ticket', async () => {
  const { root, git, record } = await fixture()
  await git(['merge', '--ff-only', 'ticket/1'])
  await git(['push'])
  const cleanup = createOrchestrationCleanup({
    containment: createWorkspaceContainment({ roots: () => [root] }),
    runGit: runGitWithExecFile,
    worktrees: createWorktreeManager(),
    canvas: async () => ({ ok: false, message: 'ticket is working' })
  })
  const result = await cleanup.run(record)
  assert.match(result.retained[0].reason!, /working/)
  assert.equal(existsSync(record.tickets[0].session!.worktreePath!), true)
  assert.ok(await git(['branch', '--list', 'ticket/1']))
})

test('cleanup refuses a project no longer registered in the workspace before running Git', async () => {
  const { record } = await fixture()
  const cleanup = createOrchestrationCleanup({
    containment: createWorkspaceContainment({ roots: () => [] }),
    runGit: async () => {
      throw new Error('Git must not run outside the workspace')
    },
    worktrees: createWorktreeManager(),
    canvas: async () => {
      throw new Error('Canvas must not be changed')
    }
  })
  const result = await cleanup.run(record)
  assert.match(result.retained[0].reason!, /registered workspace/)
  assert.equal(existsSync(record.tickets[0].session!.worktreePath!), true)
})
