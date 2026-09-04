import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { initialNewChatForm, newChatProblem, newChatRequest, type NewChatForm } from '../mobile/src/new-chat'
import type { RemoteWorkspaceSnapshot } from '../src/shared/remote-access'

/**
 * The phone's "New chat" form, without a DOM. What is worth pinning is the boundary between "you
 * have not filled this in" and "the answer you picked went away": the project list is the
 * desktop's, so it can change under an open form, and the two cases need different words.
 */

function snapshot(projectIds: string[]): RemoteWorkspaceSnapshot {
  return {
    updatedAt: 1_000,
    projects: projectIds.map((id) => ({ id, name: id, color: '#71a9ff' })),
    chats: []
  }
}

function form(overrides: Partial<NewChatForm> = {}): NewChatForm {
  return { projectId: 'toucan', kind: 'claude', input: '', ...overrides }
}

describe('the form a phone starts a chat from', () => {
  test('defaults to the only project when there is only one', () => {
    assert.deepEqual(initialNewChatForm(snapshot(['toucan'])), { projectId: 'toucan', kind: 'claude', input: '' })
  })

  test('a workspace with no projects leaves nothing selected', () => {
    assert.equal(initialNewChatForm(snapshot([])).projectId, '')
  })
})

describe('what the form would send', () => {
  test('the first message is trimmed, and an empty one is omitted entirely', () => {
    assert.deepEqual(newChatRequest(form({ input: '  fix the parser  ' })), {
      projectId: 'toucan',
      kind: 'claude',
      input: 'fix the parser'
    })
    // Omitted, not empty: an empty string is a prompt the host refuses, and "just open it" is a
    // request it accepts.
    assert.deepEqual(newChatRequest(form({ input: '   ' })), { projectId: 'toucan', kind: 'claude' })
  })
})

describe('why the form cannot be submitted yet', () => {
  test('a filled-in form is submittable, with or without a first message', () => {
    assert.equal(newChatProblem(form(), snapshot(['toucan'])), null)
    assert.equal(newChatProblem(form({ kind: 'codex', input: 'go' }), snapshot(['toucan'])), null)
  })

  test('a desktop with no projects is named as the desktop problem it is', () => {
    assert.equal(newChatProblem(form(), snapshot([])), 'No projects are open on the desktop.')
  })

  test('nothing picked reads as a form to fill in', () => {
    assert.equal(newChatProblem(form({ projectId: '' }), snapshot(['toucan'])), 'Pick a project first.')
  })

  test('a picked project that has since closed says so instead of blaming the reader', () => {
    assert.equal(
      newChatProblem(form({ projectId: 'gone' }), snapshot(['toucan'])),
      'That project is no longer open on the desktop.'
    )
  })

  test('an unsendable first message is refused in the words the host would have used', () => {
    // The same shared predicate the host runs, so the greyed-out button and the refusal agree.
    assert.equal(
      newChatProblem(form({ input: 'x'.repeat(20_000) }), snapshot(['toucan'])),
      'A message may be at most 16000 characters.'
    )
  })
})
