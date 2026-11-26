import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import type { AgentDecisionQuestion, AgentDecisionRequest } from '../src/shared/agent'
import { decisionContext } from '../src/shared/decision-context'

/**
 * Claude's adapter sends a single AskUserQuestion with the question's own text as the request's
 * message, so a form that shows both prints the same paragraph twice - on a screenshot gate, a
 * whole screen of it on the phone. The message is context only when it says something the question
 * does not.
 */

function question(text: string): AgentDecisionQuestion {
  return { id: 'q', question: text, options: [], input: 'select', multiSelect: false }
}

function request(message: string, ...texts: string[]): AgentDecisionRequest {
  return { id: 'd1', message, questions: texts.map(question) }
}

const GATE =
  'Screenshot gate, ticket 08. The shots are in [layer_step_hint.png](file:///D:/shots/layer_step_hint.png). Do you OK these shots?'

test('a message identical to the only question is not context', () => {
  assert.equal(decisionContext(request(GATE, GATE)), undefined)
})

test('whitespace, case and closing punctuation do not make a repeat new context', () => {
  assert.equal(decisionContext(request('  Ship  it\nnow? ', 'ship it now')), undefined)
})

test('a message the only question already contains is not context', () => {
  assert.equal(decisionContext(request('Do you OK these shots?', GATE)), undefined)
})

test('a message that adds to the question is kept as written', () => {
  const message = 'Gate for ticket 08, see the shots above.'
  assert.equal(decisionContext(request(message, 'Do you OK these shots?')), message)
})

test('a question set keeps its message, even one equal to the first question', () => {
  assert.equal(decisionContext(request('Which theme?', 'Which theme?', 'Which editor?')), 'Which theme?')
})

test('an empty message is no context', () => {
  assert.equal(decisionContext(request('  ', 'Which theme?')), undefined)
})
