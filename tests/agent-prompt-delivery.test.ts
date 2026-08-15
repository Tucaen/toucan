import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { deliverAgentPrompt } from '../src/renderer/src/agent-prompt-delivery'

test('does not send a fallback prompt when request composition fails and recovers on the same delivery seam', async () => {
  let projectAvailable = false
  const conversation = {
    id: 'firstmate-captain',
    messages: ['Earlier captain work'],
    lifecycleTasks: ['unrelated-project-task'],
    delivered: [] as string[],
    async deliver(prompt: string): Promise<{ ok: boolean }> {
      this.delivered.push(prompt)
      this.messages.push(prompt)
      return { ok: true }
    }
  }
  const compose = async (text: string): Promise<string> => {
    if (!projectAvailable) throw new Error('WSL failure for ADE project "Api" (alpha).')
    return `assignment\n\n${text}`
  }
  const send = conversation.deliver.bind(conversation)

  const blocked = await deliverAgentPrompt('Ship it', compose, send)

  assert.equal(blocked.ok, false)
  assert.match(blocked.message ?? '', /WSL failure/)
  assert.deepEqual(conversation.delivered, [], 'composition failure must not send the captain text or any fallback')
  assert.equal(conversation.id, 'firstmate-captain')
  assert.deepEqual(conversation.messages, ['Earlier captain work'])
  assert.deepEqual(conversation.lifecycleTasks, ['unrelated-project-task'])

  projectAvailable = true
  const recovered = await deliverAgentPrompt('Ship it', compose, send)

  assert.equal(recovered.ok, true)
  assert.deepEqual(conversation.delivered, ['assignment\n\nShip it'])
  assert.equal(conversation.id, 'firstmate-captain')
  assert.deepEqual(conversation.messages, ['Earlier captain work', 'assignment\n\nShip it'])
  assert.deepEqual(conversation.lifecycleTasks, ['unrelated-project-task'])
})
