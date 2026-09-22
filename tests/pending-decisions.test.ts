import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { decisionIdentity, pendingDecisionsFromMessages } from '../src/renderer/src/pending-decisions'

const claudeDecision = [
  'Task alpha [task=alpha] needs a choice [key=storage]:',
  '- **SQLite**: keep it local',
  '- **Postgres**: share it',
  'Which should I use?'
].join('\n')

// Captured provider shape: Codex emits numbered Markdown choices with bold labels.
const codexDecision = [
  'I need a rollout choice for beta [task=beta] [key=rollout].',
  '1. **Gradual** — release to ten percent',
  '2. **Immediate** — release to everyone',
  'Which approach do you want?'
].join('\n')

function assistant(id: string, text: string): { id: string; role: 'assistant'; text: string } {
  return { id, role: 'assistant', text }
}

test('real Claude bullet and Codex numbered message shapes produce equivalent pins', () => {
  const pins = pendingDecisionsFromMessages([
    assistant('claude-message-id', claudeDecision),
    assistant('codex-item-id', codexDecision)
  ])
  assert.deepEqual(
    pins.map((pin) => [pin.id, pin.options.map((option) => option.label)]),
    [
      ['alpha:storage', ['SQLite: keep it local', 'Postgres: share it']],
      ['beta:rollout', ['Gradual — release to ten percent', 'Immediate — release to everyone']]
    ]
  )
})

test('streamed fragments do not pin until the normalized message becomes complete', () => {
  const partial = { ...assistant('codex-item-id', codexDecision), complete: false }
  assert.deepEqual(pendingDecisionsFromMessages([partial]), [])
  assert.equal(pendingDecisionsFromMessages([{ ...partial, complete: true }]).length, 1)
})

test('decision-shaped progress narration never becomes a pinned final decision', () => {
  assert.deepEqual(
    pendingDecisionsFromMessages([
      {
        ...assistant('progress-question', codexDecision),
        presentation: 'progress',
        complete: true
      }
    ]),
    []
  )
})

test('replayed and repeated open-decision messages dedupe by task and key and update in place', () => {
  const revised = codexDecision.replace('ten percent', 'five percent')
  const pins = pendingDecisionsFromMessages([
    assistant('live', codexDecision),
    assistant('replay', codexDecision),
    assistant('wake-again', revised)
  ])
  assert.equal(pins.length, 1)
  assert.equal(pins[0]?.messageId, 'wake-again')
  assert.match(pins[0]?.text ?? '', /five percent/)
})

test('a repeated stale wake after an accepted answer does not reopen the same decision', () => {
  const id = decisionIdentity(assistant('first', codexDecision))
  assert.deepEqual(
    pendingDecisionsFromMessages([
      assistant('first', codexDecision),
      { id: 'answer', role: 'user', text: 'Gradual', decisionReplyTo: id },
      assistant('stale-wake', codexDecision)
    ]),
    []
  )
})

test('a decision answered in the transcript stays closed when the fold reaches it again', () => {
  const id = decisionIdentity(assistant('first', codexDecision))
  assert.deepEqual(
    pendingDecisionsFromMessages([
      assistant('first', codexDecision),
      { id: 'answer', role: 'user', text: 'Gradual', decisionReplyTo: id },
      assistant('replayed', codexDecision)
    ]),
    []
  )
})

test('same-task keyed pins coexist until one is explicitly superseded', () => {
  const credentials = claudeDecision.replace('[key=storage]', '[key=credentials]')
  assert.deepEqual(
    pendingDecisionsFromMessages([assistant('storage', claudeDecision), assistant('credentials', credentials)]).map(
      (pin) => pin.id
    ),
    ['alpha:storage', 'alpha:credentials']
  )
  const replacement = credentials.replace('[key=credentials]', '[key=credentials] [supersedes=storage]')
  assert.deepEqual(
    pendingDecisionsFromMessages([assistant('storage', claudeDecision), assistant('replacement', replacement)]).map(
      (pin) => pin.id
    ),
    ['alpha:credentials']
  )
})

test('exact replies resolve only their decision while queued and failed sends remain visible', () => {
  const storageId = decisionIdentity(assistant('c', claudeDecision))
  const rolloutId = decisionIdentity(assistant('x', codexDecision))
  const base = [assistant('c', claudeDecision), assistant('x', codexDecision)]
  assert.deepEqual(
    pendingDecisionsFromMessages([
      ...base,
      {
        id: 'reply',
        role: 'user',
        text: 'Gradual',
        decisionReplyTo: rolloutId,
        deliveryPending: true
      }
    ]).map((pin) => [pin.id, pin.state]),
    [
      [storageId, 'actionable'],
      [rolloutId, 'submitting']
    ]
  )
  assert.deepEqual(
    pendingDecisionsFromMessages([
      ...base,
      {
        id: 'reply',
        role: 'user',
        text: 'Gradual',
        decisionReplyTo: rolloutId,
        failed: true
      }
    ]).map((pin) => [pin.id, pin.state]),
    [
      [storageId, 'actionable'],
      [rolloutId, 'actionable']
    ]
  )
  assert.deepEqual(
    pendingDecisionsFromMessages([
      ...base,
      {
        id: 'reply',
        role: 'user',
        text: 'Gradual',
        decisionReplyTo: rolloutId
      }
    ]).map((pin) => pin.id),
    [storageId]
  )
})

test('an ordinary reply that answers no decision preserves every unresolved pin', () => {
  const base = [assistant('c', claudeDecision), assistant('x', codexDecision)]
  assert.deepEqual(
    pendingDecisionsFromMessages([...base, { id: 'replayed-user', role: 'user', text: 'Gradual' }]).map(
      (pin) => pin.id
    ),
    ['alpha:storage', 'beta:rollout']
  )
})

test('normal, noise, thought, and decision-shaped user messages never pin', () => {
  assert.deepEqual(
    pendingDecisionsFromMessages([
      assistant('normal', 'Here is the finished summary.'),
      assistant('noise', 'Spawning worker for task alpha.'),
      { id: 'thought', role: 'thought', text: codexDecision },
      { id: 'user', role: 'user', text: claudeDecision }
    ]),
    []
  )
})

test('provider tabs remain isolated because each transcript is folded independently', () => {
  assert.deepEqual(
    pendingDecisionsFromMessages([assistant('claude', claudeDecision)]).map((pin) => pin.id),
    ['alpha:storage']
  )
  assert.deepEqual(
    pendingDecisionsFromMessages([assistant('codex', codexDecision)]).map((pin) => pin.id),
    ['beta:rollout']
  )
})
