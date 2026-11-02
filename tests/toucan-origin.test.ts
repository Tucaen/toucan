import assert from 'node:assert/strict'
import { test } from 'vitest'
import { orchestratorWakePrompt } from '../src/shared/orchestration'
import { askPrompt, replyPrompt } from '../src/shared/session-messaging'
import { isToucanOriginText } from '../src/shared/toucan-origin'

test('the orchestrator wake prompt is Toucan-origin', () => {
  const prompt = orchestratorWakePrompt([{ kind: 'completed', ticketId: 'T1' } as never])
  assert.equal(isToucanOriginText(prompt), true)
})

test('sibling-session messages are Toucan-origin', () => {
  const sender = { shortId: 'abcd1234', title: 'Ticket' }
  assert.equal(isToucanOriginText(askPrompt({ id: 'm1', text: 'hi' }, sender)), true)
  for (const replyKind of ['implicit', 'closed', 'explicit'] as const) {
    assert.equal(isToucanOriginText(replyPrompt({ askId: 'm1', text: 'ok', replyKind } as never, sender)), true)
  }
})

test('Continue, Start now, usage-reset and pacing notices are Toucan-origin', () => {
  for (const text of [
    'The user pressed Continue (+20): the spawn budget is now 40.',
    'The user pressed Start now for ticket 3. Spawn it now.',
    'Usage limit reset. Review ticket status and continue the orchestration.',
    'Provider pacing reopened for claude. Before retrying spawn, reread usage.',
    '\n  Toucan: your ticket sessions reported in.'
  ]) {
    assert.equal(isToucanOriginText(text), true, text)
  }
})

test('human-typed messages are not Toucan-origin', () => {
  for (const text of [
    'Please spawn ticket 3',
    'Continue',
    'What does "Toucan: your ticket sessions reported in." mean?',
    'I pressed Continue earlier',
    ''
  ]) {
    assert.equal(isToucanOriginText(text), false, text)
  }
})
