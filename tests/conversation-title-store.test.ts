import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createConversationTitleStore } from '../src/main/conversation-title-store'

test('generated titles are stable and a manual rename wins permanently', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-titles-'))
  try {
    const store = createConversationTitleStore(join(directory, 'titles.json'))

    assert.deepEqual(await store.set('codex', 'session-1', 'Repair workspace recovery', 'generated'), {
      title: 'Repair workspace recovery',
      source: 'generated'
    })
    assert.deepEqual(await store.set('codex', 'session-1', 'A later generated guess', 'generated'), {
      title: 'Repair workspace recovery',
      source: 'generated'
    })
    assert.deepEqual(await store.set('codex', 'session-1', 'Crash-safe workspace saves', 'manual'), {
      title: 'Crash-safe workspace saves',
      source: 'manual'
    })
    assert.deepEqual(await store.set('codex', 'session-1', 'Generated churn', 'generated'), {
      title: 'Crash-safe workspace saves',
      source: 'manual'
    })
    assert.deepEqual(await store.set('codex', 'session-1', 'Workspace recovery metadata', 'manual'), {
      title: 'Workspace recovery metadata',
      source: 'manual'
    })

    const reopened = createConversationTitleStore(join(directory, 'titles.json'))
    assert.deepEqual(await reopened.get('codex', 'session-1'), {
      title: 'Workspace recovery metadata',
      source: 'manual'
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects blank titles and normalizes surrounding whitespace', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ade-titles-'))
  try {
    const store = createConversationTitleStore(join(directory, 'titles.json'))
    assert.equal(await store.set('claude', 'session-1', '   ', 'manual'), null)
    assert.deepEqual(await store.set('claude', 'session-1', '  Parser   recovery  ', 'manual'), {
      title: 'Parser recovery',
      source: 'manual'
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
