import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import {
  branchNameProblem,
  deriveWorktreeDirectory,
  isForcibleBlocker,
  worktreeDirectorySlug
} from '../src/shared/worktree'
import { describeForcedRemovalCost, planWorktreeRemoval } from '../src/renderer/src/worktree-removal'

test('a worktree directory sits beside the checkout, never inside it', () => {
  assert.equal(
    deriveWorktreeDirectory('D:\\Development\\Toucan', 'feature/login'),
    'D:\\Development\\Toucan-worktrees\\feature-login'
  )
  assert.equal(deriveWorktreeDirectory('/home/dev/toucan', 'fix/crash'), '/home/dev/toucan-worktrees/fix-crash')
  // A trailing separator on the project path must not produce an empty container segment.
  assert.equal(
    deriveWorktreeDirectory('D:\\Development\\Toucan\\', 'main-2'),
    'D:\\Development\\Toucan-worktrees\\main-2'
  )
})

test('branch names collapse to one safe directory segment', () => {
  assert.equal(worktreeDirectorySlug('feature/login'), 'feature-login')
  assert.equal(worktreeDirectorySlug('release/2026.08//rc1'), 'release-2026.08-rc1')
  assert.equal(worktreeDirectorySlug('--weird--'), 'weird')
})

test('obviously invalid branch names are rejected before any process starts', () => {
  assert.equal(branchNameProblem('feature/login'), null)
  assert.equal(branchNameProblem('fix-123'), null)
  assert.ok(branchNameProblem(''))
  assert.ok(branchNameProblem('has space'))
  assert.ok(branchNameProblem('back..track'))
  assert.ok(branchNameProblem('/leading'))
  assert.ok(branchNameProblem('trailing/'))
  assert.ok(branchNameProblem('-dashed'))
  assert.ok(branchNameProblem('locked.lock'))
  assert.ok(branchNameProblem('caret^here'))
})

test('identity blockers can never be forced, unsaved-work blockers can', () => {
  assert.equal(isForcibleBlocker({ kind: 'attached-nodes', count: 2 }), false)
  assert.equal(isForcibleBlocker({ kind: 'primary-worktree' }), false)
  assert.equal(isForcibleBlocker({ kind: 'not-a-worktree', detail: 'x' }), false)
  assert.equal(isForcibleBlocker({ kind: 'inspection-failed', detail: 'x' }), false)
  assert.equal(isForcibleBlocker({ kind: 'uncommitted-changes', files: 1 }), true)
  assert.equal(isForcibleBlocker({ kind: 'untracked-files', files: 1 }), true)
  assert.equal(isForcibleBlocker({ kind: 'stashed-changes', entries: 1 }), true)
  assert.equal(isForcibleBlocker({ kind: 'unpublished-commits', commits: 1 }), true)
})

test('a clean, merged worktree with no attached nodes is ready to remove', () => {
  const plan = planWorktreeRemoval(0, [])
  assert.equal(plan.decision, 'ready')
  assert.deepEqual(plan.hard, [])
  assert.deepEqual(plan.forcible, [])
})

test('attached nodes block removal outright, no confirmation offered', () => {
  const plan = planWorktreeRemoval(2, [{ kind: 'uncommitted-changes', files: 3 }])
  assert.equal(plan.decision, 'blocked')
  assert.deepEqual(plan.hard, [{ kind: 'attached-nodes', count: 2 }])
  // The unsaved-work blocker is still reported, it just cannot be acted on yet.
  assert.deepEqual(plan.forcible, [{ kind: 'uncommitted-changes', files: 3 }])
})

test('unsaved work asks for a confirmation rather than refusing', () => {
  const plan = planWorktreeRemoval(0, [
    { kind: 'untracked-files', files: 4 },
    { kind: 'unpublished-commits', commits: 2 }
  ])
  assert.equal(plan.decision, 'confirm')
  assert.deepEqual(plan.hard, [])
  assert.equal(plan.forcible.length, 2)
})

test('a failed inspection blocks removal instead of assuming the worktree is empty', () => {
  const plan = planWorktreeRemoval(0, [{ kind: 'inspection-failed', detail: 'git status failed' }])
  assert.equal(plan.decision, 'blocked')
})

test('the forced-removal warning never claims commits are at risk', () => {
  const withFiles = describeForcedRemovalCost([{ kind: 'uncommitted-changes', files: 2 }])
  assert.match(withFiles, /uncommitted and untracked files/)
  assert.match(withFiles, /branch and its commits stay/)

  const commitsOnly = describeForcedRemovalCost([{ kind: 'unpublished-commits', commits: 3 }])
  assert.doesNotMatch(commitsOnly, /deletes/)
  assert.match(commitsOnly, /only the working directory is removed/)
})
