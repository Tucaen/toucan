import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createOrchestrationConfigStore } from '../src/main/orchestration-config-store'
import { registerOrchestrationSettingsIpc } from '../src/main/orchestration-settings-ipc'
import type { OrchestrationSettingsState } from '../src/shared/orchestration-settings'

// The settings panel's IPC (#39/#45): the two files plus each provider's own model and effort
// catalogue, and a save that only accepts a scope main knows and a file the store validates.

const setup = () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const store = createOrchestrationConfigStore({
    userDataPath: mkdtempSync(join(tmpdir(), 'toucan-orchestration-settings-'))
  })
  registerOrchestrationSettingsIpc(
    { handle: (channel, listener) => void handlers.set(channel, listener as (...args: unknown[]) => unknown) },
    {
      store,
      models: (provider) =>
        provider === 'claude'
          ? [
              { id: 'haiku', name: 'Haiku 4.5' },
              { id: 'opus', name: 'Opus 5.5' }
            ]
          : [{ id: 'gpt-5.6', name: 'GPT-5.6' }],
      efforts: (provider, model) =>
        provider === 'claude' && model === 'opus'
          ? ['low', 'high', 'max']
          : provider === 'codex'
            ? ['medium', 'high']
            : undefined
    }
  )
  const call = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)!({}, ...args) as Promise<OrchestrationSettingsState>
  return { store, call }
}

test('state carries both files and separate provider model and effort catalogues', async () => {
  const { store, call } = setup()
  const state = await call('orchestration-settings:state', 'D:\\project')
  assert.equal(state.user.exists, false)
  assert.equal(state.project?.path, store.projectConfigPath('D:\\project'))
  assert.deepEqual(
    state.catalogues.claude.models.map((model) => model.id),
    ['haiku', 'opus']
  )
  assert.deepEqual(state.catalogues.claude.efforts, { opus: ['low', 'high', 'max'] })
  assert.deepEqual(
    state.catalogues.codex.models.map((model) => model.id),
    ['gpt-5.6']
  )
  assert.deepEqual(state.catalogues.codex.efforts, { 'gpt-5.6': ['medium', 'high'] })
  assert.equal((await call('orchestration-settings:state')).project, undefined)
})

test('save writes the chosen file and answers with the new state', async () => {
  const { call } = setup()
  const saved = await call('orchestration-settings:save', {
    scope: 'project',
    projectPath: 'D:\\project',
    file: { codex: { tiers: { high: { model: 'gpt-5.6' } } } }
  })
  assert.deepEqual(saved.project?.file, { codex: { tiers: { high: { model: 'gpt-5.6' } } } })
  assert.equal(saved.user.exists, false)
})

test('save refuses what main does not know', async () => {
  const { call } = setup()
  await assert.rejects(async () => call('orchestration-settings:save', { scope: 'global', file: {} }), /scope/)
  await assert.rejects(async () => call('orchestration-settings:save', { scope: 'user', file: 'x' }), /object/)
  await assert.rejects(async () => call('orchestration-settings:save', { scope: 'project', file: {} }), /project/)
  await assert.rejects(async () => call('orchestration-settings:state', 42), /project path/)
})
