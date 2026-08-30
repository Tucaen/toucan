import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorktreeManager, type GitResult } from '../src/main/git-worktree'

const PROJECT = 'D:\\Development\\ADE'
const FEATURE = 'D:\\Development\\ADE-worktrees\\feat-login'

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

/** A common dir on disk, so claim reading exercises the real file path rather than a stub. */
function commonDirWithClaims(claims: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'ade-claims-'))
  writeFileSync(join(dir, 'ade-worktree-claims.json'), JSON.stringify(claims))
  return dir
}

function managerFor(commonDir: string, listStdout = porcelain) {
  return createWorktreeManager({
    runGit: async (args): Promise<GitResult> => {
      const command = args.join(' ')
      if (command.startsWith('worktree list')) return ok(listStdout)
      if (command.includes('--git-common-dir')) return ok(`${commonDir}\n`)
      if (command.startsWith('symbolic-ref')) return ok('main\n')
      return ok()
    },
    pathExists: () => true
  })
}

test('discovery reports the worktree the workspace has no record of', async () => {
  const result = await managerFor(commonDirWithClaims([])).discover({ projectPath: PROJECT, known: [] })

  assert.equal(result.worktrees.length, 1)
  assert.equal(result.worktrees[0].path, FEATURE)
  assert.equal(result.worktrees[0].branch, 'feat/login')
  assert.equal(result.worktrees[0].baseRef, 'main')
})

test('a worktree already known to the workspace is not rediscovered', async () => {
  const result = await managerFor(commonDirWithClaims([]))
    .discover({ projectPath: PROJECT, known: [FEATURE] })

  assert.deepEqual(result.worktrees, [])
})

test('a claim in the common dir names the node that created the worktree', async () => {
  const commonDir = commonDirWithClaims([
    { nodeId: 'node-42', path: FEATURE, branch: 'feat/login', claimedAt: '2026-08-30T10:00:00.000Z' }
  ])
  const result = await managerFor(commonDir).discover({ projectPath: PROJECT, known: [] })

  assert.equal(result.worktrees[0].claimedByNodeId, 'node-42')
})

test('a malformed claims file costs the association, not the discovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ade-claims-'))
  writeFileSync(join(dir, 'ade-worktree-claims.json'), '{ not json')
  const result = await managerFor(dir).discover({ projectPath: PROJECT, known: [] })

  assert.equal(result.worktrees.length, 1)
  assert.equal(result.worktrees[0].claimedByNodeId, undefined)
})

test('a claim of the wrong shape is ignored rather than trusted', async () => {
  const commonDir = commonDirWithClaims([{ nodeId: 7, path: FEATURE }, 'nonsense', null])
  const result = await managerFor(commonDir).discover({ projectPath: PROJECT, known: [] })

  assert.equal(result.worktrees[0].claimedByNodeId, undefined)
})

test('a repository git cannot list reports nothing rather than failing the caller', async () => {
  const manager = createWorktreeManager({
    runGit: async (args): Promise<GitResult> => (
      args.join(' ').startsWith('worktree list')
        ? { code: 128, stdout: '', stderr: 'not a git repository' }
        : ok()
    ),
    pathExists: () => true
  })

  const result = await manager.discover({ projectPath: PROJECT, known: [] })

  assert.deepEqual(result.worktrees, [])
  assert.match(result.message ?? '', /not a git repository/)
})
