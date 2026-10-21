import { strict as assert } from 'node:assert'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'
import { runGitWithExecFile } from '../src/main/git-worktree'
import { createOrchestrationMerge } from '../src/main/orchestration-merge'
import { createWorkspaceContainment } from '../src/main/workspace-containment'
import { applyPlan, recordTicketSession } from '../src/shared/orchestration'

// `merge --ticket` is Toucan doing the orchestrator's tested fast-forward merge and push itself, so a
// merge no longer hangs on the agent's own permission check. Real Git, like the cleanup tests.

const GIT_FIXTURE_TIMEOUT = 120_000

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* left for the OS temp cleanup */
    }
  }
})

async function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'toucan-merge-')))
  roots.push(root)
  const project = join(root, 'project')
  const remote = join(root, 'remote.git')
  const worktree = join(root, 'ticket-1')
  const git = async (args: string[], cwd = project) => {
    const result = await runGitWithExecFile(args, cwd)
    assert.equal(result.code, 0, result.stderr)
    return result.stdout.trim()
  }
  await Promise.all([git(['init', '--bare', remote], root), git(['init', '-b', 'main', project], root)])
  await git(['config', 'user.email', 'test@example.invalid'])
  await git(['config', 'user.name', 'Test'])
  await git(['commit', '--allow-empty', '-m', 'base'])
  await git(['remote', 'add', 'origin', remote])
  await git(['push', '-u', 'origin', 'main'])
  await git(['worktree', 'add', '-b', 'ticket/1', worktree, 'main'])
  await git(['commit', '--allow-empty', '-m', 'ticket 1'], worktree)
  const record = recordTicketSession(
    applyPlan(
      undefined,
      { task: 'merge', targetBranch: 'main', tickets: [{ id: '1', title: 'one', blockedBy: [] }] },
      { provider: 'claude', conversationId: 'orch', projectPath: project },
      'now'
    ).record!,
    '1',
    { nodeId: 'node-1', conversationId: 'c-1', worktreePath: worktree, branch: 'ticket/1' },
    'now'
  )
  const merge = createOrchestrationMerge({
    runGit: runGitWithExecFile,
    containment: createWorkspaceContainment({ roots: () => [root] })
  })
  const head = await git(['rev-parse', 'ticket/1'])
  return { root, project, remote, worktree, git, record, merge, head }
}

test(
  'a tested ticket branch is fast-forwarded into the target and pushed to its upstream',
  async () => {
    const { git, remote, record, merge, head } = await fixture()
    const result = await merge.run(record, record.tickets[0], head.slice(0, 10))
    assert.deepEqual(result, { ok: true, commit: head, upstream: 'origin/main' })
    assert.equal(await git(['rev-parse', 'main']), head)
    assert.equal(await git(['rev-parse', 'main'], remote), head)
    assert.equal(await git(['rev-parse', 'origin/main']), head)
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'a tested commit that is not the ticket HEAD, or a target the ticket lacks, changes nothing',
  async () => {
    const { git, project, worktree, record, merge, head } = await fixture()
    const base = await git(['rev-parse', 'main'])
    await git(['commit', '--allow-empty', '-m', 'untested'], worktree)
    const untested = await merge.run(record, record.tickets[0], head)
    assert.equal(untested.ok, false)
    assert.equal(!untested.ok && untested.stage, 'check')
    assert.match(!untested.ok ? untested.error : '', /tested.*HEAD|HEAD.*tested/i)

    const tip = await git(['rev-parse', 'ticket/1'])
    writeFileSync(join(project, 'advance.txt'), 'target moved on')
    await git(['add', 'advance.txt'])
    await git(['commit', '-m', 'target advanced'])
    const advanced = await merge.run(record, record.tickets[0], tip)
    assert.equal(!advanced.ok && advanced.stage, 'check')
    assert.match(!advanced.ok ? advanced.error : '', /rebase/)
    assert.notEqual(await git(['rev-parse', 'main']), tip)
    assert.equal(await git(['rev-parse', 'origin/main']), base)
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'a dirty target checkout or ticket worktree refuses before anything moves',
  async () => {
    const { git, project, worktree, record, merge, head } = await fixture()
    const base = await git(['rev-parse', 'main'])
    writeFileSync(join(worktree, 'stray.txt'), 'uncommitted')
    const dirtyTicket = await merge.run(record, record.tickets[0], head)
    assert.match(!dirtyTicket.ok ? dirtyTicket.error : '', /ticket 1's worktree/)
    rmSync(join(worktree, 'stray.txt'))
    writeFileSync(join(project, 'stray.txt'), 'uncommitted')
    const dirtyTarget = await merge.run(record, record.tickets[0], head)
    assert.match(!dirtyTarget.ok ? dirtyTarget.error : '', /target checkout/)
    assert.equal(await git(['rev-parse', 'main']), base)
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'a rejected push reports the push stage and leaves the merge local and unpublished',
  async () => {
    const { root, git, remote, record, merge, head } = await fixture()
    const other = join(root, 'other')
    await git(['clone', '-b', 'main', remote, other], root)
    await git(
      ['-c', 'user.email=o@example.invalid', '-c', 'user.name=O', 'commit', '--allow-empty', '-m', 'raced'],
      other
    )
    await git(['push'], other)
    const raced = await git(['rev-parse', 'HEAD'], other)
    const result = await merge.run(record, record.tickets[0], head)
    assert.equal(!result.ok && result.stage, 'push')
    assert.equal(!result.ok && result.rejected, true)
    assert.equal(await git(['rev-parse', 'main']), head)
    assert.equal(await git(['rev-parse', 'main'], remote), raced)
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'a retry after a fixed push publishes the target that already holds the ticket',
  async () => {
    const { git, remote, record, merge, head } = await fixture()
    await git(['merge', '--ff-only', 'ticket/1'])
    const result = await merge.run(record, record.tickets[0], head)
    assert.deepEqual(result, { ok: true, commit: head, upstream: 'origin/main' })
    assert.equal(await git(['rev-parse', 'main'], remote), head)
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'a project outside the workspace is refused before Git runs',
  async () => {
    const { record, head } = await fixture()
    const merge = createOrchestrationMerge({
      runGit: async () => {
        throw new Error('Git must not run outside the workspace')
      },
      containment: createWorkspaceContainment({ roots: () => [] })
    })
    const result = await merge.run(record, record.tickets[0], head)
    assert.equal(!result.ok && result.stage, 'check')
    assert.match(!result.ok ? result.error : '', /workspace/)
  },
  GIT_FIXTURE_TIMEOUT
)
