import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { WebContents } from 'electron'
import { createAcpSessionManager, deliverSteeredPrompt } from '../src/main/acp-session-manager'
import type { AgentEvent } from '../src/shared/agent'
import { AGENT_CHANNELS } from '../src/shared/ipc-channels'
import { installScriptedAdapter } from './helpers/scripted-adapter'

function owner(events: AgentEvent[]): WebContents {
  return {
    isDestroyed: () => false,
    send: (channel: string, payload: { event: AgentEvent }) => {
      if (channel === AGENT_CHANNELS.event) events.push(payload.event)
    }
  } as unknown as WebContents
}

test('queued captain input is injected once into a working turn through ACP steering', async () => {
  const requests: Array<{ method: string; sessionId: string; text: string }> = []
  const result = await deliverSteeredPrompt(
    async (method, params) => {
      requests.push({
        method,
        sessionId: params.sessionId,
        text: params.prompt[0]?.type === 'text' ? params.prompt[0].text : ''
      })
      return { outcome: 'injected' }
    },
    'session-1',
    'second independent idea'
  )

  assert.deepEqual(result, { outcome: 'injected' })
  assert.deepEqual(
    requests,
    [
      {
        method: '_session/steering',
        sessionId: 'session-1',
        text: 'second independent idea'
      }
    ],
    'one accepted submission must produce exactly one steering request'
  )
})

test('multiple steered messages retain host submission order without duplicate injection', async () => {
  const delivered: string[] = []
  const request = async (_method: string, params: { prompt: Array<{ type: string; text?: string }> }) => {
    delivered.push(params.prompt[0]?.text ?? '')
    return { outcome: 'injected' as const }
  }

  for (const text of ['idea A', 'idea B', 'idea C']) {
    assert.deepEqual(await deliverSteeredPrompt(request, 'session-2', text), { outcome: 'injected' })
  }
  assert.deepEqual(delivered, ['idea A', 'idea B', 'idea C'])
})

test('a terminal steering rejection remains a genuine delivery failure', async () => {
  const result = await deliverSteeredPrompt(async () => ({ outcome: 'failed' }), 'session-3', 'cannot deliver')
  assert.equal(result.outcome, 'refused')
  assert.equal(result.outcome === 'refused' && result.result.ok, false)
  assert.match((result.outcome === 'refused' && result.result.message) || '', /could not accept/i)
})

test('steering opts into the idle behavior that leaves an unqueueable follow-up host-owned', async () => {
  const metas: unknown[] = []
  const result = await deliverSteeredPrompt(
    async (_method, params) => {
      metas.push((params as { _meta?: unknown })._meta)
      return { outcome: 'promptRequired' }
    },
    'session-4',
    'the turn just ended'
  )

  assert.deepEqual(result, { outcome: 'promptRequired' })
  assert.deepEqual(metas, [{ steering: { idleBehavior: 'promptRequired' } }])
})

test('a steering call that started a detached turn is refused rather than reported delivered', async () => {
  // The race: the turn ends between `promptWhenIdle`'s busy check and the steering round trip. An
  // adapter that ignores the `promptRequired` opt-in starts a turn of its own, and that turn has
  // no `session/prompt` response and no terminal notification Toucan can settle on - so reporting
  // `ok` would leave a session showing ready while the agent works, with `beginTurn` free to
  // accept a second concurrent prompt.
  const result = await deliverSteeredPrompt(async () => ({ outcome: 'startedNewTurn' }), 'session-5', 'follow-up')

  assert.equal(result.outcome, 'refused')
  assert.equal(result.outcome === 'refused' && result.result.ok, false)
  assert.match(
    (result.outcome === 'refused' && result.result.message) || '',
    /new turn/i,
    'the wording must tell the user a turn may be running with their message'
  )
})

/**
 * A steering-capable adapter that holds its first turn open and answers `_session/steering` with
 * the outcome the case is about. `endsTurnOnSteering` is what makes the race deterministic: the
 * held turn is settled inside the steering call, so Toucan meets the answer at exactly the moment
 * the turn it was meant for has gone.
 */
