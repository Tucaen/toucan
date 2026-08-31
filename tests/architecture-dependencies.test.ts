import { fail, match } from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'

const dependencyCruiser =
  process.platform === 'win32' ? 'node_modules/.bin/depcruise.cmd' : 'node_modules/.bin/depcruise'

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
  ['pure-renderer-features-do-not-import-impure-modules', 'renderer/src/session-usage.ts', 'renderer/src/View.tsx'],
  ['pure-renderer-features-do-not-import-externals', 'renderer/src/prompt-history.ts', 'react'],
  ['file-operation-only-imports-diff', 'renderer/src/file-operation.ts', 'react'],
  ['production-does-not-import-tests', 'main/imports-test.ts', 'tests/helper.ts']
] as const

let fixtureOutput = ''
try {
  execFileSync(dependencyCruiser, ['--config', 'dependency-cruiser.config.mjs', 'tests/fixtures/architecture'], {
    encoding: 'utf8',
    stdio: 'pipe'
  })
  fail('expected the architecture fixture to violate dependency rules')
} catch (error) {
  fixtureOutput = `${String((error as { stdout?: string }).stdout ?? '')}${String((error as { stderr?: string }).stderr ?? '')}`
}

for (const [rule, importer, dependency] of cases) {
  test(`${rule} reports the offending import path`, () => {
    match(fixtureOutput, new RegExp(rule))
    match(fixtureOutput, new RegExp(importer.replaceAll('.', '\\.')))
    match(fixtureOutput, new RegExp(dependency.replaceAll('.', '\\.')))
  })
}
