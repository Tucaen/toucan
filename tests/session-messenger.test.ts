import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { AgentEvent } from '../src/shared/agent'
import { createDurableJsonStore } from '../src/main/durable-json-store'
import {
  createSessionMessenger,
  type MessagingDirectoryEntry,
  type SessionMessenger
} from '../src/main/session-messenger'
import {
  DEFAULT_SESSION_MESSAGING_SETTINGS,
  parseSessionMessageFile,
  type MessagingSessionState,
  type SessionMessageFile,
  type SessionMessagingEvent,
  type SessionMessagingSettings
} from '../src/shared/session-messaging'

// #2: sibling-session messaging. Delivery states (idle, busy, waiting on human, closed), reply and
// implicit reply, the hop and per-turn limits, reach, and what survives a restart.

const id = (name: string): string => `${name.padEnd(8, '0')}-0000-4000-8000-000000000000`

interface Harness {
  messenger: SessionMessenger
  states: Map<string, MessagingSessionState>
  prompts: Array<{ to: string; text: string }>
  finals: Map<string, string>
  events: SessionMessagingEvent[]
  entries: MessagingDirectoryEntry[]
  file: string
  settings: { value: SessionMessagingSettings }
  ask(from: string, to: string, text?: string): Promise<{ status: number; body: Record<string, unknown> }>
  reply(from: string, messageId: string, text: string): Promise<{ status: number; body: Record<string, unknown> }>
  /** The session ends its turn with `final` as its last message and goes idle. */
  endTurn(node: string, final?: string, event?: AgentEvent): Promise<void>
  emit(node: string, event: AgentEvent): Promise<void>
}

function entry(name: string, extra: Partial<MessagingDirectoryEntry> = {}): MessagingDirectoryEntry {
  return { nodeId: id(name), projectId: 'p1', provider: 'claude', role: 'chat', title: `${name} chat`, ...extra }
}

function harness(
  entries: MessagingDirectoryEntry[],
  reuse?: { file: string; states?: Map<string, MessagingSessionState> }
): Harness {
  const file = reuse?.file ?? join(mkdtempSync(join(tmpdir(), 'toucan-messaging-')), 'session-messages.json')
  const states = reuse?.states ?? new Map<string, MessagingSessionState>()
  const prompts: Harness['prompts'] = []
  const finals = new Map<string, string>()
  const events: SessionMessagingEvent[] = []
  const settings = { value: DEFAULT_SESSION_MESSAGING_SETTINGS }
  let counter = 0
  const messenger = createSessionMessenger({
    store: createDurableJsonStore<SessionMessageFile>({
      path: file,
      parse: parseSessionMessageFile,
      fallback: () => ({ version: 1, messages: [] })
    }),
    settings: async () => settings.value,
    sessions: {
      state: (nodeId) => states.get(nodeId),
      startPrompt: (nodeId, text) => {
        const state = states.get(nodeId)
        if (!state || state.status !== 'ready' || state.waitingOnHuman) {
          return { ok: false, message: 'The agent session is busy.', undelivered: true }
        }
        states.set(nodeId, { status: 'working', waitingOnHuman: false })
        prompts.push({ to: nodeId, text })
        return { ok: true }
      },
      finalText: (nodeId) => finals.get(nodeId)
    },
    directory: {
      entry: async (nodeId) => entries.find((candidate) => candidate.nodeId === nodeId),
      project: async (projectId) => entries.filter((candidate) => candidate.projectId === projectId)
    },
    publish: (event) => events.push(event),
    now: () => '2026-10-25T12:00:00.000Z',
    newId: () => `m-${(counter += 1)}-${Math.random().toString(16).slice(2, 6)}`
  })
  const call = async (from: string, command: 'ask' | 'reply' | 'list', args?: unknown) =>
    (await messenger.execute(id(from), command, args)) as { status: number; body: Record<string, unknown> }
  const emit = async (node: string, event: AgentEvent): Promise<void> => {
    messenger.observe(id(node), event)
    await messenger.idle()
  }
  return {
    messenger,
    states,
    prompts,
    finals,
    events,
    entries,
    file,
    settings,
    ask: (from, to, text = 'what is your plan?') => call(from, 'ask', { to: id(to).slice(0, 8), text }),
    reply: (from, messageId, text) => call(from, 'reply', { id: messageId, text }),
    emit,
    async endTurn(node, final, event = { type: 'turn_complete', stopReason: 'end_turn' }) {
      if (final !== undefined) finals.set(id(node), final)
      await emit(node, event)
      states.set(id(node), { status: 'ready', waitingOnHuman: false })
      await emit(node, { type: 'status', status: 'ready' })
    }
  }
}

