import * as assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'vitest'

interface CiRun {
  status: string
  conclusion: string
  url: string
}

interface ReleaseGateModule {
  changeSubjects(subjects: string[]): string[]
  ciRefusal(sha: string, runs: CiRun[]): string | null
  previousReleaseTag(mergedTags: string[], publishedTags: string[]): string | null
  ciRunListArgs(repository: string, sha: string): string[]
  isVersionBump(subject: string, files: Record<string, [unknown, unknown]>): boolean
  tagRefusal(tag: string, version: string): string | null
  ciDecision(
    sha: string,
    runs: CiRun[],
    waitedMs: number,
    limits: { runningMs: number; missingMs: number }
  ): { wait: true } | { wait: false; refusal: string | null }
}

// A file URL rather than a relative specifier, because the script under test lives outside the
// test's own directory tree and is plain `.mjs` with no types to import from.
const gateModule = import(
  /* @vite-ignore */ pathToFileURL(join(process.cwd(), 'scripts/release-gate.mjs')).href
) as Promise<ReleaseGateModule>

const run = (status: string, conclusion: string): CiRun => ({ status, conclusion, url: 'https://ci/run' })

test('a commit whose CI run succeeded may be released', async () => {
  const { ciRefusal } = await gateModule
  assert.equal(ciRefusal('abc1234', [run('completed', 'success')]), null)
})

test('a commit whose CI failed, is still running or never ran is refused, naming why', async () => {
  const { ciRefusal } = await gateModule
  assert.match(ciRefusal('abc1234', [run('completed', 'failure')]) ?? '', /failure.*https:\/\/ci\/run/)
  assert.match(ciRefusal('abc1234', [run('in_progress', '')]) ?? '', /still running.*https:\/\/ci\/run/)
  assert.match(ciRefusal('abc1234', []) ?? '', /no CI run/)
  // A cancelled run says nothing about the code; the way out is a re-run, not a fix.
  assert.match(ciRefusal('abc1234', [run('completed', 'cancelled')]) ?? '', /cancelled.*re-run/)
})

test('a re-run that succeeded wins over the failed attempt it replaced', async () => {
  const { ciRefusal } = await gateModule
  // `gh run list` lists newest first; a cancelled run superseded by a green one is not a refusal.
  assert.equal(ciRefusal('abc1234', [run('completed', 'success'), run('completed', 'cancelled')]), null)
})

test('release notes count from the last published release, skipping tags whose release failed', async () => {
  const { previousReleaseTag } = await gateModule
  assert.equal(previousReleaseTag(['v0.26.8', 'v0.26.7', 'v0.26.6'], ['v0.26.7', 'v0.26.5']), 'v0.26.7')
  // Nothing reachable was published (a release list that came back short): the newest tag, as before.
  assert.equal(previousReleaseTag(['v0.26.8', 'v0.26.7'], ['v0.1.0']), 'v0.26.8')
  assert.equal(previousReleaseTag([], []), null)
})

test("a failed release's bump commit is not a change in the next release's notes", async () => {
  const { changeSubjects } = await gateModule
  assert.deepEqual(changeSubjects(['fix: a', '0.26.8', '', 'feat: b', 'chore: bump to 0.26.8']), [
    'fix: a',
    'feat: b',
    'chore: bump to 0.26.8'
  ])
})

const manifest = (version: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'toucan',
  version,
  ...extra
})
const lockfile = (version: string, dependency = '1.0.0'): Record<string, unknown> => ({
  name: 'toucan',
  version,
  lockfileVersion: 3,
  packages: { '': { name: 'toucan', version }, 'node_modules/ws': { version: dependency } }
})

test('the commit npm run release makes is a version bump, so the workflow gates on its parent', async () => {
  const { isVersionBump } = await gateModule
  // What `npm version` writes: the version in package.json and in both places in the lockfile.
  assert.equal(
    isVersionBump('0.26.9', {
      'package.json': [manifest('0.26.8'), manifest('0.26.9')],
      'package-lock.json': [lockfile('0.26.8'), lockfile('0.26.9')]
    }),
    true
  )
})

test('a commit that changes anything beyond the version needs a CI run of its own', async () => {
  const { isVersionBump } = await gateModule
  // A dependency moved alongside the version: CI never ran on that tree.
  assert.equal(
    isVersionBump('0.26.9', {
      'package.json': [manifest('0.26.8'), manifest('0.26.9')],
      'package-lock.json': [lockfile('0.26.8'), lockfile('0.26.9', '2.0.0')]
    }),
    false
  )
  assert.equal(
    isVersionBump('0.26.9', {
      'package.json': [manifest('0.26.8'), manifest('0.26.9', { main: 'other.js' })]
    }),
    false
  )
  // Any other file at all, or a subject that is not the bare version.
  assert.equal(
    isVersionBump('0.26.9', {
      'package.json': [manifest('0.26.8'), manifest('0.26.9')],
      'src/main/index.ts': [null, null]
    }),
    false
  )
  assert.equal(isVersionBump('fix: bump', { 'package.json': [manifest('0.26.8'), manifest('0.26.9')] }), false)
  assert.equal(isVersionBump('0.26.9', {}), false)
})

test('a tag must name the version the packager will publish under', async () => {
  const { tagRefusal } = await gateModule
  assert.equal(tagRefusal('v0.26.9', '0.26.9'), null)
  // electron-builder uploads into v<package.json version>, so a mismatched tag claims one release
  // and fills another.
  assert.match(tagRefusal('v0.26.9', '0.26.8') ?? '', /v0\.26\.9.*0\.26\.8/)
})

test('the release workflow waits for a CI run that is still going, then decides', async () => {
  const { ciDecision } = await gateModule
  const limits = { runningMs: 60_000, missingMs: 10_000 }
  assert.deepEqual(ciDecision('abc1234', [run('completed', 'success')], 0, limits), { wait: false, refusal: null })
  assert.deepEqual(ciDecision('abc1234', [run('in_progress', '')], 30_000, limits), { wait: true })
  // A hand-pushed tag can arrive before GitHub has registered the commit's CI run.
  assert.deepEqual(ciDecision('abc1234', [], 5_000, limits), { wait: true })
  const missing = ciDecision('abc1234', [], 10_000, limits)
  assert.equal(missing.wait, false)
  assert.match(missing.wait ? '' : (missing.refusal ?? ''), /no CI run/)
  const stuck = ciDecision('abc1234', [run('queued', '')], 60_000, limits)
  assert.match(stuck.wait ? '' : (stuck.refusal ?? ''), /still running/)
  const red = ciDecision('abc1234', [run('completed', 'failure')], 0, limits)
  assert.match(red.wait ? '' : (red.refusal ?? ''), /failure/)
})

test('both gates list CI runs of the ci.yml workflow for exactly the commit they check', async () => {
  const { ciRunListArgs } = await gateModule
  assert.deepEqual(ciRunListArgs('https://github.com/o/r', 'abc'), [
    'run',
    'list',
    '--repo',
    'https://github.com/o/r',
    '--workflow',
    'ci.yml',
    '--commit',
    'abc',
    '--json',
    'status,conclusion,url'
  ])
})
