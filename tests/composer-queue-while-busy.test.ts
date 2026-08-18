import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { chooseAgentPromptApi, createDispatchOrderGate, deliverAgentPrompt } from '../src/renderer/src/agent-prompt-delivery'

// The Composer's rendered disabled/queued-badge state and the useAgentConversation hook's
// queuing behavior (chooseAgentPromptApi routing, per-message queued flag, FIFO clearing) are
// exercised by actually rendering/running them in composer-queue-while-busy.dom.test.tsx (Vitest
// + jsdom + React Testing Library). What's left here is: the decision logic extracted into a
// pure, dependency-free function (exercised directly below); the underlying queuing engine
// (CaptainWakeGate), which already has full behavioral coverage in
// firstmate-captain-wake.test.ts; and the cross-process preload/main/acp-session-manager IPC
// wiring, which jsdom cannot exercise and so remains a documented source-text assertion.

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

test('promptWhenIdle is exposed to the renderer the same way prompt is, backed by the generic session manager method', () => {
  const preload = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
  const preloadTypes = readFileSync(join(process.cwd(), 'src/preload/index.d.ts'), 'utf8')
  const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  const manager = readFileSync(join(process.cwd(), 'src/main/acp-session-manager.ts'), 'utf8')

  assert.match(
    preload,
    /promptWhenIdle: \(id: string, text: string\).*=>\s*\(?\s*ipcRenderer\.invoke\('agent:prompt-when-idle', id, text\)/s,
    'preload should expose promptWhenIdle alongside prompt'
  )
  assert.match(preloadTypes, /promptWhenIdle\(id: string, text: string\): Promise<AgentPromptResult>/)
  assert.match(
    main,
    /ipcMain\.handle\('agent:prompt-when-idle', \(_event, id: string, text: string\) => manager\.promptWhenIdle\(id, text\)\)/,
    'main should register an IPC handler backed by the already-generic promptWhenIdle'
  )
  assert.doesNotMatch(
    manager,
    /if \(request\.scope === 'firstmate'\) \{\s*running\.wakeGate = createCaptainWakeGate/,
    'the wake gate must no longer be limited to firstmate-scoped sessions for the human composer to be able to queue too'
  )
  assert.match(
    manager,
    /running\.wakeGate = createCaptainWakeGate\(\{/,
    'every session should get a wake gate so promptWhenIdle can queue regardless of scope'
  )
})
