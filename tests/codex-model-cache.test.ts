import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readCachedCodexModels } from '../src/main/codex-model-cache'

test('reads model choices from the shared Codex cache without requiring a session', () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'ade-codex-models-'))
  writeFileSync(join(codexHome, 'models_cache.json'), JSON.stringify({
    models: [
      { slug: 'gpt-codex-new', display_name: 'GPT Codex New', description: 'Current', visibility: 'list' },
      { slug: 'gpt-codex-old', display_name: 'GPT Codex Old', description: 'Legacy', visibility: 'list' },
      { slug: 'internal-model', display_name: 'Internal', description: 'Hidden', visibility: 'hide' }
    ]
  }), 'utf8')

  assert.deepEqual(readCachedCodexModels(codexHome, 'gpt-codex-old'), {
    currentModelId: 'gpt-codex-old',
    availableModels: [
      { id: 'gpt-codex-new', name: 'GPT Codex New', description: 'Current' },
      { id: 'gpt-codex-old', name: 'GPT Codex Old', description: 'Legacy' }
    ]
  })
})
