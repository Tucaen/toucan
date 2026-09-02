import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'
import { decisionQuestions } from '../src/main/acp-session-manager'

test('normalizes a multi-question AskUserQuestion form without losing options or Other fields', () => {
  const request = {
    mode: 'form',
    sessionId: 'session-1',
    message: 'Please answer the following questions.',
    requestedSchema: {
      type: 'object',
      properties: {
        question_0: {
          type: 'string',
          title: 'Scope',
          description: 'Read-only zuerst?',
          oneOf: [
            { const: 'Read-only', title: 'Read-only', description: 'Recommended' },
            { const: 'Complete CRUD', title: 'Complete CRUD' }
          ]
        },
        question_0_custom: {
          type: 'string',
          title: 'Other',
          _meta: { _askUserQuestionCustomAnswer: { questionId: 'question_0', isCustomAnswer: true } }
        },
        question_1: {
          type: 'string',
          title: 'Navigation',
          description: 'What should the row click replace?',
          oneOf: [
            { const: 'Replace VP Cockpit', title: 'Replace VP Cockpit' },
            { const: 'Keep both', title: 'Keep both' }
          ]
        }
      }
    }
  } as CreateElicitationRequest

  assert.deepEqual(decisionQuestions(request), [
    {
      id: 'question_0',
      title: 'Scope',
      question: 'Read-only zuerst?',
      options: [
        { value: 'Read-only', label: 'Read-only', description: 'Recommended' },
        { value: 'Complete CRUD', label: 'Complete CRUD' }
      ],
      input: 'select',
      multiSelect: false,
      customAnswerId: 'question_0_custom'
    },
    {
      id: 'question_1',
      title: 'Navigation',
      question: 'What should the row click replace?',
      options: [
        { value: 'Replace VP Cockpit', label: 'Replace VP Cockpit' },
        { value: 'Keep both', label: 'Keep both' }
      ],
      input: 'select',
      multiSelect: false
    }
  ])
})

test('normalizes every primitive ACP form field that Toucan advertises', () => {
  const request = {
    mode: 'form',
    sessionId: 'session-2',
    message: 'Configuration',
    requestedSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', title: 'Note' },
        retries: { type: 'integer', title: 'Retries' },
        enabled: { type: 'boolean', title: 'Enabled' }
      }
    }
  } as CreateElicitationRequest

  assert.deepEqual(
    decisionQuestions(request).map(({ id, input }) => ({ id, input })),
    [
      { id: 'note', input: 'text' },
      { id: 'retries', input: 'number' },
      { id: 'enabled', input: 'boolean' }
    ]
  )
})
