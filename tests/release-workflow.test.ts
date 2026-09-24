import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

interface PackageManifest {
  scripts?: Record<string, string>
  repository?: { url?: string }
  dependencies?: Record<string, string>
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

test('publishes to the source repository itself', () => {
  const publish = manifest.build?.publish
  assert.ok(publish, 'build.publish is what electron-builder, electron-updater and the workflow all read')
  assert.equal(publish.provider, 'github')
  assert.ok(publish.owner, 'an owner must be configured')
  assert.ok(publish.repo, 'a repo must be configured')
  const source = manifest.repository?.url?.replace(/\.git$/, '')
  assert.ok(source, 'package.json repository must name the source repository')
  assert.equal(
    `https://github.com/${publish.owner}/${publish.repo}`,
    source,
    'the workflow token can only publish into the repository it runs in'
  )
})

test('the workflow reads the release destination from build.publish rather than hardcoding it', () => {
  assert.match(workflow, /ConvertFrom-Json\)\.build\.publish/)
  assert.doesNotMatch(
    workflow,
    /--repo [A-Za-z]/,
    'a literal --repo owner/name in the workflow would drift from build.publish'
  )
})

test('adapter and SDK dependencies are pinned exact', () => {
  // What an ACP adapter does to a live resume is not something the suite can reach (AGENTS.md);
  // upgrades are deliberate and verified by hand, so a range must never float one in.
  for (const name of [
    '@agentclientprotocol/claude-agent-acp',
    '@agentclientprotocol/codex-acp',
    '@agentclientprotocol/sdk',
    '@anthropic-ai/claude-agent-sdk'
  ]) {
    const version = manifest.dependencies?.[name]
    assert.ok(version, `${name} must be a dependency`)
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must be pinned exact, found "${version}"`)
  }
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

test('publishes with the workflow token, granted contents write', () => {
  assert.match(workflow, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/)
  assert.match(workflow, /permissions:\s*\n(\s*#[^\n]*\n)*\s*contents: write/)
  assert.doesNotMatch(workflow, /RELEASES_REPO_TOKEN/, 'no personal access token is needed any more')
})

test('pins every action in every workflow to a commit SHA', () => {
  const directory = join(repositoryRoot, '.github/workflows')
  for (const file of readdirSync(directory)) {
    const source = readFileSync(join(directory, file), 'utf8')
    for (const [, ref] of source.matchAll(/uses: [^@\s]+@(\S+)/g)) {
      assert.match(ref, /^[0-9a-f]{40}$/, `${file}: a tag like @${ref} can be moved under the job`)
    }
  }
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
  // The engine and checkpoint are 1.6 GB that never change between releases. Shipping the previous
  // model made every installer and auto-update download over twice the size and cost six minutes
  // of NSIS compression; the app downloads its speech assets into userData on first use instead.
  assert.doesNotMatch(workflow, /voice-model|VOICE_MODEL/)
  assert.ok(
    !manifest.build?.files?.some((pattern) => /models/.test(pattern)),
    'nothing stages a model under the source tree any more, so no exclude should be needed to undo it'
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

test('reads the tag through ${env:TAG}, which PowerShell cannot fold a following colon into', () => {
  // `"refs/tags/$env:TAG:refs/tags/$env:TAG"` parses the second colon as part of the variable
  // path, so the refspec came out as `refs/tags//tags/v0.8.3` and the fetch failed. Nothing
  // checked it, the flattened tag had no annotation body, and the notes fell back to
  // "Automated release." on every release from v0.3.2 to v0.8.3.
  assert.doesNotMatch(workflow, /\$env:TAG:/, 'a bare $env:TAG must never be followed by a colon')
  assert.match(workflow, /git fetch --force --quiet origin "refs\/tags\/\$\{env:TAG\}:refs\/tags\/\$\{env:TAG\}"/)
  assert.match(
    workflow,
    /git fetch[^\n]*\n\s*if \(\$LASTEXITCODE -ne 0\) \{ throw/,
    'a fetch that fails must fail the step rather than quietly publish the fallback'
  )
})

test('writes the notes into a release a previous attempt already claimed', () => {
  assert.match(workflow, /gh release edit "\$\{env:TAG\}"[^\n]*--notes-file release-notes\.md/)
})

test('annotates the tag verbatim, so git does not strip the Markdown headings as comments', () => {
  // git's default cleanup drops every line starting with `#`, which is exactly what `## Changes
  // since` and `### Fixes` start with.
  const script = readFileSync(join(repositoryRoot, 'scripts/release.mjs'), 'utf8')
  assert.match(script, /git\('tag', '-a', '--cleanup=verbatim'/)

  const repository = mkdtempSync(join(tmpdir(), 'toucan-tag-'))
  try {
    const run = (...args: string[]): string =>
      execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trimEnd()
    run('init', '--quiet', '-b', 'main')
    run('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '--quiet', '--allow-empty', '-m', 'root')
    const notes = '## Changes since v1.0.0\n\n### Fixes\n- **scope:** a fix\n'
    run(
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=T',
      'tag',
      '-a',
      '--cleanup=verbatim',
      'v1.0.1',
      '-m',
      'Toucan v1.0.1',
      '-m',
      notes
    )
    const body = run('tag', '-l', '--format=%(contents:body)', 'v1.0.1')
    assert.match(body, /### Fixes/, 'the workflow reads exactly this body into the release notes')
    assert.match(body, /## Changes since v1\.0\.0/)
  } finally {
    rmSync(repository, { recursive: true, force: true })
  }
})
