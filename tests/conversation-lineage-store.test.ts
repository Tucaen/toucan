import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createConversationLineageStore } from '../src/main/conversation-lineage-store'

test('a recorded fork parent survives reopening the store, per provider', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-lineage-'))
  try {
    const store = createConversationLineageStore(join(directory, 'lineage.json'))
    assert.equal(await store.forkedFrom('claude', 'child'), null)
    await store.setForkedFrom('claude', 'child', 'parent')

    const reopened = createConversationLineageStore(join(directory, 'lineage.json'))
    assert.equal(await reopened.forkedFrom('claude', 'child'), 'parent')
    assert.equal(await reopened.forkedFrom('codex', 'child'), null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a conversation never records itself as its own parent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-lineage-'))
  try {
    const store = createConversationLineageStore(join(directory, 'lineage.json'))
    await store.setForkedFrom('codex', 'same', 'same')
    assert.equal(await store.forkedFrom('codex', 'same'), null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
