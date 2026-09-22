import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { describeBranchChoiceBlocker, parseLocalBranches } from '../src/shared/git-branch'

// The switcher only ever offers what git can actually check out in the project checkout, and it
// says why an entry is greyed out - so every rule about that lives here, in pure functions.

test('local branches are parsed with their worktree and the current one sorts first', () => {
  const branches = parseLocalBranches(
    [
      'feature/login\t \tD:/Development/Toucan-worktrees/feature-login',
      'main\t*\tD:/Development/Toucan',
      'chore/deps\t \t',
      '(HEAD detached at 9f1c2ab)\t \tD:/Development/Toucan-worktrees/spike',
      ''
    ].join('\n')
  )

  assert.deepEqual(branches, [
    { name: 'main', current: true, worktreePath: 'D:/Development/Toucan' },
    { name: 'chore/deps', current: false },
    { name: 'feature/login', current: false, worktreePath: 'D:/Development/Toucan-worktrees/feature-login' }
  ])
})

test('a branch is blocked when current, held by a worktree, or while a session is working', () => {
  const free = { name: 'chore/deps', current: false }
  assert.equal(describeBranchChoiceBlocker(free, { workingSessions: 0 }), undefined)
  assert.equal(
    describeBranchChoiceBlocker({ name: 'main', current: true }, { workingSessions: 0 }),
    'Already checked out'
  )
  assert.equal(
    describeBranchChoiceBlocker(
      { name: 'feature/login', current: false, worktreePath: 'D:/wt/feature-login' },
      { workingSessions: 0 }
    ),
    'Checked out in D:/wt/feature-login'
  )
  assert.match(describeBranchChoiceBlocker(free, { workingSessions: 1 }) ?? '', /^1 session is working/)
  assert.match(describeBranchChoiceBlocker(free, { workingSessions: 3 }) ?? '', /^3 sessions are working/)
})
