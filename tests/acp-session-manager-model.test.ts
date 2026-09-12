import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import type { WebContents } from 'electron'
import { createAcpSessionManager } from '../src/main/acp-session-manager'
import { AGENT_CHANNELS } from '../src/shared/ipc-channels'
import { MODEL_CHANGE_WHILE_BUSY, type AgentEvent } from '../src/shared/agent'
import { installScriptedAdapter } from './helpers/scripted-adapter'

/**
 * What an accepted model change tells every client.
 *
 * Issue #185: the desktop could hide a gap here because it folds its own `local_model_selected`
 * after a successful call, so its picker moved whether or not an event followed. A remote client
 * has no such local fold - it renders the session's `models` state and nothing else - so a change
 * the manager accepted without publishing left the phone showing the model the turn is *not*
 * running on, which is the exact symptom the ticket opened on. Acceptance and publication are
 * therefore one thing now, as they already were for effort.
 */

/**
 * A scripted adapter that advertises two models and answers `session/set_config_option` with
 * `configOptions` only when asked to. Both shapes are real: an adapter may restate its whole
 * selector set after a change, or may simply acknowledge it.
 */
function modelAdapter(appPath: string, restateOptions: boolean): void {
  installScriptedAdapter(appPath, 'claude-agent-acp', {
    prelude: `
const models = [{ value: 'sonnet', name: 'Sonnet' }, { value: 'opus', name: 'Opus' }]
const optionsFor = (current) => [
  { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: current, options: models }
]`,
    handleRequest: `
  if (request.method === 'session/new') {
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'session-1', configOptions: optionsFor('sonnet') } })
  } else if (request.method === 'session/set_config_option') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: ${restateOptions} ? { configOptions: optionsFor(request.params.value) } : {}
    })
  }`
  })
}

/**
 * An adapter whose turn takes a moment to finish, so there is a window in which the session is
 * genuinely busy. The delay is the turn, not a race: acceptance is synchronous, so the assertion
 * that matters runs before this ever fires - the wait only proves the refusal lifts afterwards.
 */
function slowTurnAdapter(appPath: string): void {
  installScriptedAdapter(appPath, 'claude-agent-acp', {
    prelude: `
const configOptions = [{
  id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'sonnet',
  options: [{ value: 'sonnet', name: 'Sonnet' }, { value: 'opus', name: 'Opus' }]
}]`,
    handleRequest: `
  if (request.method === 'session/new') {
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'session-1', configOptions } })
  } else if (request.method === 'session/prompt') {
    setTimeout(() => send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } }), 150)
  } else if (request.method === 'session/set_config_option') {
    send({ jsonrpc: '2.0', id: request.id, result: {} })
  }`
  })
}

/** Every event the manager published to its owning renderer, in order. */
function recordingOwner(events: AgentEvent[]): WebContents {
  return {
    isDestroyed: () => false,
    send: (channel: string, payload: { event: AgentEvent }) => {
      if (channel === AGENT_CHANNELS.event) events.push(payload.event)
    }
  } as unknown as WebContents
}

function modelEvents(events: readonly AgentEvent[]): Extract<AgentEvent, { type: 'models' }>[] {
  return events.filter((event): event is Extract<AgentEvent, { type: 'models' }> => event.type === 'models')
}

for (const restateOptions of [true, false]) {
  const shape = restateOptions ? 'restates its config options' : 'merely acknowledges the change'
  test(`an accepted model change is published as a models event when the adapter ${shape}`, async () => {
    const appPath = mkdtempSync(join(tmpdir(), 'toucan-model-change-'))
    modelAdapter(appPath, restateOptions)
    const events: AgentEvent[] = []
    const manager = createAcpSessionManager({ appPath, environment: { PATH: process.env.PATH } })
    try {
      const created = await manager.create({ id: 'chat', provider: 'claude', cwd: appPath }, recordingOwner(events))
      assert.equal(created.status, 'ready')
      assert.equal(created.models?.currentModelId, 'sonnet')

      assert.deepEqual(await manager.setModel('chat', 'opus'), { ok: true })

      // The point of the test: a client that renders only what the session reported now sees Opus,
      // whichever of the two response shapes the adapter chose.
      const published = modelEvents(events).at(-1)
      assert.equal(published?.models.currentModelId, 'opus')
      // And the advertised list survives an acknowledgement that said nothing about the options.
      assert.deepEqual(
        published?.models.availableModels.map((model) => model.id),
        ['sonnet', 'opus']
      )
    } finally {
      manager.killAll()
    }
  })
}

/**
 * A conversation keeps one model for the whole of a turn, and the refusal lives *here* rather than
 * in each UI's picker, so both surfaces inherit one rule. Two things are wrong with a mid-turn
 * swap: the provider's prompt cache is model-scoped, so the next request re-reads the conversation
 * uncached, and a thinking block is bound to the model that produced it - so the incoming model
 * joins a turn unable to see the reasoning behind the tool calls it is meant to continue from.
 */
test('a model change is refused while a turn is in flight, and available the moment it is not', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-model-busy-'))
  slowTurnAdapter(appPath)
  const manager = createAcpSessionManager({ appPath, environment: { PATH: process.env.PATH } })
  try {
    const created = await manager.create({ id: 'chat', provider: 'claude', cwd: appPath }, recordingOwner([]))
    assert.equal(created.status, 'ready')
    // Idle: perfectly changeable.
    assert.deepEqual(await manager.setModel('chat', 'opus'), { ok: true })

    // `startPrompt` accepts synchronously and leaves the turn running, so the session is busy the
    // instant this returns - no sleep, and nothing racing the adapter.
    assert.equal(manager.startPrompt('chat', 'do the thing').ok, true)
    assert.deepEqual(await manager.setModel('chat', 'sonnet'), { ok: false, message: MODEL_CHANGE_WHILE_BUSY })

    // The turn ends, and with it the refusal: this is a "wait for the boundary", not a ban.
    await turnSettled(manager)
    assert.deepEqual(await manager.setModel('chat', 'sonnet'), { ok: true })
  } finally {
    manager.killAll()
  }
})

/** Polls until the session accepts work again, so the test waits on the turn, not on a duration. */
async function turnSettled(manager: ReturnType<typeof createAcpSessionManager>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await manager.setModel('chat', 'opus')).ok) return
    await delay(20)
  }
  throw new Error('the turn never finished')
}

/**
 * What a session advertises has to outlive the session, because the only surface that needs a model
 * list before a session exists - a phone's new-chat form - has nowhere else to get one.
 */
test('every advertised model list is reported to the catalogue seam', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-model-catalogue-seam-'))
  modelAdapter(appPath, true)
  const advertised: { provider: string; ids: string[] }[] = []
  const manager = createAcpSessionManager({
    appPath,
    environment: { PATH: process.env.PATH },
    onModelsAdvertised: (provider, models) => advertised.push({ provider, ids: models.map((model) => model.id) })
  })
  try {
    await manager.create({ id: 'chat', provider: 'claude', cwd: appPath }, recordingOwner([]))
    // Reported on the way up, before anything has been asked of the session.
    assert.deepEqual(advertised[0], { provider: 'claude', ids: ['sonnet', 'opus'] })

    await manager.setModel('chat', 'opus')
    // And again whenever a change restates them, so a provider that retires one is noticed.
    assert.deepEqual(advertised.at(-1), { provider: 'claude', ids: ['sonnet', 'opus'] })
  } finally {
    manager.killAll()
  }
})
