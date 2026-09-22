import { strict as assert } from 'node:assert'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { test } from 'vitest'

// AGENTS.md is the file CLAUDE.md tells every agent to read first, and the docs beside it are the
// next stop. A path that no longer resolves is worse than no path at all: it sends the reader
// looking for a file the refactor deleted, and it is the loudest signal that the prose around it
// has drifted too. Renames are the usual cause, so this test fails the rename, not the review.

const repositoryRoot = process.cwd()
const sourceRoots = ['src', 'tests', 'scripts', 'mobile', 'docs', 'resources', '.github']

// `docs/research/` compares this repo against other products and quotes their file trees;
// `docs/tickets/` is a dated board whose entries describe the code as it stood when they were
// written. Neither claims a path exists here now, so neither is scanned.
const notLivingDocumentation = ['docs/research', 'docs/tickets']

const markdownFiles = (directory: string): string[] => {
  if (notLivingDocumentation.includes(directory)) return []
  const entries = readdirSync(join(repositoryRoot, directory), { withFileTypes: true })
  return entries.flatMap((entry) => {
    const child = posix.join(directory, entry.name)
    if (entry.isDirectory()) return markdownFiles(child)
    return entry.name.endsWith('.md') ? [child] : []
  })
}

const documents = [
  ...['AGENTS.md', 'CLAUDE.md', 'README.md', 'CONTEXT.md'].filter((file) => existsSync(join(repositoryRoot, file))),
  ...markdownFiles('docs')
]

// Fenced blocks hold sample transcripts and illustrative trees whose paths describe some other
// repository; only prose makes a claim about this one.
const outsideCodeFences = (text: string): string[] => {
  let fenced = false
  return text.split(/\r?\n/).map((line) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      return ''
    }
    return fenced ? '' : line
  })
}

// A trailing slash names a directory, and the two this repo documents (`docs/adr/`, a context's
// own `docs/adr/`) are deliberately created only when the first decision is written down.
const namesAFile = (path: string): boolean => /\.[A-Za-z0-9]+$/.test(path)

/**
 * Every unresolved reference the extractor finds, as `document: text`, so a failure reads as the
 * edit it needs. `base` differs by reference kind: a backticked path is from the repository root,
 * a Markdown link from the document's own directory.
 */
const unresolvedReferences = (extract: (line: string) => string[], base: (document: string) => string): string[] => {
  const unresolved: string[] = []
  for (const document of documents) {
    const lines = outsideCodeFences(readFileSync(join(repositoryRoot, document), 'utf8'))
    for (const reference of new Set(lines.flatMap(extract))) {
      if (existsSync(resolve(repositoryRoot, base(document), reference))) continue
      unresolved.push(`${document}: ${reference}`)
    }
  }
  return unresolved
}

test('every repository path AGENTS.md and docs/ quote in backticks resolves', () => {
  const rootPattern = new RegExp(`\`((?:${sourceRoots.join('|')})/[A-Za-z0-9._/-]+)\``, 'g')
  const unresolved = unresolvedReferences(
    (line) => [...line.matchAll(rootPattern)].map((match) => match[1]).filter(namesAFile),
    () => '.'
  )
  assert.deepEqual(unresolved, [], 'a backticked path that does not resolve has outlived its file')
})

test('every relative Markdown link in AGENTS.md and docs/ resolves', () => {
  const unresolved = unresolvedReferences(
    (line) =>
      [...line.matchAll(/\]\(([^)\s]+)\)/g)]
        .map((match) => match[1].split('#')[0])
        // A bare fragment stays on the page, and anything with a scheme is somebody else's server.
        .filter((target) => target !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(target)),
    dirname
  )
  assert.deepEqual(unresolved, [], 'a link that 404s in the GitHub view is a link nobody can follow')
})

test('the documents this test guards are the ones an agent is told to read', () => {
  // A doc that stops being scanned drifts silently, so the set is asserted rather than assumed.
  assert.ok(documents.includes('AGENTS.md'), 'AGENTS.md is the entry point CLAUDE.md points at')
  assert.ok(documents.includes('docs/architecture.md'))
  assert.ok(
    documents.some((document) => document.startsWith('docs/plans/')),
    'plans name the files they propose to change'
  )
  for (const excluded of notLivingDocumentation) {
    assert.ok(
      !documents.some((document) => document.startsWith(`${excluded}/`)),
      `${excluded} quotes paths that were never meant to resolve here`
    )
  }
})
