import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

// This project's renderer has no jsdom/react-testing-library harness (see other
// tests under tests/*panel*.test.ts), so renderer-side contracts here are verified
// by asserting on source text, the same pattern used throughout this test suite.
// The underlying queuing engine (CaptainWakeGate) already has full behavioral
// coverage in firstmate-captain-wake.test.ts.

test('submit() queues via promptWhenIdle while busy instead of no-oping, and is unaffected when ready', () => {
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
    /window\.agentApi\.promptWhenIdle\(options\.id, prompt\)/,
    'a busy submit should be delivered through the wake-gate queuing API'
  )
  assert.match(
    hook,
    /window\.agentApi\.prompt\(options\.id, prompt\)/,
    'a ready submit should still use the direct prompt API, unchanged from today'
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
    /message\.role === 'user' && message\.text === event\.text && message\.queued\s*\n\s*\? \{ \.\.\.message, queued: false \}/,
    'the queued flag should clear once the agent echoes the message back, i.e. actually starts processing it'
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
