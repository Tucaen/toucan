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
  const loaded = await store.load('claude', 'D:\\project')
  assert.deepEqual(loaded.config, DEFAULT_ORCHESTRATION_CONFIG)
  assert.equal(loaded.projectPath, undefined)
  const written = JSON.parse(readFileSync(loaded.userPath!, 'utf8')) as unknown
  assert.deepEqual(written, { claude: DEFAULT_ORCHESTRATION_CONFIG })
})

test('an edited user file applies at the next load', async () => {
  const { store } = fresh()
  const first = await store.load('claude', 'D:\\project')
  writeFileSync(first.userPath!, JSON.stringify({ tiers: { low: { model: 'sonnet' } } }))
  const second = await store.load('claude', 'D:\\project')
  assert.deepEqual(second.config!.tiers.low, { model: 'sonnet' })
  assert.deepEqual(second.config!.tiers.high, DEFAULT_ORCHESTRATION_CONFIG.tiers.high)
})

test('a project override applies to its own project only', async () => {
  const { store } = fresh()
  const overridePath = store.projectConfigPath('D:\\Project')
  mkdirSync(dirname(overridePath), { recursive: true })
  writeFileSync(overridePath, JSON.stringify({ implementationSkill: '/tdd', tiers: { high: { model: 'sonnet' } } }))
  // Path identity: case and separators do not make it another project.
  const own = await store.load('claude', 'd:/project')
  assert.equal(own.config!.implementationSkill, '/tdd')
  assert.deepEqual(own.config!.tiers.high, { model: 'sonnet' })
  assert.equal(own.projectPath, overridePath)
  const other = await store.load('claude', 'D:\\other')
  assert.equal(other.config!.implementationSkill, '/implement')
  assert.equal(other.projectPath, undefined)
})

test('Codex refuses a missing or incomplete mapping and combines only Codex user and project entries', async () => {
  const { store } = fresh()
  const missing = await store.load('codex', 'D:\\project')
  assert.equal(missing.config, undefined)
  assert.match(missing.error!, /codex.*missing low, medium, high, frontier.*Orchestration settings/i)

  await store.write('user', undefined, {
    claude: { tiers: { low: { model: 'haiku' } } },
    codex: {
      tiers: {
        low: { model: 'gpt-low' },
        medium: { model: 'gpt-medium' },
        high: { model: 'gpt-high' }
      },
      implementationSkill: '/codex-implement'
    }
  })
  const incomplete = await store.load('codex', 'D:\\project')
  assert.match(incomplete.error!, /missing frontier/)

  await store.write('project', 'D:\\project', {
    codex: { tiers: { frontier: { model: 'gpt-frontier', effort: 'high' } } }
  })
  const loaded = await store.load('codex', 'D:\\project')
  assert.equal(loaded.config!.tiers.low.model, 'gpt-low')
  assert.deepEqual(loaded.config!.tiers.frontier, { model: 'gpt-frontier', effort: 'high' })
  assert.equal(loaded.config!.implementationSkill, '/codex-implement')
})

test('an override file is named after the project folder, so a reader can find it', () => {
  const { store } = fresh()
  const path = store.projectConfigPath('D:\\Development\\Toucan')
  assert.match(path, /[\\/]orchestration-config[\\/]toucan--[0-9a-f]{8}\.json$/)
  assert.notEqual(path, store.projectConfigPath('E:\\Toucan'))
})

test('a damaged or invalid file is refused with its path, never silently replaced by the defaults', async () => {
  const { store } = fresh()
  const first = await store.load('claude', 'D:\\project')
  writeFileSync(first.userPath!, '{ not json')
  const broken = await store.load('claude', 'D:\\project')
  assert.equal(broken.config, undefined)
  assert.match(broken.error!, /not valid JSON/)
  assert.ok(broken.error!.includes(first.userPath!))
  assert.equal(readFileSync(first.userPath!, 'utf8'), '{ not json')

  writeFileSync(first.userPath!, JSON.stringify({ tiers: { easy: { model: 'haiku' } } }))
  const invalid = await store.load('claude', 'D:\\project')
  assert.match(invalid.error!, /unknown tier "easy"/)
})

// The settings panel (#39) reads each file on its own, writes one back whole, and follows edits
// another process makes to either.

test('inspect reports each file on its own: absent, parsed or unusable', async () => {
  const { store } = fresh()
  const absent = await store.inspect('project', 'D:\\project')
  assert.deepEqual(absent, { path: store.projectConfigPath('D:\\project'), exists: false })
  const overridePath = store.projectConfigPath('D:\\project')
  mkdirSync(dirname(overridePath), { recursive: true })
  writeFileSync(overridePath, JSON.stringify({ implementationSkill: '/tdd' }))
  assert.deepEqual(await store.inspect('project', 'D:\\project'), {
    path: overridePath,
    exists: true,
    file: { claude: { implementationSkill: '/tdd' } }
  })
  writeFileSync(overridePath, '{ nope')
  const broken = await store.inspect('project', 'D:\\project')
  assert.equal(broken.exists, true)
  assert.equal(broken.file, undefined)
  assert.match(broken.error!, /not valid JSON/)
})

test('write puts a validated file in place, and the next load routes with it', async () => {
  const { store } = fresh()
  await store.write('project', 'D:\\project', {
    claude: { tiers: { high: { model: 'sonnet', effort: 'high' } } }
  })
  const loaded = await store.load('claude', 'D:\\project')
  assert.deepEqual(loaded.config!.tiers.high, { model: 'sonnet', effort: 'high' })
  await store.write('user', undefined, { claude: { implementationSkill: '/tdd' } })
  assert.equal((await store.load('claude', 'D:\\other')).config!.implementationSkill, '/tdd')
  await assert.rejects(
    store.write('user', undefined, { claude: { tiers: { easy: { model: 'x' } } } } as never),
    /unknown tier/
  )
  await assert.rejects(store.write('project', undefined, {}), /project/)
})

test('write refuses to replace a file that does not parse, so a hand edit in progress is kept', async () => {
  const { store } = fresh()
  const first = await store.load('claude', 'D:\\project')
  writeFileSync(first.userPath!, '{ half written')
  await assert.rejects(store.write('user', undefined, { claude: { implementationSkill: '/tdd' } }), /not valid JSON/)
  assert.equal(readFileSync(first.userPath!, 'utf8'), '{ half written')
})

test('watch reports edits another process makes to the user file and to an override', async () => {
  const { store } = fresh()
  await store.load('claude', 'D:\\project')
  let changes = 0
  const stop = store.watch(() => changes++)
  try {
    const { userPath } = await store.load('claude', 'D:\\project')
    writeFileSync(userPath, JSON.stringify({ implementationSkill: '/tdd' }))
    await waitFor(() => changes > 0)
    const before = changes
    const overridePath = store.projectConfigPath('D:\\project')
    writeFileSync(overridePath, JSON.stringify({ implementationSkill: '/x' }))
    await waitFor(() => changes > before)
  } finally {
    stop()
  }
})

async function waitFor(condition: () => boolean, timeout = 3000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting for a change')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
