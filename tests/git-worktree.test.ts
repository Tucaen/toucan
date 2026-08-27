import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createWorktreeManager, type GitResult } from '../src/main/git-worktree'

const PROJECT = 'D:\\Development\\ADE'
const WORKTREE = 'D:\\Development\\ADE-worktrees\\feature-login'

type Responder = (args: string[], cwd: string) => GitResult | undefined

const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr = 'boom', code = 1): GitResult => ({ code, stdout: '', stderr })

/**
 * Only the commands a case actually cares about are stubbed; everything else falls back to a
 * healthy repository, so each test reads as "what is different here".
 */
function gitStub(responders: Responder[], calls: string[][] = []) {
  const defaults: Responder = (args, cwd) => {
    const command = args.join(' ')
    if (command.startsWith('rev-parse --path-format=absolute --git-common-dir')) return ok(`${PROJECT}/.git\n`)
    if (command.startsWith('rev-parse --path-format=absolute --git-dir')) {
      return ok(cwd === PROJECT ? `${PROJECT}/.git\n` : `${PROJECT}/.git/worktrees/feature-login\n`)
    }
    if (command.startsWith('check-ref-format')) return ok()
    if (command.startsWith('show-ref')) return fail('', 1)
    if (command.startsWith('symbolic-ref')) return ok('main\n')
    if (command.startsWith('status')) return ok('# branch.oid abc123\n# branch.head feature/login\n')
    if (command.startsWith('stash list')) return ok('')
    if (command.startsWith('rev-list')) return ok('0\n')
    if (command.startsWith('worktree')) return ok()
    return ok()
  }
  return async (args: string[], cwd: string): Promise<GitResult> => {
    calls.push(args)
    for (const responder of responders) {
      const result = responder(args, cwd)
      if (result) return result
    }
    return defaults(args, cwd)!
  }
}

test('creating a worktree derives its directory and branches from the resolved HEAD', async () => {
  const calls: string[][] = []
  const manager = createWorktreeManager({ runGit: gitStub([], calls), pathExists: () => false })

  const result = await manager.create({ projectPath: PROJECT, branch: 'feature/login' })

  assert.equal(result.ok, true)
  assert.deepEqual(result.worktree, { path: WORKTREE, branch: 'feature/login', baseRef: 'main' })
  assert.deepEqual(
    calls.find((args) => args[0] === 'worktree'),
    ['worktree', 'add', '-b', 'feature/login', WORKTREE, 'main']
  )
})

test('creating a worktree refuses to reuse an existing branch or directory', async () => {
  const existingBranch = createWorktreeManager({
    runGit: gitStub([(args) => (args[0] === 'show-ref' ? ok() : undefined)]),
    pathExists: () => false
  })
  const existingBranchResult = await existingBranch.create({ projectPath: PROJECT, branch: 'feature/login' })
  assert.equal(existingBranchResult.ok, false)
  assert.match(existingBranchResult.message!, /already exists/)

  const existingDirectory = createWorktreeManager({ runGit: gitStub([]), pathExists: () => true })
  const existingDirectoryResult = await existingDirectory.create({ projectPath: PROJECT, branch: 'feature/login' })
  assert.equal(existingDirectoryResult.ok, false)
  assert.match(existingDirectoryResult.message!, /already exists/)
})

test('creating a worktree outside a git repository fails before touching the filesystem', async () => {
  const calls: string[][] = []
  const manager = createWorktreeManager({
    runGit: gitStub([(args) => (args[1] === '--path-format=absolute' ? fail() : undefined)], calls),
    pathExists: () => false
  })

  const result = await manager.create({ projectPath: PROJECT, branch: 'feature/login' })

  assert.equal(result.ok, false)
  assert.match(result.message!, /not a git repository/)
  assert.equal(calls.some((args) => args[0] === 'worktree'), false)
})

test('status counts changed, untracked and stashed work, and unmerged commits without an upstream', async () => {
  const manager = createWorktreeManager({
    runGit: gitStub([(args) => {
      if (args[0] === 'status') {
        return ok([
          '# branch.oid abc123',
          '# branch.head feature/login',
          '1 .M N... 100644 100644 100644 aaa bbb src/a.ts',
          '2 R. N... 100644 100644 100644 ccc ddd R100 src/b.ts',
          'u UU N... 100644 100644 100644 100644 eee fff ggg src/c.ts',
          '? notes.md',
          '? scratch.txt'
        ].join('\n'))
      }
      if (args[0] === 'stash') return ok('WIP on feature/login: abc Something\nOn main: def Elsewhere\n')
      if (args[0] === 'rev-list') return ok('4\n')
      return undefined
    }]),
    pathExists: () => true
  })

  const status = await manager.status({ path: WORKTREE, branch: 'feature/login', baseRef: 'main' })

  assert.equal(status.exists, true)
  assert.equal(status.branch, 'feature/login')
  assert.equal(status.changedFiles, 3)
  assert.equal(status.untrackedFiles, 2)
  assert.equal(status.stashEntries, 1)
  assert.equal(status.hasUpstream, false)
  assert.equal(status.ahead, 4)
})

