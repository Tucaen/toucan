import { chmod, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathIdentity } from '../shared/paths'
import { errorMessage } from '../shared/text'
import type { GitRunner } from './git-worktree'

/**
 * The no-push rule of the ticket contract, enforced by git (#34): a ticket worktree gets a
 * `pre-push` hook that refuses every push, because a ticket branch is never pushed - only the
 * orchestrator's target branch is, from the orchestrator's own checkout.
 *
 * Hooks live in the repository's common directory, which every worktree shares, so a `pre-push`
 * there would also refuse the orchestrator. The hook is therefore installed per worktree: the
 * repository gets `extensions.worktreeConfig` (git's own mechanism for per-worktree config) and the
 * ticket worktree alone gets a `core.hooksPath` naming a directory inside its private git dir,
 * which `git worktree remove` deletes with it. That directory would otherwise hide the project's
 * other hooks from the ticket session, so every hook the worktree used to see is re-exposed there
 * as a shim that runs the original - a ticket session's commits are checked like anyone's.
 */

const GUARD_DIRECTORY = 'toucan-hooks'

const PRE_PUSH = [
  '#!/bin/sh',
  '# Installed by Toucan for a ticket session: its orchestrator merges this branch, so nothing here is pushed.',
  'echo "Toucan: pushing from a ticket worktree is refused. Commit to this branch; the orchestrator merges it." >&2',
  'exit 1',
  ''
].join('\n')

/** Git's sh wants forward slashes, and so does `core.hooksPath` on Windows. */
const shellPath = (path: string): string => path.replace(/\\/g, '/')

const shim = (original: string): string =>
  [
    '#!/bin/sh',
    '# Installed by Toucan: runs the hook this worktree saw before its push guard.',
    `exec "${shellPath(original)}" "$@"`,
    ''
  ].join('\n')

export type PushGuardResult = { ok: true } | { ok: false; error: string }

export async function installPushGuard(worktreePath: string, runGit: GitRunner): Promise<PushGuardResult> {
  const failed = (step: string, detail: string): PushGuardResult => ({
    ok: false,
    error: `could not install the push guard (${step}): ${detail.trim() || 'git failed'}`
  })
  try {
    const [hooks, gitDir] = await Promise.all([
      runGit(['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], worktreePath),
      runGit(['rev-parse', '--absolute-git-dir'], worktreePath)
    ])
    if (hooks.code !== 0) return failed('reading the hooks path', hooks.stderr)
    if (gitDir.code !== 0) return failed('reading the worktree git dir', gitDir.stderr)
    const guard = join(gitDir.stdout.trim(), GUARD_DIRECTORY)
    const original = hooks.stdout.trim()

    await mkdir(guard, { recursive: true })
    // Installing twice must not shim the guard onto itself.
    if (pathIdentity(original) !== pathIdentity(guard)) {
      const names = await readdir(original).catch(() => [] as string[])
      for (const name of names) {
        if (name === 'pre-push' || name.endsWith('.sample') || name.startsWith('.')) continue
        const path = join(original, name)
        if (!(await stat(path)).isFile()) continue
        await writeFile(join(guard, name), shim(path), { mode: 0o755 })
      }
    }
    const prePush = join(guard, 'pre-push')
    await writeFile(prePush, PRE_PUSH, { mode: 0o755 })
    await chmod(prePush, 0o755)

    const extension = await runGit(['config', 'extensions.worktreeConfig', 'true'], worktreePath)
    if (extension.code !== 0) return failed('enabling per-worktree config', extension.stderr)
    const hooksPath = await runGit(['config', '--worktree', 'core.hooksPath', shellPath(guard)], worktreePath)
    if (hooksPath.code !== 0) return failed('setting the worktree hooks path', hooksPath.stderr)

    // Checked, not assumed: a guard git does not see is no guard.
    const effective = await runGit(['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], worktreePath)
    if (effective.code !== 0 || pathIdentity(effective.stdout.trim()) !== pathIdentity(guard)) {
      return failed('verifying the hooks path', effective.stderr || `git reads hooks from ${effective.stdout.trim()}`)
    }
    return { ok: true }
  } catch (error) {
    return failed('writing the hooks', errorMessage(error))
  }
}