const idle: MessagingSessionState = { status: 'ready', waitingOnHuman: false }
const working: MessagingSessionState = { status: 'working', waitingOnHuman: false }

function running(h: Harness, ...names: string[]): void {
  for (const name of names) h.states.set(id(name), idle)
}

/** A session that asks is mid-turn: its CLI call runs inside a turn. */
function asking(h: Harness, name: string): void {
  h.states.set(id(name), working)
}

test('an idle target starts a turn with the question, and the asker is not kept waiting', async () => {
  const h = harness([entry('a'), entry('b')])
  await h.messenger.restore()
  asking(h, 'a')
  running(h, 'b')
  const result = await h.ask('a', 'b', 'which files are you editing?')
  assert.equal(result.status, 200)
  assert.equal(result.body.delivery, 'delivered')
  assert.equal(result.body.note, undefined)
  assert.equal(h.prompts.length, 1)
  assert.equal(h.prompts[0]!.to, id('b'))
  assert.match(
    h.prompts[0]!.text,
    new RegExp(`^\\[Toucan message ${String(result.body.id)} from session a0000000 "a chat"\\]`)
  )
  assert.match(h.prompts[0]!.text, /which files are you editing\?/)
  assert.match(h.prompts[0]!.text, /reply --id /)
})

test('a busy target is never steered: the ask waits for its turn to end', async () => {
  const h = harness([entry('a'), entry('b')])
  await h.messenger.restore()
  asking(h, 'a')
  h.states.set(id('b'), working)
  const result = await h.ask('a', 'b')
  assert.equal(result.body.delivery, 'queued')
  assert.equal(result.body.note, 'queued: target busy; delivered when its turn ends')
  assert.equal(h.prompts.length, 0)
  // Busy events in the meantime deliver nothing.
  await h.emit('b', { type: 'status', status: 'working' })
  assert.equal(h.prompts.length, 0)
  await h.endTurn('b', 'done with my own work')
  assert.equal(h.prompts.length, 1)
  assert.equal(h.prompts[0]!.to, id('b'))
})

test('a target waiting on its human keeps waiting; the asker is told so', async () => {
  const h = harness([entry('a'), entry('b')])
  await h.messenger.restore()
  asking(h, 'a')
  h.states.set(id('b'), { status: 'working', waitingOnHuman: true })
  const result = await h.ask('a', 'b')
  assert.equal(result.body.delivery, 'queued')
  assert.equal(result.body.note, 'queued: target waiting on human')
  // The human answers the prompt: the turn goes on, and the message still waits for its end.
  h.states.set(id('b'), working)
  await h.emit('b', { type: 'approval_resolved', approvalId: 'x' })
  assert.equal(h.prompts.length, 0)
  await h.endTurn('b')
  assert.equal(h.prompts.length, 1)
})

test('a target that is not running is refused and the asker pointed at session-records', async () => {
  const h = harness([entry('a'), entry('b'), entry('c')])
  await h.messenger.restore()
  asking(h, 'a')
  h.states.set(id('c'), { status: 'exited', waitingOnHuman: false })
  for (const target of ['b', 'c']) {
    const result = await h.ask('a', target)
    assert.equal(result.status, 409)
    assert.match(String(result.body.error), /is not running.*use session-records/)
  }
  assert.equal(h.prompts.length, 0)
  assert.deepEqual(await h.messenger.open(), [])
})

