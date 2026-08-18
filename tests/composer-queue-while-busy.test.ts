import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { chooseAgentPromptApi, createDispatchOrderGate, deliverAgentPrompt } from '../src/renderer/src/agent-prompt-delivery'

// This project's renderer has no jsdom/react-testing-library harness (see other
// tests under tests/*panel*.test.ts), so the parts of this feature that live inside
// a React component (Composer's disabled state, the queued-badge JSX) or cross a
// process boundary (preload/main IPC wiring) are verified by asserting on source
// text below, the same pattern used throughout this test suite. The decision logic
// itself (which agent API a submit routes through) is extracted into a pure,
// dependency-free function and exercised directly, and the underlying queuing
// engine (CaptainWakeGate) already has full behavioral coverage in
// firstmate-captain-wake.test.ts.

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

test('submit() queues while busy instead of no-oping, and is unaffected when ready', () => {
  const hook = readFileSync(join(process.cwd(), 'src/renderer/src/use-agent-conversation.ts'), 'utf8')

  assert.doesNotMatch(
    hook,
    /if \(!text \|\| status !== 'ready'\) return/,
    'submit must no longer bail out entirely while the agent is busy'
  )
  assert.match(
    hook,
    /if \(!text \|\| \(status !== 'ready' && status !== 'working'\)\) return/,
    'submit should still require non-empty text and only bail for statuses that are neither ready nor working'
  )
  assert.match(
    hook,
    /chooseAgentPromptApi\(status, window\.agentApi\)/,
    'submit should delegate to the extracted, directly-tested API selection function'
  )
  assert.match(
    hook,
    /if \(!queued\) setStatus\('ready'\)/,
    'a failed queued submit must not force the still-busy session back to ready'
  )
})

test('a queued message is marked distinct from a delivered one and clears once the agent actually starts it', () => {
  const hook = readFileSync(join(process.cwd(), 'src/renderer/src/use-agent-conversation.ts'), 'utf8')

  assert.match(
    hook,
    /queued\?\: boolean/,
    'AgentChatMessage should carry a queued flag so the UI can distinguish it from a delivered message'
  )
  assert.match(
    hook,
    /role: 'user', text, queued \}/,
    'a message sent while busy should be recorded as queued'
  )
  assert.match(
    hook,
    /pendingSentRef\.current\[0\]\?\.text === event\.text/,
    'each sent message should be matched against the oldest still-unconfirmed one (FIFO), not a single overwritable ref, so multiple in-flight queued sends each clear independently'
  )
})

test('the composer stays interactive while the agent is working, and only disables for starting/auth_required/exited', () => {
  const chatNode = readFileSync(join(process.cwd(), 'src/renderer/src/ChatNode.tsx'), 'utf8')

  assert.doesNotMatch(
    chatNode,
    /composerDisabled = busy \|\|/,
    'composerDisabled must no longer key off busy/working'
  )
  assert.match(
    chatNode,
    /composerDisabled = props\.status === 'starting' \|\| props\.status === 'auth_required' \|\| props\.status === 'exited'/,
    'composerDisabled should match the same starting/auth_required/exited scope selectorsDisabled already uses'
  )
  assert.match(
    chatNode,
    /disabled=\{!props\.draft\.trim\(\) \|\| composerDisabled\}/,
    'the submit button should stay enabled while working, so a queued send is possible'
  )
  assert.match(
    chatNode,
    /queued-badge/,
    'a queued message should render a visible indicator distinguishing it from an already-delivered message'
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
