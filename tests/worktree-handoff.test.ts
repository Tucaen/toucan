import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  invokesWorktreeSkill,
  buildHandoffPrompt,
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
  assert.equal(
    invokesWorktreeSkill('"Not sent" is wrongly displayed on my /$ade-project-skills:implement-in-worktree message'),
    false
  )
})

test('the skill itself gates every side effect on an explicit leading command', () => {
  const skill = readFileSync(join(process.cwd(), '.agents/skills/implement-in-worktree/SKILL.md'), 'utf8')
  const gate = skill.indexOf('## Invocation gate')
  const settle = skill.indexOf('## 1. Settle the worktree')

  assert.ok(gate >= 0 && gate < settle, 'the invocation gate must run before worktree creation')
  assert.match(skill, /first non-empty line/)
  assert.match(skill, /skill block attached to a prompt .* is not evidence of invocation/)
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
  const plan = planWorktreeHandoff('/implement-in-worktree add a button', {
    hasHistory: false,
    alreadyInWorktree: false,
    provider: 'claude'
  })
  assert.equal(plan?.mode, 'fresh')
  assert.equal(plan?.prompt, '/implement-in-worktree add a button')
})

test('an ongoing conversation must carry its history into the worktree', () => {
  const plan = planWorktreeHandoff('/implement-in-worktree now build it', {
    hasHistory: true,
    alreadyInWorktree: false,
    provider: 'claude'
  })
  assert.equal(plan?.mode, 'handoff')
})

test('a prompt that does not invoke the skill produces no plan at all', () => {
  assert.equal(
    planWorktreeHandoff('just fix the bug', { hasHistory: false, alreadyInWorktree: false, provider: 'claude' }),
    null
  )
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
    alreadyInWorktree: true,
    provider: 'codex'
  })
  assert.equal(plan, null)
})

test('Codex carries its conversation by moving the node into the worktree', () => {
  const plan = planWorktreeHandoff('/implement-in-worktree now build it', {
    hasHistory: true,
    alreadyInWorktree: false,
    provider: 'codex'
  })
  assert.equal(plan?.mode, 'rehome')
})

test('a first message starts fresh whichever provider it is', () => {
  for (const provider of ['claude', 'codex'] as const) {
    const plan = planWorktreeHandoff('/implement-in-worktree go', {
      hasHistory: false,
      alreadyInWorktree: false,
      provider
    })
    assert.equal(plan?.mode, 'fresh')
  }
})

test('a handoff carries the dialogue and ends with the prompt that asked for it', () => {
  const text = buildHandoffPrompt(
    [
      { role: 'user', text: 'the login page is broken' },
      { role: 'thought', text: 'private reasoning that must not travel' },
      { role: 'assistant', text: 'it throws on a null session' }
    ],
    '/implement-in-worktree fix it'
  )
  assert.match(text, /User: the login page is broken/)
  assert.match(text, /Assistant: it throws on a null session/)
  assert.equal(text.includes('private reasoning'), false)
  assert.match(text, /\/implement-in-worktree fix it$/)
})

test('a handoff with nothing worth carrying is just the prompt', () => {
  assert.equal(buildHandoffPrompt([], '/implement-in-worktree go'), '/implement-in-worktree go')
  assert.equal(
    buildHandoffPrompt([{ role: 'thought', text: 'hmm' }], '/implement-in-worktree go'),
    '/implement-in-worktree go'
  )
})
