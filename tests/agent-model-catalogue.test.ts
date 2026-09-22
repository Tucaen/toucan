import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, test } from 'vitest'
import { isDeepStrictEqual } from 'node:util'
import { createAgentModelCatalogueStore } from '../src/main/agent-model-catalogue-store'
import {
  catalogueOffers,
  parseAgentModelCatalogue,
  AGENT_MODEL_CATALOGUE_LIMIT
} from '../src/shared/agent-model-catalogue'

/**
 * What a provider was last seen to offer - the only answer there is to "what could this chat run
 * on?" before a session exists, because a model list is advertised by a live ACP session.
 *
 * Two properties carry the design. It is durable, because the surface that needs it (a phone's
 * new-chat form) asks a desktop that may have been restarted since it last ran that provider. And
 * it fails *quietly*: every path here degrades to an empty list, never to a refused spawn, because
 * a spawn with no model named is always valid.
 */

const CLAUDE = [
  { id: 'sonnet', name: 'Sonnet' },
  { id: 'opus', name: 'Opus', description: 'The slow careful one' }
]
const CODEX = [{ id: 'gpt-5-codex', name: 'GPT-5 Codex' }]

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'toucan-model-catalogue-')), 'agent-models.json')
}

/**
 * Polls `read` until it equals `expected`. The store writes and loads behind promises it does not
 * hand back, so there is nothing to await - but waiting for the *value* is a settle condition,
 * where a fixed sleep only decides how often the suite is wrong on a loaded machine.
 */
async function settlesTo(read: () => unknown, expected: unknown): Promise<void> {
  let last: unknown = 'nothing readable yet'
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      last = read()
      if (isDeepStrictEqual(last, expected)) return
    } catch {
      // No file yet, or a write mid-rename; both are answered by looking again.
    }
    await delay(5)
  }
  // Assert rather than throw, so a timeout reports both sides instead of only the deadline.
  assert.deepEqual(last, expected)
}

/**
 * The file is the observable that lags: a `record` updates the in-memory mirror synchronously, so
 * once the read-modify-write has landed on disk the store's own load has resolved too.
 */
function fileSettlesTo(path: string, expected: unknown): Promise<void> {
  return settlesTo(() => JSON.parse(readFileSync(path, 'utf8')) as unknown, expected)
}

describe('reading a catalogue', () => {
  test('keeps the providers it understands and drops entries it does not', () => {
    assert.deepEqual(
      parseAgentModelCatalogue({
        claude: [{ id: 'sonnet', name: 'Sonnet' }, { id: '', name: 'Nameless' }, { name: 'No id' }, 7],
        codex: 'not a list',
        gemini: [{ id: 'flash', name: 'Flash' }]
      }),
      // One damaged entry costs one model, never the provider and never the file; an unknown
      // provider is simply not one this app can spawn.
      { claude: [{ id: 'sonnet', name: 'Sonnet' }] }
    )
  })

  test('a provider that lists nothing usable is absent rather than empty', () => {
    assert.deepEqual(parseAgentModelCatalogue({ claude: [] }), {})
    assert.deepEqual(parseAgentModelCatalogue({}), {})
  })

  test('anything that is not an object at all is unreadable', () => {
    assert.equal(parseAgentModelCatalogue(null), null)
    assert.equal(parseAgentModelCatalogue([]), null)
    assert.equal(parseAgentModelCatalogue('claude'), null)
  })

  test('an absurd list is bounded rather than trusted', () => {
    const many = Array.from({ length: AGENT_MODEL_CATALOGUE_LIMIT + 20 }, (_, index) => ({
      id: `m${index}`,
      name: `Model ${index}`
    }))
    assert.equal(parseAgentModelCatalogue({ claude: many })?.claude?.length, AGENT_MODEL_CATALOGUE_LIMIT)
  })

  test('offering is per provider, and an unknown provider offers nothing', () => {
    const catalogue = { claude: CLAUDE }
    assert.equal(catalogueOffers(catalogue, 'claude', 'opus'), true)
    assert.equal(catalogueOffers(catalogue, 'claude', 'gpt-5'), false)
    // The two providers share no ids, which is why a spawn's model is checked against its own kind.
    assert.equal(catalogueOffers(catalogue, 'codex', 'opus'), false)
  })
})

describe('remembering what a session advertised', () => {
  test('what one session advertised outlives it, and outlives the process', async () => {
    const path = storePath()
    createAgentModelCatalogueStore({ path }).record('claude', CLAUDE)
    await fileSettlesTo(path, { claude: CLAUDE })

    // The whole reason this is on disk: a phone asks a desktop that has restarted since. Here the
    // mirror is what lags - a reopened store has no write of its own to wait for.
    const reopened = createAgentModelCatalogueStore({ path })
    await settlesTo(() => reopened.read(), { claude: CLAUDE })
  })

  test('a session that advertised nothing is not evidence the provider offers nothing', async () => {
    const path = storePath()
    const store = createAgentModelCatalogueStore({ path })
    store.record('claude', CLAUDE)
    await fileSettlesTo(path, { claude: CLAUDE })

    // An empty list is dropped where it arrives, so the mirror is right on the next line already.
    store.record('claude', [])
    assert.deepEqual(store.read(), { claude: CLAUDE })
    // Nothing can be awaited for a write that must never happen, so a later record is the barrier:
    // once codex is on disk, anything the empty list might have written would have landed first.
    store.record('codex', CODEX)
    await fileSettlesTo(path, { claude: CLAUDE, codex: CODEX })
  })

  test('one provider advertising does not disturb the other', async () => {
    const path = storePath()
    const store = createAgentModelCatalogueStore({ path })
    store.record('claude', CLAUDE)
    store.record('codex', CODEX)

    assert.deepEqual(store.read(), { claude: CLAUDE, codex: CODEX })
    await fileSettlesTo(path, { claude: CLAUDE, codex: CODEX })
  })

  test('a record that lands before the first disk read keeps the other provider on disk', async () => {
    // The mirror `read` answers from is empty until the first load resolves, so writing it whole
    // in that window would publish a file holding only the provider just recorded - the other
    // one's list gone from disk until something happened to re-record it. The write is a
    // read-modify-write against the file for that reason.
    const path = storePath()
    const seeded = createAgentModelCatalogueStore({ path })
    seeded.record('codex', CODEX)
    await fileSettlesTo(path, { codex: CODEX })

    const store = createAgentModelCatalogueStore({ path })
    store.record('claude', CLAUDE)
    await fileSettlesTo(path, { codex: CODEX, claude: CLAUDE })
    assert.deepEqual(store.read(), { codex: CODEX, claude: CLAUDE })
  })

  test('a record that lands before the first disk read is the newer one and wins', async () => {
    const path = storePath()
    createAgentModelCatalogueStore({ path }).record('claude', [{ id: 'old', name: 'Old' }])
    await fileSettlesTo(path, { claude: [{ id: 'old', name: 'Old' }] })

    // A fresh store is constructed and written to in the same tick, before its own load resolves.
    // The file reaching the new list is what proves that load has since resolved and lost.
    const store = createAgentModelCatalogueStore({ path })
    store.record('claude', CLAUDE)
    await fileSettlesTo(path, { claude: CLAUDE })
    assert.deepEqual(store.read(), { claude: CLAUDE })
  })
})
