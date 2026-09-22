/**
 * Live check for issue #190: does a *real* provider session read the session outcome index without
 * a permission prompt, and answer "what happened here before?" from it alone?
 *
 * Not part of `npm test` - it launches a real ACP adapter and spends account tokens. Run it by hand
 * after `npm run build:test-out`, which emits the CommonJS build it loads from `.test-out`:
 *
 *   node scripts/verify-outcome-retrieval.mjs [claude|codex]
 *
 * It builds a throwaway project and a throwaway outcomes directory holding three records, opens a
 * session the way `src/main/index.ts` does (the outcomes directory as an additional directory, the
 * pointer on the session's own context), asks the retrieval question, and prints every approval the
 * session asked for. The run judges itself: zero approvals plus an answer naming the records passes,
 * anything else exits non-zero.
 *
 * The project path must contain backslashes on Windows (#197): the #190 run's temp path happened to
 * carry none, so it never exercised the shell mangling that made the taught grep silently match
 * nothing. A run whose project path has no backslash on win32 fails up front rather than passing
 * vacuously.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'

import { testOut } from './test-out.mjs'

const { createAcpSessionManager } = await import(testOut('src/main/acp-session-manager.js'))
// The same reducer every host runs, so the printed answer is the transcript's, not a raw chunk.
const { foldAgentEvent, initialAgentTranscriptState } = await import(testOut('src/shared/agent-transcript.js'))

const provider = process.argv[2] === 'codex' ? 'codex' : 'claude'
// Normalized to backslashes on Windows so the records' `project:` lines carry the separators the
// taught pattern exists for - a forward-slashed temp path (Git Bash sets one) would dodge the bug.
const temporaryProject = mkdtempSync(join(tmpdir(), 'toucan-live-project-'))
const project = process.platform === 'win32' ? win32.normalize(temporaryProject) : temporaryProject
if (process.platform === 'win32' && !project.includes('\\')) {
  console.error(`project path carries no backslash, so this run would not exercise #197: ${project}`)
  process.exit(1)
}
const outcomes = mkdtempSync(join(tmpdir(), 'toucan-live-outcomes-'))

const record = (key, title, task, result, files) =>
  [
    '---',
    `key: ${key}`,
    `provider: ${provider}`,
    `conversation: ${key.split('-').slice(1).join('-')}`,
    `project: ${JSON.stringify(project)}`,
    `title: ${title}`,
    'status: completed',
    'turns: 3',
    'started: 2026-09-11T09:00:00.000Z',
    'updated: 2026-09-11T10:00:00.000Z',
    '---',
    '',
    '## Task',
    '',
    task,
    '',
    '## Last result',
    '',
    result,
    '',
    '## Files',
    '',
    ...files.map((file) => `- ${file}`),
    ''
  ].join('\n')

writeFileSync(
  join(outcomes, `${provider}-aaa-0001.md`),
  record(
    `${provider}-aaa-0001`,
    'Retry the upload queue with backoff',
    'Make the upload queue retry failed chunks with exponential backoff.',
    'Added backoff to the queue. Abandoned the worker-thread approach first: the queue shares a single socket, so a second thread only moved the contention.',
    ['src/upload/queue.ts', 'tests/queue.test.ts']
  )
)
writeFileSync(
  join(outcomes, `${provider}-aaa-0002.md`),
  record(
    `${provider}-aaa-0002`,
    'Cache thumbnails on disk',
    'Cache generated thumbnails so a reopened album does not regenerate them.',
    'Wrote the disk cache under userData. Left the eviction policy out deliberately - nothing measures cache size yet.',
    ['src/media/thumbnail-cache.ts']
  )
)
writeFileSync(
  join(outcomes, `${provider}-aaa-0003.md`),
  record(
    `${provider}-aaa-0003`,
    'Move the settings dialog off React context',
    'Replace the settings context with a store so a dialog open does not re-render the canvas.',
    'Reverted: the context was not the cost, the canvas was re-rendering on every pointer move.',
    ['src/settings/SettingsDialog.tsx']
  )
)
writeFileSync(join(project, 'README.md'), '# A project with a history\n')

const events = []
const owner = {
  isDestroyed: () => false,
  send: (_channel, envelope) => {
    const event = envelope?.event ?? envelope
    events.push(event)
    if (event?.type === 'approval') {
      console.log(`\n!! APPROVAL ASKED: ${event.title}`)
      manager.resolveApproval('live', event.approvalId, event.options?.[0]?.optionId)
    }
  }
}

const manager = createAcpSessionManager({
  appPath: process.cwd(),
  environment: process.env,
  sessionOutcomesDirectory: outcomes
})

const created = await manager.create({ id: 'live', provider, cwd: project }, owner)
console.log(`session: ${created.status}${created.message ? ` - ${created.message}` : ''}`)
if (created.status !== 'ready') process.exit(1)

const answer = await manager.prompt('live', 'What did previous sessions in this project do? Be brief.')
console.log(`prompt: ${answer.ok ? 'accepted' : `refused - ${answer.message}`}`)

await new Promise((resolve) => {
  const started = Date.now()
  const poll = setInterval(() => {
    const done = events.some((event) => event.type === 'turn_complete' || event.type === 'turn_failed')
    if (done || Date.now() - started > 180_000) {
      clearInterval(poll)
      resolve()
    }
  }, 500)
})

const approvals = events.filter((event) => event.type === 'approval')
const snapshot = events.reduce(
  (state, event) => foldAgentEvent(state, event, Date.now()),
  initialAgentTranscriptState()
)
const finalAnswer = snapshot.messages.filter((message) => message.role === 'assistant').at(-1)?.text ?? ''
console.log('\n===== ANSWER =====')
console.log(finalAnswer || '(no assistant message)')
console.log('\n===== TOOL CALLS =====')
const seen = new Set()
for (const activity of Object.values(snapshot.activities)) {
  if (activity.title && !seen.has(activity.title)) {
    seen.add(activity.title)
    console.log(`- ${activity.title}`)
  }
}
console.log(`\napprovals asked: ${approvals.length}`)
console.log(`outcomes directory: ${outcomes}`)
console.log(`project: ${project}`)
manager.killAll()
// The run judges itself, so a regression in the taught pattern fails it instead of printing an
// answer nobody re-reads: a session that greps wrong finds no records, and an answer naming fewer
// than two of the three seeded conversations is that silent failure (two, not three, so a session
// paraphrasing one record does not fail a run that plainly read the index).
const namedTopics = ['backoff', 'thumbnail', 'settings'].filter((topic) => finalAnswer.toLowerCase().includes(topic))
if (approvals.length > 0 || namedTopics.length < 2) {
  console.error(
    `\nFAIL: ${approvals.length} approvals, answer names ${namedTopics.length}/3 seeded records - the index was not read.`
  )
  process.exit(1)
}
console.log('\nPASS: no approvals and the answer names the seeded records.')
process.exit(0)
