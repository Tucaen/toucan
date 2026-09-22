import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { describeGitBranch } from '../src/shared/git-branch'

/**
 * "On some branch, all fine" is the one thing the indicator must never say when it is not true, so
 * each of the four answers a checkout can give gets its own row here.
 */

const DIRECTORY = 'D:\\Development\\Toucan-worktrees\\feature-login'

test('a checkout on a branch names the branch and the directory it belongs to', () => {
  assert.deepEqual(describeGitBranch({ isRepository: true, branch: 'feature/login' }, DIRECTORY), {
    label: 'feature/login',
    // The directory is in the title because a node may be running in a worktree rather than the
    // project, and "on feature/login" alone would not say which checkout that is.
    title: `${DIRECTORY} is on feature/login`
  })
})

test('a detached HEAD says so, with the commit when git named one', () => {
  assert.deepEqual(describeGitBranch({ isRepository: true, detachedHead: '9f1c2ab' }, DIRECTORY), {
    label: 'detached at 9f1c2ab',
    title: `${DIRECTORY} has a detached HEAD at 9f1c2ab`
  })
  assert.deepEqual(describeGitBranch({ isRepository: true }, DIRECTORY), {
    label: 'detached',
    title: `${DIRECTORY} has a detached HEAD`
  })
})

test('a path that is not a repository, or could not be inspected, gets no row at all', () => {
  assert.equal(describeGitBranch({ isRepository: false }, DIRECTORY), undefined)
  assert.equal(describeGitBranch(null, DIRECTORY), undefined)
  // A branch reported alongside `isRepository: false` is not a reason to render one anyway.
  assert.equal(describeGitBranch({ isRepository: false, branch: 'main' }, DIRECTORY), undefined)
})
