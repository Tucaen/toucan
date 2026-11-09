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
