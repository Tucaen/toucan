import { strict as assert } from 'node:assert'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createSessionOutcomeStore } from '../src/main/session-outcome-store'
import {
  renderSessionOutcome,
  sessionOutcomeFileName,
  sessionOutcomeKey,
  type SessionOutcomeRecord
} from '../src/shared/session-outcome'

// Tucaen/toucan#18: records are named `<project-slug>--<title-slug>--<shortid>.md` so the reader's
// directory listing already says what every record is about. The store owns the consequences: a
// conversation is *found* by its shortid suffix and confirmed against the frontmatter, a title
// change renames the file, and records from before the scheme are migrated once at startup.

function record(overrides: Partial<SessionOutcomeRecord> = {}): SessionOutcomeRecord {
  const conversationId = overrides.conversationId ?? '69f89ec3-9536-41ce-851e-449d8366de18'
  const provider = overrides.provider ?? 'claude'
  return {
    key: sessionOutcomeKey(provider, conversationId),
    provider,
    conversationId,
    projectPath: 'D:\\Development\\cic.control-box',
    title: 'CICKVP-8801',
    task: 'Fix the offer form.',
    lastResult: 'Fixed it.',
    turns: 3,
    filesTouched: ['src/offer-form.ts'],
    filesOmitted: 0,
    failures: [],
    status: 'active',
    startedAt: '2026-09-25T10:00:00.000Z',
    updatedAt: '2026-09-25T10:30:00.000Z',
    ...overrides
  }
}

function names(directory: string): string[] {
  try {
    return readdirSync(directory).sort()
  } catch {
    return []
  }
}

test('a record is written under its descriptive name and found again by identity (#18)', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-outcome-store-'))
  const store = createSessionOutcomeStore({ directory })
  const written = record()

  await store.write(written, {})

  assert.deepEqual(names(directory), ['cic-control-box--cickvp-8801--69f89ec3.md'])
  assert.deepEqual(await store.read(written), written)
  assert.deepEqual(store.readSync(written), written)
})

test('a rewrite under a changed title renames the file; without naming it stays put (#18)', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-outcome-store-'))
  const store = createSessionOutcomeStore({ directory })
  await store.write(record(), {})

  // A capture names the file, so a changed title slug moves the record - one file before, one after.
  const renamed = record({ title: 'CICKVP-8801: offer form dates' })
  await store.update(renamed, () => renamed, {})
  assert.deepEqual(names(directory), ['cic-control-box--cickvp-8801-offer-form-dates--69f89ec3.md'])

  // Finalizing supplies no naming: a status settles in place rather than moving a worktree
  // session's record under a name computed without its checkout.
  const ended = record({ title: 'CICKVP-8801: offer form dates', status: 'completed' })
  await store.update(ended, () => ended)
  assert.deepEqual(names(directory), ['cic-control-box--cickvp-8801-offer-form-dates--69f89ec3.md'])
  assert.equal((await store.read(ended))?.status, 'completed')
  // The synchronous pass writes back to the found file the same way.
  store.writeSync(record({ title: 'CICKVP-8801: offer form dates', status: 'abandoned' }))
  assert.deepEqual(names(directory), ['cic-control-box--cickvp-8801-offer-form-dates--69f89ec3.md'])
})

test('a filename hit is confirmed against the frontmatter before it is trusted (#18)', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-outcome-store-'))
  const store = createSessionOutcomeStore({ directory })
  // Two conversations whose ids share the first eight characters: same shortid suffix, and the
  // provider/conversation frontmatter is the only thing telling their files apart.
  const first = record({ conversationId: '69f89ec3-aaaa', title: 'First' })
  const second = record({ conversationId: '69f89ec3-bbbb', title: 'Second' })
  await store.write(first, {})
  await store.write(second, {})

  assert.deepEqual(await store.read(first), first)
  assert.deepEqual(await store.read(second), second)
  await store.delete(first)
  assert.equal(await store.read(first), null)
  assert.deepEqual(await store.read(second), second)
})

test('startup migration renames every parseable pre-#18 record, idempotently (#18)', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-outcome-store-'))
  const migrated = record()
  writeFileSync(join(directory, `${migrated.key}.md`), renderSessionOutcome(migrated), 'utf8')
  // An unreadable record is left exactly where it was: it is not worth a name, and pruning drops
  // it first anyway.
  writeFileSync(join(directory, 'claude-scribbles.md'), 'not a record at all', 'utf8')

  const store = createSessionOutcomeStore({ directory })
  assert.deepEqual(await store.read(migrated), migrated)

  assert.deepEqual(names(directory), ['cic-control-box--cickvp-8801--69f89ec3.md', 'claude-scribbles.md'])
  // Idempotent: a second startup over the migrated directory changes nothing.
  const reopened = createSessionOutcomeStore({ directory })
  assert.deepEqual(await reopened.read(migrated), migrated)
  assert.deepEqual(names(directory), ['cic-control-box--cickvp-8801--69f89ec3.md', 'claude-scribbles.md'])
})

test('an interrupted rename heals: the freshest duplicate wins and the write removes the rest (#18)', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-outcome-store-'))
  const stale = record({ title: 'Old title', updatedAt: '2026-09-25T10:00:00.000Z' })
  const fresh = record({ title: 'New title', updatedAt: '2026-09-25T11:00:00.000Z' })
  // A crash between writing the new name and removing the old one leaves both on disk.
  writeFileSync(join(directory, `${sessionOutcomeFileName(stale)}.md`), renderSessionOutcome(stale), 'utf8')
  writeFileSync(join(directory, `${sessionOutcomeFileName(fresh)}.md`), renderSessionOutcome(fresh), 'utf8')
  const store = createSessionOutcomeStore({ directory })

  assert.equal((await store.read(fresh))?.title, 'New title')
  await store.update(fresh, (previous) => {
    assert.equal(previous?.title, 'New title')
    return record({ title: 'New title', turns: 4 })
  }, {})

  assert.deepEqual(names(directory), ['cic-control-box--new-title--69f89ec3.md'])
})
