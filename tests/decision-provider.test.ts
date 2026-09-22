import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { claudeConfigRoot } from '../src/main/claude-config'
import { isDecisionProviderInstalled } from '../src/main/decision-provider'
import { DECISION_PROVIDER_PLUGIN_ID } from '../src/shared/decision-delegation'

// Issue #213: the probe reads Claude Code's plugin registry for the constant plugin id. It never
// globs the cache directory, whose path carries a version that changes on every update.

/** The probe reads `process.env` by default; tests pin the environment so a developer's own
 * `CLAUDE_CONFIG_DIR` cannot decide the result. */
function installed(root: string, environment: NodeJS.ProcessEnv = {}, readFile = readFileSync): boolean {
  return isDecisionProviderInstalled(root, readFile, environment)
}

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
  assert.equal(installed(home(registry)), true)
  // The recorded version is deliberately not read: a bump must not turn the provider off.
  const bumped = { version: 2, plugins: { [DECISION_PROVIDER_PLUGIN_ID]: [{ scope: 'user', version: '9.9.9' }] } }
  assert.equal(installed(home(bumped)), true)
})

test('no registry, no entry and an empty entry all read as not installed', () => {
  assert.equal(installed(home()), false)
  assert.equal(installed(home({ version: 2, plugins: {} })), false)
  assert.equal(installed(home({ version: 2, plugins: { [DECISION_PROVIDER_PLUGIN_ID]: [] } })), false)
  assert.equal(installed(home({ version: 2, plugins: { 'someone@else': [{ scope: 'user' }] } })), false)
})

test('an unreadable or malformed registry answers the question rather than throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'toucan-decision-provider-'))
  mkdirSync(join(root, '.claude', 'plugins'), { recursive: true })
  writeFileSync(join(root, '.claude', 'plugins', 'installed_plugins.json'), '{ not json')
  assert.equal(installed(root), false)
  assert.equal(
    installed(root, {}, () => {
      throw new Error('EACCES')
    }),
    false
  )
})

test('a relocated CLAUDE_CONFIG_DIR is where the registry is read from', () => {
  // #221: the cleanup launcher forwards this variable, so the probe that decides whether the same
  // install exists has to resolve the config root the same way rather than assuming `~/.claude`.
  const root = mkdtempSync(join(tmpdir(), 'toucan-claude-config-'))
  const relocated = join(root, 'elsewhere')
  mkdirSync(join(relocated, 'plugins'), { recursive: true })
  writeFileSync(
    join(relocated, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { [DECISION_PROVIDER_PLUGIN_ID]: [{ scope: 'user' }] } })
  )
  assert.equal(installed(root), false)
  assert.equal(installed(root, { CLAUDE_CONFIG_DIR: relocated }), true)
  // A blank or absent value is not a relocation.
  assert.equal(installed(root, { CLAUDE_CONFIG_DIR: '  ' }), false)
})

test('the config root is resolved in one place for every reader of it', () => {
  assert.equal(claudeConfigRoot('/home/a', {}), join('/home/a', '.claude'))
  assert.equal(claudeConfigRoot('/home/a', { CLAUDE_CONFIG_DIR: '' }), join('/home/a', '.claude'))
  assert.equal(claudeConfigRoot('/home/a', { CLAUDE_CONFIG_DIR: ' /elsewhere ' }), '/elsewhere')
})
