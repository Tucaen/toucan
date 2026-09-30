import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'vitest'
import { createOrchestrationConfigStore } from '../src/main/orchestration-config-store'
import { DEFAULT_ORCHESTRATION_CONFIG } from '../src/shared/orchestration-routing'

// The orchestration configuration on disk (#36): one user file in userData and an optional
// override per project, both source of truth - read fresh at every call, so an edit by hand or by
// an agent applies to the next route without a restart.

const fresh = () => {
  const userData = mkdtempSync(join(tmpdir(), 'toucan-orchestration-config-'))
  return { userData, store: createOrchestrationConfigStore({ userDataPath: userData }) }
}

test('with no files the defaults apply, and the user file is written out so it can be found and edited', async () => {
  const { store } = fresh()
  const loaded = await store.load('D:\\project')
  assert.deepEqual(loaded.config, DEFAULT_ORCHESTRATION_CONFIG)
  assert.equal(loaded.projectPath, undefined)
  const written = JSON.parse(readFileSync(loaded.userPath!, 'utf8')) as unknown
  assert.deepEqual(written, DEFAULT_ORCHESTRATION_CONFIG)
})

test('an edited user file applies at the next load', async () => {
  const { store } = fresh()
  const first = await store.load('D:\\project')
  writeFileSync(first.userPath!, JSON.stringify({ tiers: { low: { model: 'sonnet' } } }))
  const second = await store.load('D:\\project')
  assert.deepEqual(second.config.tiers.low, { model: 'sonnet' })
  assert.deepEqual(second.config.tiers.high, DEFAULT_ORCHESTRATION_CONFIG.tiers.high)
})

test('a project override applies to its own project only', async () => {
  const { store } = fresh()
  const overridePath = store.projectConfigPath('D:\\Project')
  mkdirSync(dirname(overridePath), { recursive: true })
  writeFileSync(overridePath, JSON.stringify({ implementationSkill: '/tdd', tiers: { high: { model: 'sonnet' } } }))
  // Path identity: case and separators do not make it another project.
  const own = await store.load('d:/project')
  assert.equal(own.config.implementationSkill, '/tdd')
  assert.deepEqual(own.config.tiers.high, { model: 'sonnet' })
  assert.equal(own.projectPath, overridePath)
  const other = await store.load('D:\\other')
  assert.equal(other.config.implementationSkill, '/implement')
  assert.equal(other.projectPath, undefined)
})

test('an override file is named after the project folder, so a reader can find it', () => {
  const { store } = fresh()
  const path = store.projectConfigPath('D:\\Development\\Toucan')
  assert.match(path, /[\\/]orchestration-config[\\/]toucan--[0-9a-f]{8}\.json$/)
  assert.notEqual(path, store.projectConfigPath('E:\\Toucan'))
})

test('a damaged or invalid file is refused with its path, never silently replaced by the defaults', async () => {
  const { store } = fresh()
  const first = await store.load('D:\\project')
  writeFileSync(first.userPath!, '{ not json')
  const broken = await store.load('D:\\project')
  assert.equal(broken.config, undefined)
  assert.match(broken.error!, /not valid JSON/)
  assert.ok(broken.error!.includes(first.userPath!))
  assert.equal(readFileSync(first.userPath!, 'utf8'), '{ not json')

  writeFileSync(first.userPath!, JSON.stringify({ tiers: { easy: { model: 'haiku' } } }))
  const invalid = await store.load('D:\\project')
  assert.match(invalid.error!, /unknown tier "easy"/)
})
