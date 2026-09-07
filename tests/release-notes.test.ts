import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

interface ReleaseNotesModule {
  releaseNotes(previousTag: string | null, subjects: string[]): string
  nextVersion(current: string, bump: string): string
}

// The tests compile to CommonJS, where tsc would rewrite `import()` into `require()`, which
// cannot load an ES module. Going through Function keeps a real dynamic import.
const load = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>
const notesModule = load(
  pathToFileURL(join(process.cwd(), 'scripts/release-notes.mjs')).href
) as Promise<ReleaseNotesModule>

test('groups conventional commits into features, fixes and other changes', async () => {
  const { releaseNotes } = await notesModule
  const notes = releaseNotes('v0.3.1', [
    'fix(ci): claim the release before packaging',
    'feat: dictate into the composer',
    'docs: explain the release procedure',
    'Tidy the canvas styles'
  ])
  assert.equal(
    notes,
    [
      '## Changes since v0.3.1',
      '',
      '### Features',
      '- dictate into the composer',
      '',
      '### Fixes',
      '- **ci:** claim the release before packaging',
      '',
      '### Other changes',
      '- explain the release procedure',
      '- Tidy the canvas styles',
      ''
    ].join('\n')
  )
})

test('a first release lists every commit without a comparison tag', async () => {
  const { releaseNotes } = await notesModule
  assert.match(releaseNotes(null, ['feat: everything']), /^## Changes\n\n### Features\n- everything\n$/)
})

test('bumps patch, minor and major or accepts an explicit version', async () => {
  const { nextVersion } = await notesModule
  assert.equal(nextVersion('0.3.1', 'patch'), '0.3.2')
  assert.equal(nextVersion('0.3.1', 'minor'), '0.4.0')
  assert.equal(nextVersion('0.3.1', 'major'), '1.0.0')
  assert.equal(nextVersion('0.3.1', '2.0.0'), '2.0.0')
  assert.throws(() => nextVersion('0.3.1', 'huge'))
})
