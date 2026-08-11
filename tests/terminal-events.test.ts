import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { sendTerminalEvent, type TerminalEventOwner } from '../src/main/terminal-events'

test('ignores terminal events after the renderer owner is destroyed', () => {
  let sendCount = 0
  const owner: TerminalEventOwner = {
    isDestroyed: () => true,
    send: () => {
      sendCount += 1
      throw new TypeError('Object has been destroyed')
    }
  }

  assert.doesNotThrow(() => sendTerminalEvent(owner, 'terminal:data', { data: 'late output' }))
  assert.equal(sendCount, 0)
})
