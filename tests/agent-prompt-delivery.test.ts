import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { deliverAgentPrompt } from '../src/renderer/src/agent-prompt-delivery'

test('does not send a fallback prompt when request composition fails and recovers on the same delivery seam', async () => {
  let projectAvailable = false
  const delivered: string[] = []
  const compose = async (text: string): Promise<string> => {
    if (!projectAvailable) throw new Error('WSL failure for ADE project "Api" (alpha).')
    return `assignment\n\n${text}`
  }
  const send = async (prompt: string): Promise<{ ok: boolean }> => {
    delivered.push(prompt)
    return { ok: true }
  }

  const blocked = await deliverAgentPrompt('Ship it', compose, send)

  assert.equal(blocked.ok, false)
  assert.match(blocked.message ?? '', /WSL failure/)
  assert.deepEqual(delivered, [], 'composition failure must not send the captain text or any fallback')

  projectAvailable = true
  const recovered = await deliverAgentPrompt('Ship it', compose, send)

  assert.equal(recovered.ok, true)
  assert.deepEqual(delivered, ['assignment\n\nShip it'])
})
