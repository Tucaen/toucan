import { strict as assert } from 'node:assert'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { test } from 'vitest'

/**
 * `npm run check:quick` is what a session runs before it reports done; CI runs `npm run check`.
 * The quick gate is only worth having while it fails on what CI fails on, so both share one static
 * half and the quick one adds the guard tests: the ones that read the repository through `fs`
 * rather than importing it, which `vitest --changed` cannot connect to the file a change touched.
 */

const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts
const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8')
const guards = scripts['test:guards'].split(/\s+/).filter((word) => word.startsWith('tests/'))

/** A checked-in source read, or `@vite-ignore`-imported, by path: a dependency no import graph shows. */
const READS_REPOSITORY_FILE =
  /(?:\b(?:readFileSync|readdirSync|globSync)\(|@vite-ignore).*['"`](?:\.\.\/)?(?:src|mobile|scripts|docs|\.github|\.agents)\//

test('CI runs the full gate, and the full and quick gates share one static half', () => {
  assert.match(ciWorkflow, /- run: npm run check\r?\n/)
  assert.match(scripts.check, /^npm run check:static && /)
  assert.match(scripts['check:quick'], /^npm run check:static && /)
  assert.match(scripts['check:quick'], /npm run test:guards/)
  assert.match(scripts['check:quick'], /npm run test:changed/)
})

test('every guard the quick gate names is a node test that exists', () => {
  assert.ok(guards.length > 0)
  assert.deepEqual(
    guards.filter((file) => !existsSync(file) || !file.endsWith('.test.ts')),
    [],
    'a renamed or deleted guard would otherwise drop out of test:guards silently'
  )
})

test('every node test that reads a checked-in source by path is a guard', () => {
  const unlisted = readdirSync('tests')
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => `tests/${name}`)
    .filter((file) => READS_REPOSITORY_FILE.test(readFileSync(file, 'utf8')) && !guards.includes(file))
  assert.deepEqual(unlisted, [], 'add these to test:guards in package.json, or check:quick never runs them')
})
