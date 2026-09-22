/**
 * Live check for issues #200/#205: does fork-on-resume branch a *real* conversation?
 *
 * Not part of `npm test` - it launches real ACP adapters and spends account tokens. Run it by hand
 * after `npm run build:test-out`, which emits the CommonJS build it loads from `.test-out`:
 *
 *   node scripts/verify-session-fork.mjs [claude|codex]
 *
 * It seeds a parent conversation with a codeword, then forks it twice - once while the parent is
 * live and idle, once after the parent's adapter has been killed (a dormant conversation) - and
 * judges itself: both children must replay the parent's history and answer the codeword from
 * inherited context alone, and the parent must still accept a turn after being forked.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { testOut } from './test-out.mjs'

const { createAcpSessionManager } = await import(testOut('src/main/acp-session-manager.js'))
const { foldAgentEvent, initialAgentTranscriptState } = await import(testOut('src/shared/agent-transcript.js'))

const provider = process.argv[2] ?? 'claude'
if (provider !== 'claude' && provider !== 'codex') {
  console.error(`Unknown provider '${provider}': pass claude or codex.`)
  process.exit(1)
}

const project = mkdtempSync(join(tmpdir(), 'toucan-fork-project-'))
writeFileSync(join(project, 'README.md'), '# A project to branch conversations in\n')

const CODEWORD = 'ZEBRA-42'
const eventsById = new Map()
const ownerFor = (id) => {
  eventsById.set(id, [])
  return {
    isDestroyed: () => false,
    send: (_channel, envelope) => {
      const event = envelope?.event ?? envelope
      eventsById.get(id).push(event)
      if (event?.type === 'approval') manager.resolveApproval(id, event.approvalId, event.options?.[0]?.optionId)
    }
  }
}

const manager = createAcpSessionManager({ appPath: process.cwd(), environment: process.env })

/**
 * Runs one turn and proves it reached a boundary.
 *
 * `manager.prompt` settles with the *whole turn*, not with the adapter accepting the prompt - so
 * `turn_complete` is already in the log by the time it resolves. Waiting for a boundary *after*
 * awaiting the prompt therefore waits for a second turn that will never be asked for, which is a
 * guaranteed timeout rather than a check. The offset is captured before the prompt for that
 * reason, and the boundary is asserted rather than polled for.
 */
const runTurn = async (id, text) => {
  const events = eventsById.get(id)
  const from = events.length
  const result = await manager.prompt(id, text)
  if (!result?.ok) fail(`prompt on '${id}' was refused: ${result?.message ?? 'no reason given'}`)
  const boundary = events.slice(from).find((event) => event?.type === 'turn_complete' || event?.type === 'turn_failed')
  if (!boundary) fail(`turn on '${id}' settled without a completion boundary`)
  if (boundary.type === 'turn_failed') fail(`turn on '${id}' failed: ${boundary.message ?? 'no reason given'}`)
}

const lastAssistantText = (id) => {
  const snapshot = eventsById
    .get(id)
    .reduce((state, event) => foldAgentEvent(state, event, Date.now()), initialAgentTranscriptState())
  return snapshot.messages.filter((message) => message.role === 'assistant').at(-1)?.text ?? ''
}

const fail = (reason) => {
  console.error(`\nFAIL: ${reason}`)
  manager.killAll()
  process.exit(1)
}

// 1. Seed the parent.
const parent = await manager.create({ id: 'parent', provider, cwd: project }, ownerFor('parent'))
console.log(
  `parent: ${parent.status}${parent.message ? ` - ${parent.message}` : ''} (forkSupport: ${parent.forkSupport})`
)
if (parent.status !== 'ready') fail('parent session did not open')
if (!parent.forkSupport) fail('the adapter did not advertise session.fork')
const parentSessionId = parent.sessionId

await runTurn('parent', `Remember the codeword ${CODEWORD}. Reply with just OK.`)
console.log(`parent seeded, said: ${lastAssistantText('parent')}`)

// 2. Fork the live, idle parent.
const liveChild = await manager.create(
  { id: 'live-child', provider, cwd: project, forkFromSessionId: parentSessionId },
  ownerFor('live-child')
)
console.log(`live child: ${liveChild.status} (session ${liveChild.sessionId})`)
if (liveChild.status !== 'ready') fail(`live fork did not open: ${liveChild.message}`)
if (liveChild.sessionId === parentSessionId) fail('live fork reused the parent session id')
const liveReplayHasHistory = (liveChild.replay ?? []).some(
  (event) => event.type === 'message' && event.text?.includes(CODEWORD)
)
console.log(`live child replayed parent history: ${liveReplayHasHistory}`)
if (!liveReplayHasHistory) fail('live fork replay is missing the parent history')

await runTurn('live-child', 'What is the codeword? Answer with the codeword only.')
const liveAnswer = lastAssistantText('live-child')
console.log(`live child answered: ${liveAnswer}`)
if (!liveAnswer.includes(CODEWORD)) fail('live fork could not answer from inherited context')

// 3. The parent still accepts a turn after being forked.
await runTurn('parent', 'Reply with just OK again.')
const parentAfter = lastAssistantText('parent')
console.log(`parent after fork answered: ${parentAfter}`)
if (!parentAfter) fail('parent refused a turn after being forked')

// 4. Fork the now-dormant parent (its adapter killed, only the transcript on disk remains).
manager.kill('parent')
const dormantChild = await manager.create(
  { id: 'dormant-child', provider, cwd: project, forkFromSessionId: parentSessionId },
  ownerFor('dormant-child')
)
console.log(`dormant child: ${dormantChild.status} (session ${dormantChild.sessionId})`)
if (dormantChild.status !== 'ready') fail(`dormant fork did not open: ${dormantChild.message}`)
const dormantReplayHasHistory = (dormantChild.replay ?? []).some(
  (event) => event.type === 'message' && event.text?.includes(CODEWORD)
)
console.log(`dormant child replayed parent history: ${dormantReplayHasHistory}`)
if (!dormantReplayHasHistory) fail('dormant fork replay is missing the parent history')

await runTurn('dormant-child', 'What is the codeword? Answer with the codeword only.')
const dormantAnswer = lastAssistantText('dormant-child')
console.log(`dormant child answered: ${dormantAnswer}`)
if (!dormantAnswer.includes(CODEWORD)) fail('dormant fork could not answer from inherited context')

manager.killAll()
console.log('\nPASS: both forks replayed the parent history and answered from it; the parent still took a turn.')
process.exit(0)
