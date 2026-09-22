import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'

/**
 * An export no production code imports reads exactly like one that does, so a symbol kept alive
 * only by its own test survives every future audit of the file it sits in - which is how issue #227
 * came to find 150 of them at once. The repo's answer is a marker in the docblock; this is what
 * keeps the marker honest, by failing when a test-only export goes unmarked.
 */
const MARKER = '@internal exported for tests'
const ROOTS = ['src', 'mobile'].map((root) => join(process.cwd(), root))
const TESTS = join(process.cwd(), 'tests')
/** Model checkpoints and other shipped assets, which are not sources and are large. */
const SKIP_DIRECTORIES = new Set(['node_modules', 'public'])

function sources(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) sources(join(directory, entry.name), found)
    } else if (/\.(ts|tsx)$/.test(entry.name)) found.push(join(directory, entry.name))
  }
  return found
}

/** Cut on the characters an identifier cannot contain, so a name only matches as a whole word. */
function identifiers(text: string): Set<string> {
  return new Set(text.split(/[^\w$]+/).filter(Boolean))
}

test('every runtime export that only tests reach is marked as such', () => {
  const sourceFiles = ROOTS.flatMap((root) => sources(root))
  assert.ok(sourceFiles.length > 200, `expected the whole tree, found ${sourceFiles.length} sources`)

  const text = new Map(sourceFiles.map((path) => [path, readFileSync(path, 'utf8')]))
  // How many source files mention a name at all. One means "its own file and nowhere else".
  const mentions = new Map<string, number>()
  for (const body of text.values()) {
    for (const name of identifiers(body)) mentions.set(name, (mentions.get(name) ?? 0) + 1)
  }
  const testIdentifiers = identifiers(
    sources(TESTS)
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n')
  )

  const unmarked: string[] = []
  for (const [path, body] of text) {
    const lines = body.split('\n')
    lines.forEach((line, index) => {
      const declared = /^export (?:async )?(?:function|const|let|class) (\w+)/.exec(line)
      if (!declared) return
      const name = declared[1]!
      if ((mentions.get(name) ?? 0) !== 1 || !testIdentifiers.has(name)) return
      // The marker sits in the docblock immediately above the declaration, however long it is.
      let above = index - 1
      if (lines[above]?.trim() === '*/') {
        while (above > 0 && !lines[above]!.trim().startsWith('/**')) above -= 1
      }
      if (lines.slice(above, index).join('\n').includes(MARKER)) return
      unmarked.push(`${relative(process.cwd(), path).replace(/\\/g, '/')}:${index + 1} ${name}`)
    })
  }

  assert.deepEqual(
    unmarked,
    [],
    `these exports are reached by no source file but their own, and by tests, so each needs a \`${MARKER}\` docblock - or, if nothing should be reaching it at all, deleting:\n  ${unmarked.join('\n  ')}`
  )
})
