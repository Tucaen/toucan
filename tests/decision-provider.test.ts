import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isDecisionProviderInstalled } from '../src/main/decision-provider'
import { DECISION_PROVIDER_PLUGIN_ID } from '../src/shared/decision-delegation'

// Issue #213: the probe reads Claude Code's plugin registry for the constant plugin id. It never
// globs the cache directory, whose path carries a version that changes on every update.

function home(registry?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'toucan-decision-provider-'))
  if (registry !== undefined) {
    const directory = join(root, '.claude', 'plugins')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'installed_plugins.json'), JSON.stringify(registry))
  }
  return root
}

test('an install recorded under the plugin id makes the provider available', () => {
  const registry = {
    version: 2,
    plugins: { [DECISION_PROVIDER_PLUGIN_ID]: [{ scope: 'user', version: '0.5.7', installPath: 'anything' }] }
  }
  assert.equal(isDecisionProviderInstalled(home(registry)), true)
  // The recorded version is deliberately not read: a bump must not turn the provider off.
  const bumped = { version: 2, plugins: { [DECISION_PROVIDER_PLUGIN_ID]: [{ scope: 'user', version: '9.9.9' }] } }
  assert.equal(isDecisionProviderInstalled(home(bumped)), true)
})

test('no registry, no entry and an empty entry all read as not installed', () => {
  assert.equal(isDecisionProviderInstalled(home()), false)
  assert.equal(isDecisionProviderInstalled(home({ version: 2, plugins: {} })), false)
  assert.equal(isDecisionProviderInstalled(home({ version: 2, plugins: { [DECISION_PROVIDER_PLUGIN_ID]: [] } })), false)
  assert.equal(
    isDecisionProviderInstalled(home({ version: 2, plugins: { 'someone@else': [{ scope: 'user' }] } })),
    false
  )
})

test('an unreadable or malformed registry answers the question rather than throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'toucan-decision-provider-'))
  mkdirSync(join(root, '.claude', 'plugins'), { recursive: true })
  writeFileSync(join(root, '.claude', 'plugins', 'installed_plugins.json'), '{ not json')
  assert.equal(isDecisionProviderInstalled(root), false)
  assert.equal(
    isDecisionProviderInstalled(root, () => {
      throw new Error('EACCES')
    }),
    false
  )
})
