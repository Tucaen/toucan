import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { createWorktreeManager, type GitResult } from '../src/main/git-worktree'

const PROJECT = 'D:\\Development\\Toucan'
const FEATURE = 'D:\\Development\\Toucan-worktrees\\feat-login'

const ok = (stdout = ''): GitResult => ({ code: 0, stdout, stderr: '' })

const porcelain = [
  `worktree ${PROJECT}`,
  'HEAD abc123',
  'branch refs/heads/main',
  '',
  `worktree ${FEATURE}`,
  'HEAD def456',
  'branch refs/heads/feat/login',
  ''
].join('\n')

function managerFor(listStdout = porcelain) {
  return createWorktreeManager({
    runGit: async (args): Promise<GitResult> => {
      const command = args.join(' ')
      if (command.startsWith('worktree list')) return ok(listStdout)
      if (command.startsWith('symbolic-ref')) return ok('main\n')
      return ok()
    },
    pathExists: () => true
  })
}

test('discovery reports the worktree the workspace has no record of', async () => {
  const result = await managerFor().discover({ projectPath: PROJECT, known: [] })

  assert.equal(result.worktrees.length, 1)
  assert.equal(result.worktrees[0].path, FEATURE)
  assert.equal(result.worktrees[0].branch, 'feat/login')
  assert.equal(result.worktrees[0].baseRef, 'main')
})

test('a worktree already known to the workspace is not rediscovered', async () => {
  const result = await managerFor().discover({ projectPath: PROJECT, known: [FEATURE] })

  assert.deepEqual(result.worktrees, [])
})

test('a repository git cannot list reports nothing rather than failing the caller', async () => {
  const manager = createWorktreeManager({
    runGit: async (args): Promise<GitResult> =>
      args.join(' ').startsWith('worktree list') ? { code: 128, stdout: '', stderr: 'not a git repository' } : ok(),
    pathExists: () => true
  })

  const result = await manager.discover({ projectPath: PROJECT, known: [] })

  assert.deepEqual(result.worktrees, [])
  assert.match(result.message ?? '', /not a git repository/)
})

test('a known worktree git still lists but reports prunable is stale, not available', async () => {
  const prunable = porcelain.replace(
    'branch refs/heads/feat/login\n',
    'branch refs/heads/feat/login\nprunable gitdir file points to non-existent location\n'
  )
  const result = await managerFor(prunable).discover({
    projectPath: PROJECT,
    known: [FEATURE]
  })

  assert.deepEqual(result.stalePaths, [FEATURE])
  assert.deepEqual(result.availablePaths, [PROJECT])
  assert.deepEqual(result.worktrees, [])
})
