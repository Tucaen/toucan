import { fail, match } from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * The cruiser runs as its own JS entry point under the current node binary, never through
 * `node_modules/.bin`: the shim there is a `.cmd` on Windows, and current Node refuses to spawn
 * one without a shell (EINVAL) - which this suite previously mistook for "the fixture reported
 * nothing", failing all thirteen rules with no hint that the tool had never run. Resolving the
 * entry point keeps the launch off any shim and off any shell on every platform.
 */
function dependencyCruiserEntry(): string {
  const root = join(process.cwd(), 'node_modules', 'dependency-cruiser')
  // Read rather than `require.resolve`d: the package does not export its own manifest.
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { bin: Record<string, string> }
  return join(root, manifest.bin.depcruise)
}

const cases = [
  ['no-circular-dependencies', 'cycle/a.ts', 'cycle/b.ts'],
  ['shared-does-not-import-application-layers', 'shared/importer.ts', 'main/dependency.ts'],
  ['shared-has-no-runtime-dependencies', 'shared/imports-react.ts', 'react'],
  ['shared-does-not-import-node-runtime', 'shared/imports-node.ts', 'fs'],
  ['main-does-not-import-preload-or-renderer', 'main/importer.ts', 'preload/dependency.ts'],
  ['preload-does-not-import-main-or-renderer', 'preload/importer.ts', 'renderer/src/dependency.ts'],
  ['preload-only-imports-electron-externally', 'preload/imports-react.ts', 'react'],
  ['renderer-does-not-import-privileged-layers', 'renderer/src/importer.ts', 'main/dependency.ts'],
  ['renderer-does-not-import-node-runtime', 'renderer/src/imports-node.ts', 'fs'],
  ['pure-renderer-features-do-not-import-impure-modules', 'renderer/src/prompt-outbox.ts', 'renderer/src/View.tsx'],
  ['pure-renderer-features-do-not-import-externals', 'renderer/src/prompt-history.ts', 'react'],
  ['file-operation-only-imports-diff', 'renderer/src/file-operation.ts', 'react'],
  ['production-does-not-import-tests', 'main/imports-test.ts', 'tests/helper.ts']
] as const

const cruise = spawnSync(
  process.execPath,
  [dependencyCruiserEntry(), '--config', 'dependency-cruiser.config.mjs', 'tests/fixtures/architecture'],
  { encoding: 'utf8', stdio: 'pipe' }
)
const fixtureOutput = `${cruise.stdout ?? ''}${cruise.stderr ?? ''}`

/**
 * A cruiser that never launched and one that launched and found the fixture clean are two
 * different failures, and only the second is about the rules. This asserts the run produced a
 * cruise report at all - and says why it didn't - so a broken launcher can never again present
 * itself as thirteen broken rules with nothing to go on.
 */
test('the architecture fixture is actually cruised', () => {
  if (cruise.error) fail(`could not run dependency-cruiser: ${cruise.error.message}`)
  if (cruise.status === 0) fail('expected the architecture fixture to violate dependency rules')
  if (!/dependency violations/.test(fixtureOutput)) {
    fail(`dependency-cruiser exited ${cruise.status} without reporting violations:\n${fixtureOutput}`)
  }
})

for (const [rule, importer, dependency] of cases) {
  test(`${rule} reports the offending import path`, () => {
    match(fixtureOutput, new RegExp(rule))
    match(fixtureOutput, new RegExp(importer.replaceAll('.', '\\.')))
    match(fixtureOutput, new RegExp(dependency.replaceAll('.', '\\.')))
  })
}
