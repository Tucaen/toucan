import assert from 'node:assert/strict'
import { test } from 'vitest'
import { continuePrompt, usageResetPrompts } from '../src/main/orchestration-control'
import { reopeningPrompt } from '../src/main/orchestration-pacing-coordinator'
import { startNowPrompt } from '../src/main/orchestration-start-now'
import { orchestratorWakePrompt, type OrchestrationRecord } from '../src/shared/orchestration'
import { askPrompt, replyPrompt, type SessionReplyKind } from '../src/shared/session-messaging'
import { RECENT_WRITE_WINDOW_MS, ticketConformanceSteers } from '../src/shared/ticket-conformance'
import { isToucanOriginText } from '../src/shared/toucan-origin'
import { isToucanHeader, toucanPrompt } from '../src/shared/toucan-prompt'

const sender = { shortId: 'abcd1234', title: 'Ticket' }

/** Every prompt Toucan composes, built by the real producer so a new wording cannot drift out of detection. */
function toucanPrompts(): Record<string, string> {
  const steer = ticketConformanceSteers({
    diagnostics: [{ path: 'D:/c/tickets/Bad Name.md', code: 'unusable-filename', message: 'Filename must be a slug.' }],
    writes: [{ agentId: 'node-1', path: 'D:/c/tickets/Bad Name.md', at: RECENT_WRITE_WINDOW_MS - 1 }],
    reported: new Map(),
    now: RECENT_WRITE_WINDOW_MS
  }).steers[0]
  assert.ok(steer, 'the malformed-ticket steer is produced')
  const prompts: Record<string, string> = {
    wake: orchestratorWakePrompt([{ kind: 'completed', ticketId: 'T1' } as never]),
    ask: askPrompt({ id: 'm1', text: 'hi' }, sender),
    continue: continuePrompt({ spawnCount: 20 } as OrchestrationRecord),
    usageResetTicket: usageResetPrompts.ticket,
    usageResetOrchestrator: usageResetPrompts.orchestrator,
    startNow: startNowPrompt('3'),
    pacing: reopeningPrompt('claude'),
    ticketSteer: steer.text
  }
  for (const replyKind of ['implicit', 'closed', 'reply'] as const satisfies readonly SessionReplyKind[]) {
    prompts[`reply:${replyKind}`] = replyPrompt({ askId: 'm1', text: 'ok', replyKind }, sender)
  }
  return prompts
}

test('every prompt Toucan composes opens with the uniform header', () => {
  for (const [name, prompt] of Object.entries(toucanPrompts())) {
    assert.equal(isToucanHeader(prompt), true, name)
    assert.equal(isToucanOriginText(prompt), true, name)
  }
})

test('the wrapper writes one header line above the body', () => {
  assert.equal(toucanPrompt('usage limit reset', 'Go on.'), '[Toucan: usage limit reset]\nGo on.')
})

test('prompts from before the uniform header are still Toucan-origin (legacy fallback)', () => {
  for (const text of [
    'The user pressed Continue (+20): the spawn budget is now 40.',
    'The user pressed Start now for ticket 3. Spawn it now.',
    'Usage limit reset. Review ticket status and continue the orchestration.',
    'Provider pacing reopened for claude. Before retrying spawn, reread usage.',
    '\n  Toucan: your ticket sessions reported in.',
    '[Toucan message m1 from session abcd1234 "Ticket"]\nhi',
    '[Toucan reply to your message m1 from session abcd1234 "Ticket"]\nok'
  ]) {
    assert.equal(isToucanOriginText(text), true, text)
  }
})

test('human-typed messages are not Toucan-origin', () => {
  for (const text of [
    'Please spawn ticket 3',
    'Continue',
    'What does "Toucan: your ticket sessions reported in." mean?',
    'Why did you send me "[Toucan: usage limit reset]"?',
    'I pressed Continue earlier',
    ''
  ]) {
    assert.equal(isToucanOriginText(text), false, text)
  }
})
