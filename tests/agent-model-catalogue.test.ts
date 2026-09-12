import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, test } from 'node:test'
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

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'toucan-model-catalogue-')), 'agent-models.json')
}

/** The store writes behind a promise it does not hand back; this waits for the file to appear. */
async function settled(path: string): Promise<unknown> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as unknown
    } catch {
      await delay(10)
    }
  }
  throw new Error(`nothing was written to ${path}`)
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
    assert.deepEqual(await settled(path), { claude: CLAUDE })

    // The whole reason this is on disk: a phone asks a desktop that has restarted since.
    const reopened = createAgentModelCatalogueStore({ path })
    await delay(20)
    assert.deepEqual(reopened.read(), { claude: CLAUDE })
  })

  test('a session that advertised nothing is not evidence the provider offers nothing', async () => {
    const path = storePath()
    const store = createAgentModelCatalogueStore({ path })
    store.record('claude', CLAUDE)
    await settled(path)
    store.record('claude', [])
    await delay(20)
    assert.deepEqual(store.read(), { claude: CLAUDE })
  })

  test('one provider advertising does not disturb the other', async () => {
    const path = storePath()
    const store = createAgentModelCatalogueStore({ path })
    store.record('claude', CLAUDE)
    store.record('codex', [{ id: 'gpt-5-codex', name: 'GPT-5 Codex' }])
    await delay(20)
    assert.deepEqual(store.read(), { claude: CLAUDE, codex: [{ id: 'gpt-5-codex', name: 'GPT-5 Codex' }] })
  })

  test('a record that lands before the first disk read is the newer one and wins', async () => {
    const path = storePath()
    createAgentModelCatalogueStore({ path }).record('claude', [{ id: 'old', name: 'Old' }])
    await settled(path)

    // A fresh store is constructed and written to in the same tick, before its own load resolves.
    const store = createAgentModelCatalogueStore({ path })
    store.record('claude', CLAUDE)
    await delay(20)
    assert.deepEqual(store.read(), { claude: CLAUDE })
  })
})
