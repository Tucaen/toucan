import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import {
  DEFAULT_SESSION_MESSAGING_SETTINGS,
  deliveryVerdict,
  latestTurnAnswer,
  parseSessionMessageFile,
  parseSessionMessagingSettings,
  queuedNote,
  sessionMessagingInstruction
} from '../src/shared/session-messaging'

// #2: the shared vocabulary - settings, the delivery verdict, what an implicit reply reads from
// the transcript, and what the persisted file keeps.

test('settings default to a hop limit of 3 and 5 asks per turn, and a bad value refuses the file', () => {
  assert.deepEqual(DEFAULT_SESSION_MESSAGING_SETTINGS, { hopLimit: 3, asksPerTurn: 5 })
  assert.deepEqual(parseSessionMessagingSettings({}), { hopLimit: 3, asksPerTurn: 5 })
  assert.deepEqual(parseSessionMessagingSettings({ asksPerTurn: 2 }), { hopLimit: 3, asksPerTurn: 2 })
  for (const bad of [0, 51, 2.5, '3', null]) assert.equal(parseSessionMessagingSettings({ hopLimit: bad }), null)
  assert.equal(parseSessionMessagingSettings([]), null)
})

test('only an idle session takes a message; everything else names why it waits', () => {
  assert.deepEqual(deliveryVerdict({ status: 'ready', waitingOnHuman: false }), { deliver: true })
  assert.deepEqual(deliveryVerdict({ status: 'working', waitingOnHuman: false }), { deliver: false, reason: 'busy' })
  assert.deepEqual(deliveryVerdict({ status: 'working', waitingOnHuman: true }), {
    deliver: false,
    reason: 'waiting_on_human'
  })
  assert.deepEqual(deliveryVerdict({ status: 'auth_required', waitingOnHuman: false }), {
    deliver: false,
    reason: 'waiting_on_human'
  })
  assert.deepEqual(deliveryVerdict({ status: 'starting', waitingOnHuman: false }), {
    deliver: false,
    reason: 'starting'
  })
  assert.deepEqual(deliveryVerdict({ status: 'exited', waitingOnHuman: false }), {
    deliver: false,
    reason: 'not_running'
  })
  assert.deepEqual(deliveryVerdict(undefined), { deliver: false, reason: 'not_running' })
  assert.equal(queuedNote('waiting_on_human'), 'queued: target waiting on human')
})

test("a turn's answer is its last final message after the latest ask, never progress or an older turn's", () => {
  const message = (role: 'user' | 'assistant', text: string, presentation?: 'progress') => ({
    id: text,
    role,
    text,
    ...(presentation ? { presentation } : {})
  })
  assert.equal(
    latestTurnAnswer({
      messages: [message('user', 'q'), message('assistant', 'first'), message('assistant', 'final')]
    } as never),
    'final'
  )
  assert.equal(
    latestTurnAnswer({ messages: [message('user', 'q'), message('assistant', 'thinking', 'progress')] } as never),
    undefined
  )
  assert.equal(
    latestTurnAnswer({ messages: [message('assistant', 'old answer'), message('user', 'new ask')] } as never),
    undefined
  )
})

test('the persisted file keeps every well-formed message and drops the rest', () => {
  const ask = {
    id: 'm-1',
    kind: 'ask',
    from: 'a',
    to: 'b',
    fromTitle: 'A',
    toTitle: 'B',
    text: 'q',
    depth: 1,
    createdAt: '2026-10-25T12:00:00.000Z',
    delivery: 'queued',
    queuedBecause: 'busy'
  }
  const parsed = parseSessionMessageFile({
    version: 1,
    messages: [
      ask,
      { ...ask, id: 'm-2', depth: 0 },
      { ...ask, id: 'm-3', kind: 'reply' },
      { ...ask, delivery: 'dropped' }
    ]
  })
  assert.deepEqual(
    parsed?.messages.map((message) => message.id),
    ['m-1']
  )
  assert.equal(parseSessionMessageFile({ version: 2, messages: [] }), null)
})

test('the instruction teaches list, ask and reply, and puts records and git first for past facts', () => {
  const text = sessionMessagingInstruction('C:\\toucan\\.agents\\skills\\session-messaging\\scripts\\message.mjs')
  assert.match(text, /message\.mjs" list/)
  assert.match(text, /ask --to <shortId> --text <question>/)
  assert.match(text, /reply --id <messageId> --text <answer>/)
  assert.match(text, /Prefer session-records and git for past facts/)
  assert.match(text, /intent, plans and live state/)
  assert.match(text, /never wait or poll/)
  assert.match(text, /implicit reply/)
})