test('a reply wakes the asker with the answer, and the turn end adds no implicit one', async () => {
  const h = harness([entry('a'), entry('b')])
  await h.messenger.restore()
  asking(h, 'a')
  running(h, 'b')
  const asked = await h.ask('a', 'b')
  const replied = await h.reply('b', String(asked.body.id), 'I am editing src/main/index.ts')
  assert.equal(replied.status, 200)
  // The asker is still in its own turn: the answer waits for it, and is not steered in either.
  assert.equal(replied.body.delivery, 'queued')
  assert.equal(h.prompts.length, 1)
  await h.endTurn('a')
  assert.equal(h.prompts.length, 2)
  assert.equal(h.prompts[1]!.to, id('a'))
  assert.match(
    h.prompts[1]!.text,
    /^\[Toucan reply to your message m-1-\w+ from session b0000000 "b chat"\]\nI am editing/
  )
  await h.endTurn('b', 'some final words')
  assert.equal(h.prompts.length, 2)
  // Answering twice is refused.
  const again = await h.reply('b', String(asked.body.id), 'again')
  assert.equal(again.status, 404)
  assert.deepEqual(await h.messenger.open(), [])
})

test('only the asked session may reply, and only to a message it was given', async () => {
  const h = harness([entry('a'), entry('b'), entry('c')])
  await h.messenger.restore()
  asking(h, 'a')
  running(h, 'b')
  const asked = await h.ask('a', 'b')
  assert.equal((await h.reply('c', String(asked.body.id), 'me!')).status, 404)
  assert.equal((await h.reply('b', 'm-unknown', 'hm')).status, 404)
})

test('a turn the question started that ends without a reply answers with its final text, marked implicit', async () => {
  const h = harness([entry('a'), entry('b')])
  await h.messenger.restore()
  running(h, 'a', 'b')
  const asked = await h.ask('a', 'b')
  await h.endTurn('b', 'I plan to refactor the store first.')
  assert.equal(h.prompts.length, 2)
  assert.equal(h.prompts[1]!.to, id('a'))
  assert.match(
    h.prompts[1]!.text,
    new RegExp(
      `^\\[Toucan implicit reply to your message ${String(asked.body.id)} from session b0000000 "b chat": its turn ended without a reply`
    )
  )
  assert.match(h.prompts[1]!.text, /I plan to refactor the store first\.$/)
  const answered = h.events.find(
    (event) => event.type === 'message' && event.message.id === asked.body.id && event.message.answered
  )
  assert.ok(answered, 'the canvas hears the ask close')
})

test('a failed question turn with no final text still answers, saying so', async () => {
  const h = harness([entry('a'), entry('b')])
  await h.messenger.restore()
  running(h, 'a', 'b')
  await h.ask('a', 'b')
  await h.endTurn('b', undefined, { type: 'turn_failed', turnId: 't', message: 'overloaded' })
  assert.match(h.prompts[1]!.text, /\(no final message: the turn failed: overloaded\)$/)
})

test('a chain of questions stops at the hop limit, and a reply does not deepen it', async () => {
  const h = harness(['a', 'b', 'c', 'd', 'e'].map((name) => entry(name)))
  await h.messenger.restore()
  running(h, 'a', 'b', 'c', 'd', 'e')
  asking(h, 'a')
  const first = await h.ask('a', 'b')
  assert.equal(first.body.delivery, 'delivered')
  // b's turn was started by a hop-1 question, so b asks at hop 2, and c at hop 3.
  assert.equal((await h.ask('b', 'c')).status, 200)
  assert.equal((await h.ask('c', 'd')).status, 200)
  const tooDeep = await h.ask('d', 'e')
  assert.equal(tooDeep.status, 429)
  assert.match(String(tooDeep.body.error), /hop 4 of a question chain, over the limit of 3/)
  const notice = h.events.find((event) => event.type === 'notice')
  assert.ok(notice && notice.type === 'notice' && notice.nodeId === id('d'))
  assert.match(notice.text, /^Message refused: /)

  // d answers c; the turn that answer wakes in c asks at c's own depth (3), not deeper - and the
  // limit still holds there.
  const toD = h.events.find((event) => event.type === 'message' && event.message.to === id('d'))
  assert.ok(toD?.type === 'message')
  await h.reply('d', toD.message.id, 'answer from d')
  await h.endTurn('d')
  await h.endTurn('c')
  assert.equal(h.prompts.at(-1)!.to, id('c'))
  assert.equal((await h.ask('c', 'e')).status, 200)
})

