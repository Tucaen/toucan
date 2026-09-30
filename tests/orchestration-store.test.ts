import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { applyPlan, parsePlanInput, type OrchestrationRecord } from '../src/shared/orchestration'
import { createOrchestrationStore, orchestrationFileName } from '../src/main/orchestration-store'

const key = { provider: 'claude' as const, conversationId: 'conversation-1' }

function record(conversationId = key.conversationId): OrchestrationRecord {
  const plan = parsePlanInput({
    task: 'Ship it',
    targetBranch: 'main',
    tickets: [
      { id: '1', title: 'First' },
      { id: '2', title: 'Second', blockedBy: ['1'] }
    ]
  }).plan!
  return applyPlan(undefined, plan, { ...key, conversationId, projectPath: 'D:\\project' }, '2026-09-30T12:00:00.000Z')
    .record!
}

test('a record survives a restart: a second store over the same directory reads it back', async () => {
  const directory = join(mkdtempSync(join(tmpdir(), 'toucan-orchestrations-')), 'orchestrations')
  const first = createOrchestrationStore({ directory })
  assert.equal(await first.read(key), undefined)
  await first.update(key, () => ({ value: record(), result: undefined }))

  const restarted = createOrchestrationStore({ directory })
  assert.deepEqual(await restarted.read(key), record())
  // Another conversation's record is a different file, and absent.
  assert.equal(await restarted.read({ provider: 'claude', conversationId: 'conversation-2' }), undefined)
  assert.deepEqual(readdirSync(directory), ['claude-conversation-1.json'])
})

test('an update that returns the current value writes nothing', async () => {
  const directory = join(mkdtempSync(join(tmpdir(), 'toucan-orchestrations-')), 'orchestrations')
  const store = createOrchestrationStore({ directory })
  const result = await store.update(key, (current) => ({ value: current, result: 'refused' }))
  assert.equal(result, 'refused')
  assert.equal(existsSync(directory), false)
})

test('a file naming another conversation, or a damaged one, reads as no record', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-orchestrations-'))
  writeFileSync(join(directory, orchestrationFileName(key)), JSON.stringify(record('someone-else')))
  assert.equal(await createOrchestrationStore({ directory }).read(key), undefined)
  writeFileSync(join(directory, orchestrationFileName(key)), '{ not json')
  assert.equal(await createOrchestrationStore({ directory }).read(key), undefined)
})

test('file names cannot escape the directory and never collide', () => {
  assert.equal(
    orchestrationFileName({ provider: 'codex', conversationId: '../../etc' }),
    'codex-_2e__2e__2f__2e__2e__2f_etc.json'
  )
  assert.notEqual(
    orchestrationFileName({ provider: 'claude', conversationId: 'a/b' }),
    orchestrationFileName({ provider: 'claude', conversationId: 'a\\b' })
  )
})
