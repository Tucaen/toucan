import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'vitest'

/**
 * `npm run check:quick` is what a session runs before it reports done; CI runs `npm run check`.
 * The quick gate is only worth having while it fails on what CI fails on, so both share one static
 * half and the quick one adds the repo-wide guard tests - the ones no "tests that cover your
 * change" pick would ever select, and the ones that kept turning `main` red after a merge.
 */

const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts
const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8')

const guardFiles = (): string[] => scripts['test:guards'].split(' ').filter((word) => word.startsWith('tests/'))

test('CI runs the full gate, and the full and quick gates share one static half', () => {
  assert.match(ciWorkflow, /run: npm run check\r?\n/)
  assert.equal(scripts.check, 'npm run check:static && npm test')
  assert.equal(scripts['check:quick'], 'npm run check:static && npm run test:guards && npm run test:changed')
})

test('every guard the quick gate names is a node test that exists', () => {
  const guards = guardFiles()
  assert.ok(guards.length > 0)
  assert.deepEqual(
    guards.filter((file) => !existsSync(file) || !file.endsWith('.test.ts')),
    [],
    'a renamed or deleted guard would otherwise drop out of test:guards silently'
  )
  assert.ok(guards.includes('tests/check-scripts.test.ts'))
})
