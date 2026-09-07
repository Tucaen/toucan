import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

interface PackageManifest {
  scripts?: Record<string, string>
  build?: {
    publish?: { provider?: string; owner?: string; repo?: string; releaseType?: string }
  }
}

const repositoryRoot = process.cwd()
const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as PackageManifest
const workflow = readFileSync(join(repositoryRoot, '.github/workflows/release.yml'), 'utf8')
const gitignore = readFileSync(join(repositoryRoot, '.gitignore'), 'utf8')

const stepIndex = (needle: string): number => {
  const index = workflow.indexOf(needle)
  assert.notEqual(index, -1, `release.yml must contain ${needle}`)
  return index
}

test('publishes to a separate public repository so the source repository can stay private', () => {
  const publish = manifest.build?.publish
  assert.ok(publish, 'build.publish is what electron-builder and electron-updater both read')
  assert.equal(publish.provider, 'github')
  assert.equal(publish.owner, 'Tucaen')
  assert.equal(publish.repo, 'toucan-releases')
  assert.notEqual(publish.repo, 'ade', 'releases must never land in the private source repository')
})

test('publishes a real release rather than the provider default draft', () => {
  assert.equal(
    manifest.build?.publish?.releaseType,
    'release',
    'a draft release is invisible to logged-out visitors, which defeats the whole point'
  )
})

test('publish:win packages every configured Windows target', () => {
  const script = manifest.scripts?.['publish:win'] ?? ''
  assert.match(script, /electron-builder --win --x64 --publish always/)
  assert.doesNotMatch(script, /--win (nsis|portable)/, 'naming one target on the CLI overrides the configured list')
})

test('releases are cut by pushing a version tag', () => {
  assert.match(workflow, /on:\s*\n\s*push:\s*\n\s*tags:\s*\n\s*- 'v\*'/)
})

test('runs the verification gate before anything is published', () => {
  assert.ok(stepIndex('npm run check') < stepIndex('npm run publish:win'), 'a failing check must publish nothing')
})

test('publishes with a token scoped to the releases repository', () => {
  assert.match(workflow, /GH_TOKEN: \$\{\{ secrets\.RELEASES_REPO_TOKEN \}\}/)
  assert.doesNotMatch(
    workflow,
    /secrets\.GITHUB_TOKEN/,
    'the default workflow token cannot write to another repository'
  )
})

test('claims the release before packaging, so the two targets cannot race to create it', () => {
  // Each Windows target publishes on its own and will create the release if none exists. Two
  // creates race, and the loser's 422 aborts the rest of the uploads - which once left a release
  // holding its installers but no latest.yml, so the updater had no feed. Creating it first
  // leaves both publishers with nothing to do but upload.
  assert.ok(
    stepIndex('gh release create') < stepIndex('npm run publish:win'),
    'claiming the release after packaging would not prevent the race it exists to prevent'
  )
  assert.match(workflow, /gh release view/, 'an existing release must be reused, never recreated')
})

test('caches the voice model the build downloads rather than fetching 165 MB per release', () => {
  const modelDirectory = 'src/renderer/public/models/moonshine-small-streaming-en'
  // The model is downloaded, never committed, so the cached path has to be ignored - by its own
  // entry or by an ancestor's, which is how .gitignore actually covers it today.
  const ignored = gitignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .some((line) => `${modelDirectory}/`.startsWith(line.replace(/^\//, '')))
  assert.ok(ignored, 'the cached path must be a gitignored directory')
  assert.ok(workflow.includes(`path: ${modelDirectory}`))
  assert.ok(
    stepIndex('actions/cache') < stepIndex('npm run prepare:voice-model'),
    'restoring after the download would cache nothing useful'
  )
})
