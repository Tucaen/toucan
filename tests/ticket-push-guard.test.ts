import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { runGitWithExecFile } from '../src/main/git-worktree'
import { installPushGuard } from '../src/main/ticket-push-guard'

// The ticket worktree's `pre-push` guard (#34): a ticket session never pushes, and that is
// enforced by git rather than requested in a prompt. Driven against real repositories, because
// what matters is what git does with the hook - and that the orchestrator's own checkout, which
// shares the repository, can still push the target branch.

const identity = {
  GIT_AUTHOR_NAME: 'Toucan Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Toucan Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid'
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...identity }, encoding: 'utf8', stdio: 'pipe' })
}

function gitFails(cwd: string, ...args: string[]): string {
  try {
    git(cwd, ...args)
  } catch (error) {
    return (error as { stderr?: string }).stderr ?? ''
  }
  throw new Error(`git ${args.join(' ')} unexpectedly succeeded`)
}

function repository(): { root: string; project: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), 'toucan-push-guard-'))
  const remote = join(root, 'remote.git')
  const project = join(root, 'project')
  git(root, 'init', '--bare', '--initial-branch=main', remote)
  git(root, 'init', '--initial-branch=main', project)
  writeFileSync(join(project, 'README.md'), 'hello\n')
  git(project, 'add', 'README.md')
  git(project, 'commit', '-m', 'initial')
  git(project, 'remote', 'add', 'origin', remote)
  git(project, 'push', '-u', 'origin', 'main')
  const worktree = join(root, 'project-ticket-34')
  git(project, 'worktree', 'add', '-b', 'ticket/34', worktree, 'main')
  return { root, project, worktree }
}

test('a guarded ticket worktree refuses every push while the project checkout still pushes', async () => {
  const { project, worktree } = repository()
  const installed = await installPushGuard(worktree, runGitWithExecFile)
  assert.deepEqual(installed, { ok: true })

  writeFileSync(join(worktree, 'change.txt'), 'ticket work\n')
  git(worktree, 'add', 'change.txt')
  git(worktree, 'commit', '-m', 'ticket work')
  assert.match(gitFails(worktree, 'push', 'origin', 'ticket/34'), /ticket worktree/)
  assert.match(gitFails(worktree, 'push', 'origin', 'HEAD:main'), /ticket worktree/)
  assert.equal(git(project, 'ls-remote', 'origin', 'refs/heads/ticket/34').trim(), '')

  // The orchestrator merges and pushes from its own checkout, which the guard must not reach.
  git(project, 'merge', '--ff-only', 'ticket/34')
  git(project, 'push', 'origin', 'main')
  assert.equal(git(project, 'rev-parse', 'origin/main').trim(), git(project, 'rev-parse', 'ticket/34').trim())
})

test('the project hooks keep running in a guarded worktree', async () => {
  const { project, worktree } = repository()
  const hooks = git(project, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks').trim()
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho "project pre-commit refused" >&2\nexit 1\n', {
    mode: 0o755
  })
  assert.deepEqual(await installPushGuard(worktree, runGitWithExecFile), { ok: true })

  writeFileSync(join(worktree, 'change.txt'), 'ticket work\n')
  git(worktree, 'add', 'change.txt')
  assert.match(gitFails(worktree, 'commit', '-m', 'ticket work'), /project pre-commit refused/)
})

test('installing the guard twice is harmless, and a path that is no worktree is refused', async () => {
  const { root, worktree } = repository()
  assert.deepEqual(await installPushGuard(worktree, runGitWithExecFile), { ok: true })
  assert.deepEqual(await installPushGuard(worktree, runGitWithExecFile), { ok: true })
  assert.match(gitFails(worktree, 'push', 'origin', 'ticket/34'), /ticket worktree/)

  const refused = await installPushGuard(join(root, 'missing'), runGitWithExecFile)
  assert.equal(refused.ok, false)
})

test.runIf(process.platform !== 'win32')('a hook the user switched off stays off in a guarded worktree', async () => {
  const { project, worktree } = repository()
  const hooks = git(project, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks').trim()
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o644 })
  assert.deepEqual(await installPushGuard(worktree, runGitWithExecFile), { ok: true })
  writeFileSync(join(worktree, 'change.txt'), 'ticket work\n')
  git(worktree, 'add', 'change.txt')
  git(worktree, 'commit', '-m', 'ticket work')
})
