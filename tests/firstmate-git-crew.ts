import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FirstMateWorktreeProvenance } from '../src/main/firstmate-worktree-provenance'

/**
 * Real Git worktrees for provenance tests, so the evidence the runtime gathers with `git rev-parse`
 * can be reproduced against genuine repositories rather than hand-authored paths. No test touches WSL;
 * everything here is read-only Git evidence built on the host.
 */

/** A real external checkout plus one FirstMate-style linked crew worktree cut from it. */
export interface GitCrew {
  root: string
  primary: string
  worktree: string
}

export function createGitCrew(label: string): GitCrew {
  const root = mkdtempSync(join(tmpdir(), `ade-git-crew-${label}-`))
  const primary = join(root, 'primary')
  mkdirSync(primary)
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: primary })
  execFileSync('git', ['config', 'user.name', 'ADE Test'], { cwd: primary })
  execFileSync('git', ['config', 'user.email', 'ade@example.invalid'], { cwd: primary })
  writeFileSync(join(primary, 'README.md'), `${label}\n`, 'utf8')
  execFileSync('git', ['add', 'README.md'], { cwd: primary })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: primary })
  const worktree = join(root, 'crew')
  execFileSync('git', ['worktree', 'add', '-b', `${label}-crew`, worktree], { cwd: primary })
  return { root, primary, worktree }
}

/** The same read-only `git rev-parse` the runtime's WSL lifecycle read script runs, on the host. */
export function gitIdentity(dir: string): { gitDir: string; commonDir: string } {
  const revParse = (arg: string): string => execFileSync(
    'git', ['-C', dir, 'rev-parse', '--path-format=absolute', arg], { encoding: 'utf8' }
  ).trim()
  return { gitDir: revParse('--git-dir'), commonDir: revParse('--git-common-dir') }
}

/** The provenance the runtime would attach for a worktree reported against a pinned checkout. */
export function gitProvenance(worktreeDir: string, checkoutDir: string): FirstMateWorktreeProvenance {
  return {
    worktree: gitIdentity(worktreeDir),
    checkout: { commonDir: gitIdentity(checkoutDir).commonDir }
  }
}
