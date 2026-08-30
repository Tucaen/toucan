import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  invokesWorktreeSkill,
  placeholderBranchName,
  planWorktreeHandoff
} from '../src/shared/worktree-handoff'

test('a prompt opening with the slash command invokes the skill', () => {
  assert.equal(invokesWorktreeSkill('/implement-in-worktree fix the login bug'), true)
  assert.equal(invokesWorktreeSkill('/implement-in-worktree'), true)
})

test('leading blank lines and spaces do not hide the invocation', () => {
  assert.equal(invokesWorktreeSkill('\n\n   /implement-in-worktree do the thing'), true)
})

test('talking about the skill is not calling it', () => {
  assert.equal(invokesWorktreeSkill('what does /implement-in-worktree do?'), false)
  assert.equal(invokesWorktreeSkill('later, run /implement-in-worktree'), false)
})

test('a different skill with the same prefix does not trigger it', () => {
  assert.equal(invokesWorktreeSkill('/implement-in-worktree-v2 go'), false)
  assert.equal(invokesWorktreeSkill('/implement something'), false)
})

test('an empty prompt invokes nothing', () => {
  assert.equal(invokesWorktreeSkill(''), false)
  assert.equal(invokesWorktreeSkill('   \n  '), false)
})

test('a first message needs no handoff: there is nothing to carry', () => {
  const plan = planWorktreeHandoff('/implement-in-worktree add a button', { hasHistory: false, alreadyInWorktree: false })
  assert.equal(plan?.needsHandoff, false)
  assert.equal(plan?.prompt, '/implement-in-worktree add a button')
})

test('an ongoing conversation must carry its history into the worktree', () => {
  const plan = planWorktreeHandoff('/implement-in-worktree now build it', { hasHistory: true, alreadyInWorktree: false })
  assert.equal(plan?.needsHandoff, true)
})

test('a prompt that does not invoke the skill produces no plan at all', () => {
  assert.equal(planWorktreeHandoff('just fix the bug', { hasHistory: false, alreadyInWorktree: false }), null)
})

test('the placeholder branch is valid, provisional, and free of the prompt text', () => {
  const branch = placeholderBranchName(new Date(2026, 7, 30, 9, 5, 3))
  assert.equal(branch, 'ade/20260830-090503')
})

test('placeholder branches taken a second apart do not collide', () => {
  const first = placeholderBranchName(new Date(2026, 7, 30, 9, 5, 3))
  const second = placeholderBranchName(new Date(2026, 7, 30, 9, 5, 4))
  assert.notEqual(first, second)
})

test('a session already running in a worktree keeps the work where it is', () => {
  const plan = planWorktreeHandoff('/implement-in-worktree keep going', {
    hasHistory: true,
    alreadyInWorktree: true
  })
  assert.equal(plan, null)
})
