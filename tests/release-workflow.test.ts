import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

interface PackageManifest {
  scripts?: Record<string, string>
  build?: {
    files?: string[]
    publish?: { provider?: string; owner?: string; repo?: string; releaseType?: string }
  }
}

const repositoryRoot = process.cwd()
const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as PackageManifest
const workflow = readFileSync(join(repositoryRoot, '.github/workflows/release.yml'), 'utf8')

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

test('neither downloads nor bundles the speech model, which the app fetches on first use', () => {
  // The model is 291 MB that never changes between releases. Shipping it made every installer
  // and every auto-update download over twice the size and cost six minutes of NSIS compression.
  assert.match(workflow, /TOUCAN_SKIP_VOICE_MODEL: '1'/, 'the prebuild hook would otherwise fetch it for nothing')
  assert.doesNotMatch(workflow, /prepare:voice-model/)
  assert.ok(
    manifest.build?.files?.includes('!out/renderer/models/**'),
    'Vite copies public/ into out/renderer, so the prepared model of a dev run must be packaged out'
  )
})

test('release notes come from the tag annotation that npm run release writes', () => {
  assert.equal(manifest.scripts?.release, 'node scripts/release.mjs')
  assert.match(
    workflow,
    /git tag -l --format='%\(contents:body\)'/,
    'the tag body is the only place notes are authored'
  )
  assert.match(
    workflow,
    /git fetch --force .*refs\/tags\//,
    'checkout flattens the annotated tag, so it must be re-fetched'
  )
  assert.match(workflow, /--notes-file release-notes\.md/)
})