test('the hop limit is a setting', async () => {
  const h = harness([entry('a'), entry('b'), entry('c')])
  await h.messenger.restore()
  h.settings.value = { hopLimit: 1, asksPerTurn: 5 }
  running(h, 'a', 'b', 'c')
  asking(h, 'a')
  assert.equal((await h.ask('a', 'b')).status, 200)
  assert.equal((await h.ask('b', 'c')).status, 429)
})

test('a session may ask at most asksPerTurn times in one turn; the next turn starts afresh', async () => {
  const h = harness(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => entry(name)))
  await h.messenger.restore()
  running(h, 'b', 'c', 'd', 'e', 'f')
  asking(h, 'a')
  for (const target of ['b', 'c', 'd', 'e', 'f']) assert.equal((await h.ask('a', target)).status, 200, target)
  const sixth = await h.ask('a', 'g')
  assert.equal(sixth.status, 429)
  assert.match(String(sixth.body.error), /already asked 5 times this turn, the limit is 5/)
  assert.ok(h.events.some((event) => event.type === 'notice' && event.nodeId === id('a')))
  await h.endTurn('a')
  asking(h, 'a')
  assert.equal((await h.ask('a', 'g')).status, 409, 'counted afresh: refused only because g is not running')
  // A refused ask is not counted; with the limit set to one, one more goes and the next does not.
  h.settings.value = { hopLimit: 3, asksPerTurn: 1 }
  running(h, 'g')
  assert.equal((await h.ask('a', 'g')).status, 200)
  assert.equal((await h.ask('a', 'b')).status, 429, 'the per-turn limit is a setting')
})

test('reach: only this project, never an orchestrator or itself, though an orchestrator may ask', async () => {
  const h = harness([
    entry('a'),
    entry('b', { projectId: 'p2' }),
    entry('o', { role: 'orchestrator' }),
    entry('t', { role: 'ticket', provider: 'codex', ticketId: '7' })
  ])
  await h.messenger.restore()
  running(h, 'a', 'b', 'o', 't')
  asking(h, 'a')
  const otherProject = await h.ask('a', 'b')
  assert.equal(otherProject.status, 404)
  assert.match(String(otherProject.body.error), /no session b0000000 in this project/)
  assert.equal((await h.ask('a', 'o')).status, 403)
  assert.equal((await h.ask('a', 'a')).status, 400)
  // A ticket session on another provider is a target; an orchestrator may send.
  assert.equal((await h.ask('a', 't')).status, 200)
  asking(h, 'o')
  running(h, 'a')
  assert.equal((await h.ask('o', 'a')).status, 200)
  // A session that is not a chat on the canvas has no siblings.
  const stranger = await h.messenger.execute('capture-session', 'list', undefined)
  assert.equal(stranger.status, 403)
})

test("list shows this project's sibling targets with their state", async () => {
  const h = harness([
    entry('a'),
    entry('b', { branch: 'main', updatedAt: '2026-10-24T08:00:00.000Z' }),
    entry('t', { role: 'ticket', provider: 'codex', ticketId: '7', branch: 'ticket/7' }),
    entry('o', { role: 'orchestrator' }),
    entry('x', { projectId: 'p2' })
  ])
  await h.messenger.restore()
  h.states.set(id('t'), { status: 'working', waitingOnHuman: true })
  running(h, 'a')
  const result = await h.messenger.execute(id('a'), 'list', undefined)
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.self, { shortId: 'a0000000', title: 'a chat' })
  assert.deepEqual(result.body.sessions, [
    {
      shortId: 'b0000000',
      title: 'b chat',
      provider: 'claude',
      role: 'chat',
      branch: 'main',
      state: 'not_running',
      updatedAt: '2026-10-24T08:00:00.000Z'
    },
    {
      shortId: 't0000000',
      title: 't chat',
      provider: 'codex',
      role: 'ticket',
      ticketId: '7',
      branch: 'ticket/7',
      state: 'waiting_on_human'
    }
  ])
})

