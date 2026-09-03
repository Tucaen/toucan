import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  initialAssistantPresentation,
  settleCurrentAssistantTurn,
  settleReplayedAssistantTurns
} from '../src/shared/assistant-presentation'

test('unphased assistant text is provisional progress until its turn completes', () => {
  const initial = initialAssistantPresentation(undefined)
  assert.deepEqual(initial, { presentation: 'progress', presentationProvisional: true })

  const settled = settleCurrentAssistantTurn([
    { id: 'progress', role: 'assistant' as const, text: 'Inspecting files.', complete: false, ...initial },
    {
      id: 'answer',
      role: 'assistant' as const,
      text: 'Implemented the change.',
      complete: false,
      ...initialAssistantPresentation(undefined)
    }
  ])

  assert.deepEqual(
    settled.map(({ presentation, presentationProvisional, complete }) => ({
      presentation,
      presentationProvisional,
      complete
    })),
    [
      { presentation: 'progress', presentationProvisional: false, complete: true },
      { presentation: 'final', presentationProvisional: false, complete: true }
    ]
  )
})

test('provider-labelled progress stays progress even when no final answer follows', () => {
  const settled = settleCurrentAssistantTurn([
    {
      id: 'progress',
      role: 'assistant' as const,
      text: 'Still working.',
      complete: false,
      ...initialAssistantPresentation('progress')
    }
  ])

  assert.equal(settled[0].presentation, 'progress')
  assert.equal(settled[0].presentationProvisional, false)
  assert.equal(settled[0].complete, true)
})

test('replay settles each user turn independently', () => {
  const provisional = initialAssistantPresentation(undefined)
  const settled = settleReplayedAssistantTurns([
    { id: 'user-1', role: 'user' as const, text: 'First' },
    { id: 'progress-1', role: 'assistant' as const, text: 'Working one', ...provisional },
    { id: 'answer-1', role: 'assistant' as const, text: 'Done one', ...provisional },
    { id: 'user-2', role: 'user' as const, text: 'Second' },
    { id: 'answer-2', role: 'assistant' as const, text: 'Done two', ...provisional }
  ])

  assert.deepEqual(
    settled.filter((message) => message.role === 'assistant').map((message) => message.presentation),
    ['progress', 'final', 'final']
  )
})
