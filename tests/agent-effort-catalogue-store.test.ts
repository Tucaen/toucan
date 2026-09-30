import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'vitest'
import { createAgentEffortCatalogueStore } from '../src/main/agent-effort-catalogue-store'

// The efforts each model's picker was last seen to offer (#36): what routing settles a tier's effort
// against, before a session on that model exists.

async function settled(path: string, expected: unknown): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if (JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))) === JSON.stringify(expected)) return
    } catch {
      // Not written yet.
    }
    await delay(10)
  }
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), expected)
}

test('each model keeps the efforts it was last seen to offer, per provider', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'toucan-efforts-')), 'agent-model-efforts.json')
  const store = createAgentEffortCatalogueStore({ path })
  assert.equal(store.efforts('claude', 'opus'), undefined)
  store.record('claude', 'opus', ['low', 'medium', 'high', 'xhigh', 'max'])
  store.record('claude', 'haiku', [])
  store.record('claude', 'opus', ['low', 'high'])
  assert.deepEqual(store.efforts('claude', 'opus'), ['low', 'high'])
  assert.deepEqual(store.efforts('claude', 'haiku'), [])
  assert.equal(store.efforts('codex', 'opus'), undefined)
  // The latest recording is the newest entry, which is the end the bound keeps.
  await settled(path, { claude: { haiku: [], opus: ['low', 'high'] } })
})

test('the store keeps at most 64 models per provider, dropping the least recently recorded', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'toucan-efforts-')), 'agent-model-efforts.json')
  const store = createAgentEffortCatalogueStore({ path })
  for (let index = 0; index < 70; index += 1) store.record('claude', `model-${index}`, ['low'])
  assert.equal(store.efforts('claude', 'model-5'), undefined)
  assert.deepEqual(store.efforts('claude', 'model-6'), ['low'])
  assert.deepEqual(store.efforts('claude', 'model-69'), ['low'])
})

test('a restarted store reads what was recorded, and drops damaged entries', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'toucan-efforts-')), 'agent-model-efforts.json')
  writeFileSync(path, JSON.stringify({ claude: { opus: ['low', 'max'], broken: 'high' }, other: { x: [] } }))
  const store = createAgentEffortCatalogueStore({ path })
  await store.ready
  assert.deepEqual(store.efforts('claude', 'opus'), ['low', 'max'])
  assert.equal(store.efforts('claude', 'broken'), undefined)
})
