import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import {
  chooseAgentPromptApi,
  createDispatchOrderGate,
  deliverAgentPrompt
} from '../src/renderer/src/agent-prompt-delivery'

// The Composer's rendered disabled/queued-badge state and the useAgentConversation hook's
// queuing behavior (chooseAgentPromptApi routing, per-message queued flag, FIFO clearing) are
// exercised by actually rendering/running them in composer-queue-while-busy.dom.test.tsx (Vitest
// + jsdom + React Testing Library). What's left here is: the decision logic extracted into a
// pure, dependency-free function (exercised directly below), plus the underlying queuing engine
// (PromptWakeGate), which already has full behavioral coverage in prompt-wake-gate tests. The
// preload/main wiring needs no source-text assertion anymore: preload implements the shared
// AgentApi contract and both sides name the channel through AGENT_CHANNELS, so an omission is a
// compile error.

test('chooseAgentPromptApi routes to promptWhenIdle while working and to prompt while ready', async () => {
  const calls: string[] = []
  const prompt = async (id: string, text: string): Promise<{ ok: boolean }> => {
    calls.push(`prompt:${id}:${text}`)
    return { ok: true }
  }
  const promptWhenIdle = async (id: string, text: string): Promise<{ ok: boolean }> => {
    calls.push(`promptWhenIdle:${id}:${text}`)
    return { ok: true }
  }

  const workingDeliverer = chooseAgentPromptApi('working', { prompt, promptWhenIdle })
  assert.equal(workingDeliverer, promptWhenIdle, 'busy submits must route through the queue-capable API')
  await workingDeliverer('session-1', 'queued thought')

  const readyDeliverer = chooseAgentPromptApi('ready', { prompt, promptWhenIdle })
  assert.equal(readyDeliverer, prompt, 'ready submits must keep using the direct API, unchanged from today')
  await readyDeliverer('session-1', 'immediate thought')

  assert.deepEqual(calls, ['promptWhenIdle:session-1:queued thought', 'prompt:session-1:immediate thought'])
})

test('createDispatchOrderGate keeps dispatch in submission order even when an earlier composePrompt resolves later', async () => {
  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const gate = createDispatchOrderGate()
  const dispatchOrder: string[] = []

  const submitMessage = (label: string, composeDelayMs: number): Promise<unknown> => {
    const slot = gate.reserve()
    return deliverAgentPrompt(
      label,
      async (text) => {
        await delay(composeDelayMs)
        return text
      },
      async (prompt) => {
        await slot.previous
        dispatchOrder.push(prompt)
        slot.release()
        return { ok: true }
      }
    )
  }

  const first = submitMessage('first message', 30)
  const second = submitMessage('second message', 0)
  await Promise.all([first, second])

  assert.deepEqual(
    dispatchOrder,
    ['first message', 'second message'],
    'the first-submitted message must still dispatch before the second even though its composePrompt resolves later'
  )
})