test('status reads ahead/behind from the upstream when the branch tracks one', async () => {
  const calls: string[][] = []
  const manager = createWorktreeManager({
    runGit: gitStub([(args) => (args[0] === 'status'
      ? ok('# branch.head feature/login\n# branch.upstream origin/feature/login\n# branch.ab +2 -5\n')
      : undefined)], calls),
    pathExists: () => true
  })

  const status = await manager.status({ path: WORKTREE, branch: 'feature/login', baseRef: 'main' })

  assert.equal(status.hasUpstream, true)
  assert.equal(status.ahead, 2)
  assert.equal(status.behind, 5)
  // With an upstream there is no need to ask the base ref anything.
  assert.equal(calls.some((args) => args[0] === 'rev-list'), false)
})

test('a clean, merged worktree is removed and pruned', async () => {
  const calls: string[][] = []
  const manager = createWorktreeManager({ runGit: gitStub([], calls), pathExists: () => true })

  const result = await manager.remove({ projectPath: PROJECT, path: WORKTREE, branch: 'feature/login', baseRef: 'main' })

  assert.deepEqual(result, { ok: true, blockers: [] })
  assert.deepEqual(calls.find((args) => args[1] === 'remove'), ['worktree', 'remove', WORKTREE])
  assert.ok(calls.some((args) => args[1] === 'prune'))
})

test('removal is refused with named blockers while unique work is present', async () => {
  const calls: string[][] = []
  const manager = createWorktreeManager({
    runGit: gitStub([(args) => {
      if (args[0] === 'status') return ok('# branch.head feature/login\n1 .M N... 1 1 1 a b src/a.ts\n? new.txt\n')
      if (args[0] === 'rev-list') return ok('3\n')
      return undefined
    }], calls),
    pathExists: () => true
  })

  const result = await manager.remove({ projectPath: PROJECT, path: WORKTREE, branch: 'feature/login', baseRef: 'main' })

  assert.equal(result.ok, false)
  assert.deepEqual(result.blockers, [
    { kind: 'uncommitted-changes', files: 1 },
    { kind: 'untracked-files', files: 1 },
    { kind: 'unpublished-commits', commits: 3 }
  ])
  assert.equal(calls.some((args) => args[1] === 'remove'), false)
})

test('forcing past unsaved work removes the directory but never deletes the branch', async () => {
  const calls: string[][] = []
  const manager = createWorktreeManager({
    runGit: gitStub([(args) => (args[0] === 'status'
      ? ok('# branch.head feature/login\n1 .M N... 1 1 1 a b src/a.ts\n')
      : undefined)], calls),
    pathExists: () => true
  })

  const result = await manager.remove({
    projectPath: PROJECT, path: WORKTREE, branch: 'feature/login', baseRef: 'main', force: true
  })

  assert.deepEqual(result, { ok: true, blockers: [] })
  assert.deepEqual(calls.find((args) => args[1] === 'remove'), ['worktree', 'remove', '--force', WORKTREE])
  assert.equal(calls.some((args) => args[0] === 'branch'), false)
})

test('force cannot remove the primary checkout', async () => {
  const calls: string[][] = []
  const manager = createWorktreeManager({
    runGit: gitStub([], calls),
    pathExists: () => true
  })

  const result = await manager.remove({
    projectPath: PROJECT, path: PROJECT, branch: 'main', baseRef: 'main', force: true
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.blockers, [{ kind: 'primary-worktree' }])
  assert.equal(calls.some((args) => args[1] === 'remove'), false)
})

test('force cannot remove a directory belonging to a different repository', async () => {
  const manager = createWorktreeManager({
    runGit: gitStub([(args, cwd) => (
      args[2] === '--git-common-dir' && cwd !== PROJECT ? ok('D:/Other/.git\n') : undefined
    )]),
    pathExists: () => true
  })

  const result = await manager.remove({
    projectPath: PROJECT, path: WORKTREE, branch: 'feature/login', baseRef: 'main', force: true
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.blockers, [{ kind: 'not-a-worktree', detail: 'it belongs to a different repository' }])
})

test('a failed inspection blocks removal rather than assuming the worktree is clean', async () => {
  const calls: string[][] = []
  const manager = createWorktreeManager({
    runGit: gitStub([(args) => (args[0] === 'status' ? fail('fatal: unable to read index') : undefined)], calls),
    pathExists: () => true
  })

  const result = await manager.remove({
    projectPath: PROJECT, path: WORKTREE, branch: 'feature/login', baseRef: 'main', force: true
  })

  assert.equal(result.ok, false)
  assert.equal(result.blockers[0].kind, 'inspection-failed')
  assert.equal(calls.some((args) => args[1] === 'remove'), false)
})

test('a worktree whose directory is already gone is pruned without ceremony', async () => {
  const calls: string[][] = []
  const manager = createWorktreeManager({ runGit: gitStub([], calls), pathExists: () => false })

  const result = await manager.remove({ projectPath: PROJECT, path: WORKTREE, branch: 'feature/login', baseRef: 'main' })

  assert.deepEqual(result, { ok: true, blockers: [] })
  assert.deepEqual(calls, [['worktree', 'prune']])
})
