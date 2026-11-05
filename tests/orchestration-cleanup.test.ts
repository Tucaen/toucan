import { strict as assert } from 'node:assert'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'
import { createWorktreeManager, runGitWithExecFile, type GitRunner } from '../src/main/git-worktree'
import { createOrchestrationCleanup } from '../src/main/orchestration-cleanup'
import { createWorkspaceContainment } from '../src/main/workspace-containment'
import { applyPlan, discardTicketRun, recordTicketSession } from '../src/shared/orchestration'

// Real Git on Windows costs a process spawn per call, and the full suite runs these on a machine
// every worker is saturating: measured at 6 s alone and 30 s+ in the full run for the same 80-odd
// spawns, so the default 30 s deadline is a race rather than a check.
const GIT_FIXTURE_TIMEOUT = 120_000

const roots: string[] = []
afterEach(() => {
  // Best effort: Windows may still hold a handle in the directory (EBUSY), and a leaked temp
  // directory is no reason to fail a test that already passed.
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      /* left for the OS temp cleanup */
    }
  }
})

async function fixture() {
  // Git reports worktree paths in their long form, and the Windows runner's temp directory is
  // an 8.3 short path (`RUNNER~1`), so the fixture starts from the name Git will list.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'toucan-cleanup-')))
  roots.push(root)
  const project = join(root, 'project')
  const remote = join(root, 'remote.git')
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

test(
  'cleanup removes only published merged worktrees and branches, and can be repeated',
  async () => {
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
    assert.deepEqual(canvas, ['retire:node-1', 'prepare:node-1', 'remove:node-1'])
    assert.deepEqual(
      (await cleanup.run(record)).removed.map((entry) => entry.ticket),
      ['1']
    )
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'an answer-only ticket is verified by Git and then cleaned up like a merged one',
  async () => {
    const { root, git, cleanup, canvas, ...context } = await fixture()
    const path = join(root, 'ticket-3')
    await git(['worktree', 'add', '-b', 'ticket/3', path, 'main'])
    let record = applyPlan(
      context.record,
      {
        task: 'cleanup',
        targetBranch: 'main',
        tickets: [
          ...context.record.tickets.map(({ id, title, blockedBy }) => ({ id, title, blockedBy })),
          { id: '3', title: 'question', blockedBy: [] }
        ]
      },
      { provider: 'claude', conversationId: 'orch', projectPath: context.project },
      'now'
    ).record!
    record = recordTicketSession(
      record,
      '3',
      { nodeId: 'node-3', conversationId: 'c-3', worktreePath: path, branch: 'ticket/3' },
      'now'
    )
    const [, committed, answered] = record.tickets

    assert.match((await cleanup.answeredRefusal(record, committed))!, /1 commit\(s\) the target lacks/)
    writeFileSync(join(path, 'scratch.txt'), 'notes')
    assert.match((await cleanup.answeredRefusal(record, answered))!, /uncommitted or untracked work/)
    rmSync(join(path, 'scratch.txt'))
    assert.equal(await cleanup.answeredRefusal(record, answered), undefined)

    answered.mergeStatus = 'answered'
    const result = await cleanup.run(record, '3')
    assert.deepEqual(
      result.removed.map((entry) => entry.ticket),
      ['3']
    )
    assert.equal(existsSync(path), false)
    assert.equal(await git(['branch', '--list', 'ticket/3']), '')
    assert.deepEqual(canvas, ['retire:node-3', 'prepare:node-3', 'remove:node-3'])
  },
  GIT_FIXTURE_TIMEOUT
)

// `git worktree list` reports forward slashes on Windows too.
const gitPath = (path: string) => path.replaceAll('\\', '/')

test(
  'a ticket worktree with commits and no recorded attempt is reported unrecorded and retained, never deleted',
  async () => {
    const { root, git, record, canvas } = await fixture()
    const path = join(root, 'ticket-9')
    await git(['worktree', 'add', '-b', 'ticket/9', path, 'main'])
    await git(['commit', '--allow-empty', '-m', 'lost 1'], path)
    await git(['commit', '--allow-empty', '-m', 'lost 2'], path)
    // A retry's branch for a recorded ticket, and a branch no worktree has checked out.
    await git(['branch', 'ticket/2-2', 'main'])
    const cleanup = createOrchestrationCleanup({
      containment: createWorkspaceContainment({ roots: () => [root] }),
      runGit: runGitWithExecFile,
      worktrees: createWorktreeManager(),
      liveSessions: () => [{ nodeId: 'stray', cwd: path }],
      canvas: async (request) => {
        canvas.push(`${request.phase}:${request.session.nodeId}`)
        return { ok: true }
      }
    })

    assert.deepEqual(await cleanup.unrecorded(record), [
      { ticket: '9', path: gitPath(path), branch: 'ticket/9', ahead: 2, liveSession: true, nodeId: 'stray' },
      { ticket: '2', branch: 'ticket/2-2', ahead: 0, liveSession: false }
    ])
    const result = await cleanup.run(record)
    assert.deepEqual(
      result.retained.filter((entry) => entry.reason === 'unrecorded attempt'),
      [
        { ticket: '9', worktree: gitPath(path), branch: 'ticket/9', reason: 'unrecorded attempt' },
        { ticket: '2', worktree: undefined, branch: 'ticket/2-2', reason: 'unrecorded attempt' }
      ]
    )
    assert.deepEqual(
      (await cleanup.run(record, '9')).retained.map((entry) => entry.ticket),
      ['9']
    )
    assert.equal(existsSync(path), true)
    assert.ok(await git(['branch', '--list', 'ticket/9']))
    assert.ok(await git(['branch', '--list', 'ticket/2-2']))
    assert.deepEqual(canvas, [])
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'a live session the record does not name makes its recorded worktree unrecorded; the recorded one does not',
  async () => {
    const { project, git, record } = await fixture()
    const [one, two] = record.tickets.map((ticket) => ticket.session!)
    const live = (nodeId: string, cwd: string) =>
      createOrchestrationCleanup({
        containment: createWorkspaceContainment({ roots: () => [project] }),
        runGit: runGitWithExecFile,
        worktrees: createWorktreeManager(),
        liveSessions: () => [{ nodeId, cwd }],
        canvas: async () => ({ ok: true })
      })
    assert.deepEqual(await live(two.nodeId!, two.worktreePath!).unrecorded(record), [])
    assert.deepEqual(await live('stray', one.worktreePath!).unrecorded(record), [
      {
        ticket: '1',
        path: gitPath(one.worktreePath!),
        branch: 'ticket/1',
        ahead: 1,
        liveSession: true,
        nodeId: 'stray'
      }
    ])
    assert.ok(await git(['branch', '--list', 'ticket/1']))
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'ticket-scoped cleanup removes a published merge without reporting unrelated pending tickets',
  async () => {
    const { git, record, cleanup } = await fixture()
    await git(['merge', '--ff-only', 'ticket/1'])
    await git(['push'])
    const result = await cleanup.run(record, '1')
    assert.deepEqual(
      result.removed.map((entry) => entry.ticket),
      ['1']
    )
    assert.deepEqual(result.retained, [])
    assert.equal(existsSync(record.tickets[1].session!.worktreePath!), true)
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'a stash made on another branch does not hold back a merged ticket',
  async () => {
    const { project, git, record, cleanup } = await fixture()
    await git(['merge', '--ff-only', 'ticket/1'])
    await git(['push'])
    writeFileSync(join(project, 'unrelated.txt'), 'unrelated work')
    await git(['stash', 'push', '--include-untracked', '-m', 'unrelated'])
    const result = await cleanup.run(record)
    assert.deepEqual(
      result.removed.map((entry) => entry.ticket),
      ['1']
    )
    assert.match(await git(['stash', 'list']), /unrelated/)
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'a merged flag cannot delete unpublished, unmerged, dirty or occupied work',
  async () => {
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
    assert.deepEqual(canvas, ['retire:node-1'])
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'cleanup retains a worktree when its canvas cannot safely close the ticket',
  async () => {
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
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'cleanup refuses a project no longer registered in the workspace before running Git',
  async () => {
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
  },
  GIT_FIXTURE_TIMEOUT
)

/** Publishes ticket 1 with a committed `.gitignore`, so its worktree can hold ignored output. */
async function publishWithIgnoredOutput(context: Awaited<ReturnType<typeof fixture>>) {
  const { git, record } = context
  const path = record.tickets[0].session!.worktreePath!
  writeFileSync(join(path, '.gitignore'), 'out/\n')
  writeFileSync(join(path, 'tracked.txt'), 'tracked\n')
  await git(['add', '.gitignore', 'tracked.txt'], path)
  await git(['commit', '-m', 'ignore output'], path)
  await git(['merge', '--ff-only', 'ticket/1'])
  await git(['push'])
  mkdirSync(join(path, 'out', 'run'), { recursive: true })
  writeFileSync(join(path, 'out', 'run', 'result.png.import'), 'generated')
  return path
}

/** Adds ignored output whose absolute path is beyond Windows' 260-character MAX_PATH. */
function addDeepOutput(path: string) {
  const deep = join(path, 'out', ...Array.from({ length: 14 }, (_, index) => `godot-check-project-${index}`))
  mkdirSync(deep, { recursive: true })
  writeFileSync(join(deep, 'icon.png.import'), 'generated')
  assert.ok(join(deep, 'icon.png.import').length > 260)
}

/**
 * What a half-failed `git worktree remove` leaves: no registration, no `.git`, and some files -
 * here without the folder's own `.gitignore`, which git deletes early.
 */
async function halfRemove(context: Awaited<ReturnType<typeof fixture>>, path: string) {
  rmSync(join(path, '.git'))
  rmSync(join(path, '.gitignore'))
  await context.git(['worktree', 'prune'])
  assert.doesNotMatch(await context.git(['worktree', 'list']), /ticket-1/)
}

test(
  'the final sweep finishes a half-removed worktree and deletes its merged branch',
  async () => {
    const context = await fixture()
    const path = await publishWithIgnoredOutput(context)
    await halfRemove(context, path)
    const result = await context.cleanup.run(context.record)
    assert.deepEqual(
      result.removed.map((entry) => entry.ticket),
      ['1']
    )
    assert.equal(existsSync(path), false)
    assert.equal(await context.git(['branch', '--list', 'ticket/1']), '')
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'a leftover folder is finished even after an earlier sweep already deleted the branch',
  async () => {
    const context = await fixture()
    const path = await publishWithIgnoredOutput(context)
    await halfRemove(context, path)
    await context.git(['branch', '-d', 'ticket/1'])
    const result = await context.cleanup.run(context.record, '1')
    assert.deepEqual(result.retained, [])
    assert.equal(existsSync(path), false)
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'a leftover folder holding changed tracked or untracked files is retained with what was found',
  async () => {
    const context = await fixture()
    const path = await publishWithIgnoredOutput(context)
    await halfRemove(context, path)
    writeFileSync(join(path, 'tracked.txt'), 'edited after the merge\n')
    writeFileSync(join(path, 'notes.txt'), 'unpublished notes')
    const result = await context.cleanup.run(context.record, '1')
    assert.equal(result.removed.length, 0)
    const reason = result.retained[0].reason!
    assert.match(reason, /still holds work/)
    assert.match(reason, /modified tracked\.txt/)
    assert.match(reason, /untracked notes\.txt/)
    assert.doesNotMatch(reason, /result\.png\.import/)
    assert.equal(existsSync(join(path, 'notes.txt')), true)
    assert.ok(await context.git(['branch', '--list', 'ticket/1']))
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'a worktree removal that fails still deletes the proved branch and reports the folder',
  async () => {
    const { root, git, record } = await fixture()
    await git(['merge', '--ff-only', 'ticket/1'])
    await git(['push'])
    const manager = createWorktreeManager()
    const cleanup = createOrchestrationCleanup({
      containment: createWorkspaceContainment({ roots: () => [root] }),
      runGit: runGitWithExecFile,
      worktrees: {
        // Git's half-way failure: the registration goes, the folder stays.
        remove: async (request) => {
          await manager.remove(request)
          mkdirSync(request.path, { recursive: true })
          return { ok: false, blockers: [], message: "error: failed to delete 'ticket-1': Filename too long" }
        }
      },
      canvas: async () => ({ ok: true })
    })
    const result = await cleanup.run(record, '1')
    assert.match(
      result.retained[0].reason!,
      /branch ticket\/1 deleted; ticket chat and canvas group removed; worktree folder retained: .*Filename too long/
    )
    assert.equal(await git(['branch', '--list', 'ticket/1']), '')
    // The next sweep finds the leftover, proves it empty and finishes it.
    assert.deepEqual(
      (await cleanup.run(record, '1')).removed.map((entry) => entry.ticket),
      ['1']
    )
    assert.equal(existsSync(record.tickets[0].session!.worktreePath!), false)
  },
  GIT_FIXTURE_TIMEOUT
)

type Context = Awaited<ReturnType<typeof fixture>>
type ScheduledRetry = { ms: number; run: () => Promise<void> }

/**
 * A cleanup that records canvas phases into `context.canvas` and keeps folder retries for the
 * test to run, removing worktrees with `remove` (the real manager by default).
 */
function retryingCleanup(context: Context, remove = createWorktreeManager().remove) {
  const scheduled: ScheduledRetry[] = []
  const cleanup = createOrchestrationCleanup({
    containment: createWorkspaceContainment({ roots: () => [context.root] }),
    runGit: runGitWithExecFile,
    worktrees: { remove },
    canvas: async (request) => {
      context.canvas.push(`${request.phase}:${request.session.nodeId}`)
      return { ok: true }
    },
    folderRetry: { delaysMs: [15_000, 60_000], schedule: (run, ms) => scheduled.push({ ms, run }) }
  })
  return { cleanup, scheduled }
}

/** A cleanup whose worktree removal fails the way a lock makes it: registration gone, folder kept. */
function lockedFolderCleanup(context: Context) {
  const manager = createWorktreeManager()
  return retryingCleanup(context, async (request) => {
    await manager.remove(request)
    mkdirSync(request.path, { recursive: true })
    return {
      ok: false,
      blockers: [],
      message: `error: failed to delete '${request.path}': Invalid argument; deleting the leftover folder failed: EBUSY`
    }
  })
}

/** Ticket 1's recorded session. */
function ticketSession(context: Context) {
  return context.record.tickets[0].session!
}

async function mergeTicketOne(context: Context) {
  await context.git(['merge', '--ff-only', 'ticket/1'])
  await context.git(['push'])
}

test(
  'a merged ticket whose folder alone could not be deleted still loses its chat and canvas group',
  async () => {
    const context = await fixture()
    await mergeTicketOne(context)
    const { cleanup } = lockedFolderCleanup(context)
    const result = await cleanup.run(context.record, '1')
    assert.deepEqual(result.removed, [])
    assert.match(
      result.retained[0].reason!,
      /branch ticket\/1 deleted; ticket chat and canvas group removed; worktree folder retained: .*EBUSY/
    )
    assert.deepEqual(context.canvas, ['retire:node-1', 'prepare:node-1', 'remove:node-1'])
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'a branch Git would not delete keeps the canvas group beside the retained folder',
  async () => {
    const context = await fixture()
    await mergeTicketOne(context)
    // A removal that failed before Git touched anything: the worktree still holds the branch.
    const { cleanup, scheduled } = retryingCleanup(context, async () => ({
      ok: false,
      blockers: [],
      message: 'fatal: could not remove'
    }))
    const result = await cleanup.run(context.record, '1')
    assert.match(result.retained[0].reason!, /worktree folder retained: .*; branch not deleted: /)
    assert.deepEqual(context.canvas, ['retire:node-1', 'prepare:node-1'])
    assert.ok(await context.git(['branch', '--list', 'ticket/1']))
    assert.equal(scheduled.length, 0)
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'a retained folder is deleted by a background retry once nothing holds it',
  async () => {
    const context = await fixture()
    await mergeTicketOne(context)
    const { cleanup, scheduled } = lockedFolderCleanup(context)
    const result = await cleanup.run(context.record, '1')
    assert.match(result.retained[0].reason!, /Toucan retries deleting it/)
    assert.deepEqual(
      scheduled.map((retry) => retry.ms),
      [15_000]
    )

    await scheduled[0].run()
    assert.equal(existsSync(ticketSession(context).worktreePath!), false)
    assert.equal(scheduled.length, 1)
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'a folder retry stops when the ticket worktree and branch exist again',
  async () => {
    const context = await fixture()
    await mergeTicketOne(context)
    const { cleanup, scheduled } = lockedFolderCleanup(context)
    await cleanup.run(context.record, '1')
    // A later spawn reuses the ticket's name before the retry fires.
    const path = ticketSession(context).worktreePath!
    rmSync(path, { recursive: true, force: true })
    await context.git(['worktree', 'add', '-b', 'ticket/1', path, 'main'])
    context.canvas.length = 0

    await scheduled[0].run()
    assert.equal(existsSync(join(path, '.git')), true)
    assert.ok(await context.git(['branch', '--list', 'ticket/1']))
    assert.deepEqual(context.canvas, [])
    assert.equal(scheduled.length, 1)
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'a ticket whose leftover folder vanished after a retained cleanup is removed from the canvas on retry',
  async () => {
    const context = await fixture()
    const path = await publishWithIgnoredOutput(context)
    await halfRemove(context, path)
    await context.git(['branch', '-d', 'ticket/1'])
    rmSync(path, { recursive: true, force: true })
    const result = await context.cleanup.run(context.record, '1')
    assert.deepEqual(
      result.removed.map((entry) => entry.ticket),
      ['1']
    )
    assert.deepEqual(context.canvas, ['retire:node-1', 'prepare:node-1', 'remove:node-1'])
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  "a merged worktree deleted behind Git's back is pruned, and its branch and canvas group removed",
  async () => {
    const context = await fixture()
    await mergeTicketOne(context)
    rmSync(ticketSession(context).worktreePath!, { recursive: true, force: true })
    assert.match(await context.git(['worktree', 'list', '--porcelain']), /prunable/)
    const result = await context.cleanup.run(context.record, '1')
    assert.deepEqual(
      result.removed.map((entry) => entry.ticket),
      ['1']
    )
    assert.equal(await context.git(['branch', '--list', 'ticket/1']), '')
    assert.deepEqual(context.canvas, ['retire:node-1', 'prepare:node-1', 'remove:node-1'])
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  "a merged flag on unpublished work deleted behind Git's back keeps its branch and canvas group",
  async () => {
    const context = await fixture()
    context.record.tickets[1].mergeStatus = 'merged'
    rmSync(context.record.tickets[1].session!.worktreePath!, { recursive: true, force: true })
    const result = await context.cleanup.run(context.record, '2')
    assert.deepEqual(result.removed, [])
    assert.ok(await context.git(['branch', '--list', 'ticket/2']))
    assert.deepEqual(context.canvas, [])
  },
  GIT_FIXTURE_TIMEOUT
)

/** A process whose working directory is `path`: on Windows, the lock that makes `rmdir` fail EBUSY. */
async function holdDirectory(path: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: path,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
    windowsHide: true
  })
  child.on('error', () => {})
  await new Promise<void>((started) => child.once('spawn', () => started()))
  return child
}

test.skipIf(process.platform !== 'win32')(
  'a worktree a live process holds is retired, retried while locked, and swept once it exits (Windows only)',
  async () => {
    const context = await fixture()
    await mergeTicketOne(context)
    const path = ticketSession(context).worktreePath!
    const { cleanup, scheduled } = retryingCleanup(context)
    const holder = await holdDirectory(path)
    try {
      const result = await cleanup.run(context.record, '1')
      assert.match(result.retained[0].reason!, /branch ticket\/1 deleted; ticket chat and canvas group removed/)
      assert.deepEqual(context.canvas, ['retire:node-1', 'prepare:node-1', 'remove:node-1'])
      assert.equal(existsSync(path), true)
      // A manual sweep while the retry is pending does not stack a second one.
      await cleanup.run(context.record, '1')
      assert.equal(scheduled.length, 1)

      await scheduled[0].run()
      assert.deepEqual(
        scheduled.map((retry) => retry.ms),
        [15_000, 60_000]
      )
      // The last delay spent, the retries stop.
      await scheduled[1].run()
      assert.equal(existsSync(path), true)
      assert.equal(scheduled.length, 2)
    } finally {
      const exited = new Promise((done) => holder.once('exit', done))
      holder.kill()
      await exited
    }
    // A later sweep still finishes it, and starts no retry for a folder that is gone.
    assert.deepEqual(
      (await cleanup.run(context.record, '1')).removed.map((entry) => entry.ticket),
      ['1']
    )
    assert.equal(existsSync(path), false)
    assert.equal(scheduled.length, 2)
  },
  GIT_FIXTURE_TIMEOUT
)

// MAX_PATH is a Windows limit; other platforms have no such failure to reproduce.
test.skipIf(process.platform !== 'win32')(
  'cleanup removes a worktree whose ignored output is deeper than MAX_PATH (Windows only)',
  async () => {
    const context = await fixture()
    const path = await publishWithIgnoredOutput(context)
    addDeepOutput(path)
    const result = await context.cleanup.run(context.record, '1')
    assert.deepEqual(result.retained, [])
    assert.equal(existsSync(path), false)
    assert.equal(await context.git(['branch', '--list', 'ticket/1']), '')
  },
  GIT_FIXTURE_TIMEOUT
)

test.skipIf(process.platform !== 'win32')(
  'a git without core.longpaths still has its half-removed deep worktree finished (Windows only)',
  async () => {
    const context = await fixture()
    const path = await publishWithIgnoredOutput(context)
    addDeepOutput(path)
    // A later -c wins, so this is the user's git on a machine without LongPathsEnabled:
    // `worktree remove` drops the registration and fails on the folder.
    const shortPathGit: GitRunner = (args, cwd) => runGitWithExecFile(['-c', 'core.longpaths=false', ...args], cwd)
    const cleanup = createOrchestrationCleanup({
      containment: createWorkspaceContainment({ roots: () => [context.root] }),
      runGit: shortPathGit,
      worktrees: createWorktreeManager({ runGit: shortPathGit }),
      canvas: async () => ({ ok: true })
    })
    const result = await cleanup.run(context.record, '1')
    assert.deepEqual(result.retained, [])
    assert.equal(existsSync(path), false)
    assert.equal(await context.git(['branch', '--list', 'ticket/1']), '')
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'a worktree or branch any recorded attempt names is recorded, not only the latest session; a discarded one is not',
  async () => {
    const { project, record, cleanup } = await fixture()
    const ticket = record.tickets[1]
    // The ticket was respawned elsewhere: attempt 1 (ticket/2 in its worktree) is no longer the session.
    const respawned = recordTicketSession(
      record,
      ticket.id,
      {
        nodeId: 'node-2b',
        conversationId: 'c-2b',
        worktreePath: join(project, '..', 'ticket-2b'),
        branch: 'ticket/2-2'
      },
      'later'
    )
    const names = (await cleanup.unrecorded(respawned)).map((attempt) => attempt.branch)
    assert.ok(!names.includes('ticket/2'), 'the first attempt still counts as recorded')
    assert.ok(!names.includes('ticket/1'))
    const discarded = discardTicketRun(respawned, ticket.id, 1, 'later')
    const after = (await cleanup.unrecorded(discarded)).map((attempt) => attempt.branch)
    assert.deepEqual(after, ['ticket/2'])
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'discard removes the worktree with its uncommitted work and force-deletes the unmerged branch',
  async () => {
    const { root, git, record, canvas, cleanup } = await fixture()
    const session = record.tickets[1].session!
    writeFileSync(join(session.worktreePath!, 'scratch.txt'), 'unsaved work')
    await git(['commit', '--allow-empty', '-m', 'unmerged'], session.worktreePath)
    const result = await cleanup.discard(record, {
      ticket: '2',
      branch: session.branch!,
      worktreePath: session.worktreePath,
      nodeId: session.nodeId,
      conversationId: session.conversationId
    })
    assert.deepEqual(result, { ok: true, removedWorktree: true, deletedBranch: true, ahead: 2 })
    assert.equal(existsSync(session.worktreePath!), false)
    assert.equal(await git(['branch', '--list', 'ticket/2']), '')
    assert.ok(await git(['branch', '--list', 'ticket/1']), 'other attempts are untouched')
    assert.ok(existsSync(join(root, 'ticket-1')))
    assert.deepEqual(canvas, ['prepare:node-2', 'remove:node-2'])
  },
  GIT_FIXTURE_TIMEOUT
)

test(
  'discard refuses anything but a ticket branch, and finishes a branch no worktree has checked out',
  async () => {
    const { git, record, cleanup } = await fixture()
    assert.deepEqual(await cleanup.discard(record, { ticket: '2', branch: 'main' }), {
      ok: false,
      error: 'main is not a ticket branch'
    })
    await git(['branch', 'ticket/7', 'main'])
    assert.deepEqual(await cleanup.discard(record, { ticket: '7', branch: 'ticket/7' }), {
      ok: true,
      removedWorktree: false,
      deletedBranch: true,
      ahead: 0
    })
    assert.equal(await git(['branch', '--list', 'ticket/7']), '')
  },
  GIT_FIXTURE_TIMEOUT
)

// Git for Windows follows a junction when it deletes a worktree: `worktree remove --force` emptied
// the junction's target. A worktree's `node_modules` linked to another checkout must lose only the link.
function junctionIntoSharedTarget(root: string, worktreePath: string): string {
  const target = join(root, 'shared-target')
  mkdirSync(join(target, 'sub'), { recursive: true })
  writeFileSync(join(target, 'sub', 'keep.txt'), 'must survive')
  symlinkSync(target, join(worktreePath, 'linked-modules'), 'junction')
  return target
}

test.skipIf(process.platform !== 'win32')(
  'discard removes a worktree holding a junction without emptying what it points at',
  async () => {
    const { root, git, record, cleanup } = await fixture()
    const session = record.tickets[1].session!
    await git(['config', 'core.excludesFile', join(root, 'ignore')])
    writeFileSync(join(root, 'ignore'), 'linked-modules\n')
    const target = junctionIntoSharedTarget(root, session.worktreePath!)
    const result = await cleanup.discard(record, {
      ticket: '2',
      branch: session.branch!,
      worktreePath: session.worktreePath
    })
    assert.equal(result.ok, true)
    assert.equal(existsSync(session.worktreePath!), false)
    assert.equal(readFileSync(join(target, 'sub', 'keep.txt'), 'utf8'), 'must survive')
  },
  GIT_FIXTURE_TIMEOUT
)

test.skipIf(process.platform !== 'win32')(
  "a merged ticket's cleanup removes a worktree holding a junction without emptying what it points at",
  async () => {
    const { root, git, record, cleanup } = await fixture()
    await git(['config', 'core.excludesFile', join(root, 'ignore')])
    writeFileSync(join(root, 'ignore'), 'linked-modules\n')
    await git(['merge', '--ff-only', 'ticket/1'])
    await git(['push'])
    const target = junctionIntoSharedTarget(root, record.tickets[0].session!.worktreePath!)
    const result = await cleanup.run(record, '1')
    assert.deepEqual(result.retained, [])
    assert.equal(existsSync(record.tickets[0].session!.worktreePath!), false)
    assert.equal(readFileSync(join(target, 'sub', 'keep.txt'), 'utf8'), 'must survive')
  },
  GIT_FIXTURE_TIMEOUT
)
