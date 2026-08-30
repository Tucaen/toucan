import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { deriveConversationTitle } from '../src/shared/conversation-title'

test('waits for a real exchange before deriving a conversation title', () => {
  assert.equal(deriveConversationTitle([
    { role: 'user', text: 'continue' },
    { role: 'assistant', text: 'What should I continue with?' }
  ]), null)
})

test('derives a concise subject from substantive dialogue instead of injected or generic openers', () => {
  assert.equal(deriveConversationTitle([
    { role: 'user', text: '<environment_context>cwd=D:\\Development\\ADE</environment_context>' },
    { role: 'user', text: 'continue' },
    { role: 'assistant', text: 'I found the workspace recovery implementation.' },
    { role: 'user', text: 'Fix workspace recovery when both snapshots are corrupt' },
    { role: 'assistant', text: 'I will preserve the damaged files and require explicit acknowledgement.' }
  ]), 'Fix workspace recovery when both snapshots are corrupt')
})

test('uses the first meaningful line of a pasted prompt and caps the title length', () => {
  assert.equal(deriveConversationTitle([
    { role: 'user', text: 'Background notes:\nThe composer queue cannot withdraw prompts after steering.\nPlease make queued prompts editable before they are sent to the adapter.' },
    { role: 'assistant', text: 'I will keep the queue in the renderer and add edit and withdraw controls.' }
  ]), 'Make queued prompts editable before they are sent to the adapter')
})

test('can identify the subject after a bare continue once the conversation has enough answers', () => {
  assert.equal(deriveConversationTitle([
    { role: 'user', text: 'continue' },
    { role: 'assistant', text: 'I found the failure in the workspace recovery path.' },
    { role: 'user', text: 'go on' },
    { role: 'assistant', text: 'Workspace recovery must preserve corrupt snapshots' }
  ]), 'Workspace recovery must preserve corrupt snapshots')
})
