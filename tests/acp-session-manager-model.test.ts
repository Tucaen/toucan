import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { WebContents } from 'electron'
import { createAcpSessionManager } from '../src/main/acp-session-manager'
import { AGENT_CHANNELS } from '../src/shared/ipc-channels'
import type { AgentEvent } from '../src/shared/agent'
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