test('queued messages survive a restart and go out once the target runs again', async () => {
  const entries = [entry('a'), entry('b')]
  const first = harness(entries)
  await first.messenger.restore()
  asking(first, 'a')
  first.states.set(id('b'), working)
  const asked = await first.ask('a', 'b')
  assert.equal(asked.body.delivery, 'queued')
  await first.messenger.idle()

  // Toucan restarts: nothing is running, and the target comes back later.
  const second = harness(entries, { file: first.file })
  await second.messenger.restore()
  const open = await second.messenger.open()
  assert.equal(open.length, 1)
  assert.equal(open[0]!.id, asked.body.id)
  second.states.set(id('b'), { status: 'starting', waitingOnHuman: false })
  await second.emit('b', { type: 'status', status: 'starting' })
  assert.equal(second.prompts.length, 0)
  second.states.set(id('b'), idle)
  await second.emit('b', { type: 'status', status: 'ready' })
  assert.equal(second.prompts.length, 1)
  assert.match(second.prompts[0]!.text, new RegExp(`\\[Toucan message ${String(asked.body.id)} `))
  // Once delivered, the reply route survives too: b answers and a is woken when it runs.
  await second.reply('b', String(asked.body.id), 'after the restart')
  second.states.set(id('a'), idle)
  await second.emit('a', { type: 'status', status: 'ready' })
  assert.match(second.prompts.at(-1)!.text, /after the restart$/)
})

test('a question whose turn a restart cut short is answered "interrupted"', async () => {
  const entries = [entry('a'), entry('b')]
  const first = harness(entries)
  await first.messenger.restore()
  running(first, 'a', 'b')
  await first.ask('a', 'b')
  assert.equal(first.prompts.length, 1)

  const second = harness(entries, { file: first.file })
  await second.messenger.restore()
  second.states.set(id('a'), idle)
  await second.emit('a', { type: 'status', status: 'ready' })
  assert.equal(second.prompts.length, 1)
  assert.match(
    second.prompts[0]!.text,
    /^\[Toucan: no reply to your message m-1-\w+\]\nToucan restarted while session b0000000/
  )
})

test('an asker whose target left the canvas is woken with "target closed; use session-records"', async () => {
  const entries = [entry('a'), entry('b')]
  const first = harness(entries)
  await first.messenger.restore()
  asking(first, 'a')
  first.states.set(id('b'), working)
  await first.ask('a', 'b')
  await first.messenger.idle()

  const second = harness(entries, { file: first.file })
  await second.messenger.restore()
  second.messenger.nodesChanged(new Set([id('a')]))
  await second.messenger.idle()
  assert.deepEqual(
    (await second.messenger.open()).map((message) => [message.kind, message.replyKind]),
    [['reply', 'closed']]
  )
  second.states.set(id('a'), idle)
  await second.emit('a', { type: 'status', status: 'ready' })
  assert.match(second.prompts[0]!.text, /\ntarget closed; use session-records\. Session b0000000 "b chat"/)
})

test('a reply whose asker left the canvas is dropped rather than kept forever', async () => {
  const h = harness([entry('a'), entry('b')])
  await h.messenger.restore()
  asking(h, 'a')
  running(h, 'b')
  const asked = await h.ask('a', 'b')
  await h.reply('b', String(asked.body.id), 'answer')
  h.messenger.nodesChanged(new Set([id('b')]))
  await h.messenger.idle()
  assert.deepEqual(await h.messenger.open(), [])
  assert.ok(h.events.some((event) => event.type === 'message' && event.message.delivery === 'dropped'))
})