function steeringAdapter(
  appPath: string,
  steeringOutcome: 'promptRequired' | 'startedNewTurn',
  endsTurnOnSteering: boolean
): void {
  installScriptedAdapter(appPath, 'claude-agent-acp', {
    meta: { steering: { supported: true } },
    prelude: `let held = null
let heldOnce = false`,
    handleRequest: `
  if (request.method === 'session/new') {
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'live-session' } })
    return
  }
  if (request.method === 'session/prompt') {
    // The first turn is kept open, which is what puts a follow-up on the steering path; every
    // later one answers at once, so a re-run follow-up settles without a second nudge.
    if (!heldOnce) {
      heldOnce = true
      held = request.id
      return
    }
    send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })
    return
  }
  if (request.method === '_session/steering') {
    if (${endsTurnOnSteering} && held !== null) {
      send({ jsonrpc: '2.0', id: held, result: { stopReason: 'end_turn' } })
      held = null
    }
    send({ jsonrpc: '2.0', id: request.id, result: { outcome: '${steeringOutcome}' } })
  }`
  })
}

test('a follow-up the adapter leaves host-owned runs as a turn of its own, with the full lifecycle', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-steering-idle-'))
  steeringAdapter(appPath, 'promptRequired', true)
  const events: AgentEvent[] = []
  const manager = createAcpSessionManager({ appPath })

  try {
    const created = await manager.create({ id: 'steered-node', provider: 'claude', cwd: appPath }, owner(events))
    assert.equal(created.status, 'ready')
    events.length = 0

    // A turn the adapter holds open, so the follow-up below takes the steering path - and the
    // adapter ends it while answering, which is the race the `promptRequired` opt-in exists for.
    assert.equal(manager.startPrompt('steered-node', 'long job').ok, true)
    assert.deepEqual(await manager.promptWhenIdle('steered-node', 'and also this'), { ok: true })

    const followUp = events.filter((event) => event.type === 'message' && event.text === 'and also this')
    assert.equal(followUp.length, 1, 'the re-run follow-up is published exactly once')
    // Its own turn, not a silent continuation of the one that ended: a `working` of its own and a
    // boundary of its own, which is what the outcome indexer and both surfaces read.
    const working = events.filter((event) => event.type === 'status' && event.status === 'working')
    assert.equal(working.length, 2)
    assert.equal(events.filter((event) => event.type === 'turn_complete').length, 2)
  } finally {
    manager.killAll()
  }
})

test('a follow-up the adapter answered with startedNewTurn is refused, leaving no phantom turn', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-steering-detached-'))
  steeringAdapter(appPath, 'startedNewTurn', false)
  const events: AgentEvent[] = []
  const manager = createAcpSessionManager({ appPath })

  try {
    const created = await manager.create({ id: 'detached-node', provider: 'claude', cwd: appPath }, owner(events))
    assert.equal(created.status, 'ready')
    events.length = 0

    assert.equal(manager.startPrompt('detached-node', 'long job').ok, true)
    const refused = await manager.promptWhenIdle('detached-node', 'and also this')

    assert.equal(refused.ok, false)
    assert.match(refused.message ?? '', /new turn/i)
    // Nothing is claimed on the session's behalf: no user message for a prompt Toucan does not
    // own, and no second `working` for a turn it cannot settle.
    assert.equal(events.filter((event) => event.type === 'message' && event.text === 'and also this').length, 0)
    assert.equal(events.filter((event) => event.type === 'status' && event.status === 'working').length, 1)
    // The turn in flight still owns the session, so a concurrent prompt is still refused rather
    // than accepted into a second one - the very thing a bogus `ok` here would have opened.
    const concurrent = await manager.prompt('detached-node', 'second prompt')
    assert.equal(concurrent.ok, false)
    assert.match(concurrent.message ?? '', /busy/i)
  } finally {
    manager.killAll()
  }
})
