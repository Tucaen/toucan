import { strict as assert } from 'node:assert'
import { test } from 'vitest'
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

function selectField(title: string, labels: string[]) {
  return {
    type: 'string',
    title,
    description: `${title}?`,
    oneOf: labels.map((label) => ({ const: label, title: label }))
  }
}

function form(properties: Record<string, unknown>): CreateElicitationRequest {
  return {
    mode: 'form',
    sessionId: 'session-3',
    message: 'Pick',
    requestedSchema: { type: 'object', properties }
  } as CreateElicitationRequest
}

test('folds claude-agent-acp per-question custom fields into their questions instead of listing them as questions', () => {
  // The shape claude-agent-acp 0.84 sends to every non-AIR client: unmarked `question_<n>_custom` fields.
  const questions = decisionQuestions(
    form({
      question_0: selectField('Color', ['Teal', 'Blue']),
      question_0_custom: { type: 'string', title: 'Other', description: 'Type your own answer, or add a note.' },
      question_1: selectField('Avatar', ['Avatar', 'Initials']),
      question_1_custom: { type: 'string', title: 'Other', description: 'Type your own answer, or add a note.' }
    })
  )

  assert.deepEqual(
    questions.map(({ id, title, customAnswerId, customAnswerHint }) => ({
      id,
      title,
      customAnswerId,
      customAnswerHint
    })),
    [
      {
        id: 'question_0',
        title: 'Color',
        customAnswerId: 'question_0_custom',
        customAnswerHint: 'Type your own answer, or add a note.'
      },
      {
        id: 'question_1',
        title: 'Avatar',
        customAnswerId: 'question_1_custom',
        customAnswerHint: 'Type your own answer, or add a note.'
      }
    ]
  )
})

test('folds custom fields marked for JetBrains AIR or as a codex-acp user note', () => {
  const questions = decisionQuestions(
    form({
      layout: selectField('Layout', ['Grid', 'List']),
      layout_extra: {
        type: 'string',
        title: 'Other',
        _meta: { jetbrains: { air: { customAnswer: { questionId: 'layout', isCustomAnswer: true } } } }
      },
      store: selectField('Store', ['JSON', 'None of the above']),
      store_note: {
        type: 'string',
        title: 'Additional answer or note',
        _meta: { codex: { questionId: 'store', role: 'user_note' } }
      }
    })
  )

  assert.deepEqual(
    questions.map(({ id, customAnswerId }) => ({ id, customAnswerId })),
    [
      { id: 'layout', customAnswerId: 'layout_extra' },
      { id: 'store', customAnswerId: 'store_note' }
    ]
  )
})

test('keeps a field whose suffix only looks like a custom answer when no question carries its base id', () => {
  const questions = decisionQuestions(form({ deploy_custom: { type: 'string', title: 'Custom deploy target' } }))

  assert.deepEqual(
    questions.map(({ id, input, customAnswerId }) => ({ id, input, customAnswerId })),
    [{ id: 'deploy_custom', input: 'text', customAnswerId: undefined }]
  )
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
