/**
 * Live check for issue #200: does fork-on-resume branch a *real* Claude conversation?
 *
 * Not part of `npm test` - it launches real ACP adapters and spends account tokens. Run it by hand
 * after `tsc -p tsconfig.test.json`:
 *
 *   node scripts/verify-session-fork.mjs
 *
 * It seeds a parent conversation with a codeword, then forks it twice - once while the parent is
 * live and idle, once after the parent's adapter has been killed (a dormant conversation) - and
 * judges itself: both children must replay the parent's history and answer the codeword from
 * inherited context alone, and the parent must still accept a turn after being forked.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = (path) => pathToFileURL(join(process.cwd(), '.test-out', path)).href
const { createAcpSessionManager } = await import(out('src/main/acp-session-manager.js'))
const { foldAgentEvent, initialAgentTranscriptState } = await import(out('src/shared/agent-transcript.js'))

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

const waitForTurn = (id) =>
  new Promise((resolveWait, rejectWait) => {
    const started = Date.now()
    const events = eventsById.get(id)
    const from = events.length
    const poll = setInterval(() => {
      const done = events.slice(from).some((event) => event?.type === 'turn_complete' || event?.type === 'turn_failed')
      if (done) {
        clearInterval(poll)
        resolveWait()
      } else if (Date.now() - started > 180_000) {
        // A wedged turn is its own failure; resolving here would misreport it as a wrong answer.
        clearInterval(poll)
        rejectWait(new Error(`turn on '${id}' did not complete within 180s`))
      }
    }, 250)
  })

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
const parent = await manager.create({ id: 'parent', provider: 'claude', cwd: project }, ownerFor('parent'))
console.log(
  `parent: ${parent.status}${parent.message ? ` - ${parent.message}` : ''} (forkSupport: ${parent.forkSupport})`
)
if (parent.status !== 'ready') fail('parent session did not open')
if (!parent.forkSupport) fail('the adapter did not advertise session.fork')
const parentSessionId = parent.sessionId

await manager.prompt('parent', `Remember the codeword ${CODEWORD}. Reply with just OK.`)
await waitForTurn('parent')
console.log(`parent seeded, said: ${lastAssistantText('parent')}`)

// 2. Fork the live, idle parent.
const liveChild = await manager.create(
  { id: 'live-child', provider: 'claude', cwd: project, forkFromSessionId: parentSessionId },
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

await manager.prompt('live-child', 'What is the codeword? Answer with the codeword only.')
await waitForTurn('live-child')
const liveAnswer = lastAssistantText('live-child')
console.log(`live child answered: ${liveAnswer}`)
if (!liveAnswer.includes(CODEWORD)) fail('live fork could not answer from inherited context')

// 3. The parent still accepts a turn after being forked.
await manager.prompt('parent', 'Reply with just OK again.')
await waitForTurn('parent')
const parentAfter = lastAssistantText('parent')
console.log(`parent after fork answered: ${parentAfter}`)
if (!parentAfter) fail('parent refused a turn after being forked')

// 4. Fork the now-dormant parent (its adapter killed, only the transcript on disk remains).
manager.kill('parent')
const dormantChild = await manager.create(
  { id: 'dormant-child', provider: 'claude', cwd: project, forkFromSessionId: parentSessionId },
  ownerFor('dormant-child')
)
console.log(`dormant child: ${dormantChild.status} (session ${dormantChild.sessionId})`)
if (dormantChild.status !== 'ready') fail(`dormant fork did not open: ${dormantChild.message}`)
const dormantReplayHasHistory = (dormantChild.replay ?? []).some(
  (event) => event.type === 'message' && event.text?.includes(CODEWORD)
)
console.log(`dormant child replayed parent history: ${dormantReplayHasHistory}`)
if (!dormantReplayHasHistory) fail('dormant fork replay is missing the parent history')

await manager.prompt('dormant-child', 'What is the codeword? Answer with the codeword only.')
await waitForTurn('dormant-child')
const dormantAnswer = lastAssistantText('dormant-child')
console.log(`dormant child answered: ${dormantAnswer}`)
if (!dormantAnswer.includes(CODEWORD)) fail('dormant fork could not answer from inherited context')

manager.killAll()
console.log('\nPASS: both forks replayed the parent history and answered from it; the parent still took a turn.')
process.exit(0)
