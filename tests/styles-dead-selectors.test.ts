import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * A class selector whose JSX was deleted leaves no trace: nothing fails, nothing warns, and the
 * rule survives every future edit of the file it sits in. This is the check that notices, run over
 * the one stylesheet the renderer ships (issue #227).
 */
const STYLESHEET = join(process.cwd(), 'src', 'renderer', 'src', 'styles.css')
const RENDERER = join(process.cwd(), 'src', 'renderer', 'src')

/**
 * Classes emitted by libraries rather than by this repo's JSX, so their absence from `src/renderer`
 * proves nothing. Kept as prefixes because each family is generated: React Flow's canvas chrome,
 * highlight.js and the CodeMirror/Shiki token names the transcript's code blocks carry, and
 * `task-list-item`, which `remark-gfm` puts on a checkbox list item.
 */
const GENERATED_PREFIXES = ['react-flow__', 'hljs-', 'tok-', 'cm-', 'task-list-item']

/**
 * Every class name the renderer could put on an element, as whole words. A substring scan over the
 * concatenated sources would be far too forgiving - `.row` would survive on `arrow`, `.node-header`
 * on `node-header-row` - so the sources are cut on the characters a class name cannot contain, and
 * a selector has to match one of the resulting tokens outright.
 */
function sourceTokens(directory: string, tokens = new Set<string>()): Set<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) sourceTokens(path, tokens)
    else if (/\.(ts|tsx)$/.test(entry.name)) {
      for (const token of readFileSync(path, 'utf8').split(/[^\w-]+/)) if (token) tokens.add(token)
    }
  }
  return tokens
}

function classSelectors(css: string): string[] {
  // Declaration blocks are stripped first so a value like `color-mix(...)` cannot be read as a
  // selector, then the rest is cut into compound selectors - `.a.b` is one compound, `.a .b` two.
  const compounds = css.replace(/\{[^{}]*\}/g, ' ').split(/[\s,>+~()]+/)
  const names = new Set<string>()
  for (const compound of compounds) {
    const classes = [...compound.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1]!)
    // A class only a library ever writes pins its whole compound: `.hljs-title.function_` says
    // nothing about this repo's JSX, and neither does the `function_` half on its own.
    if (classes.some((name) => GENERATED_PREFIXES.some((prefix) => name.startsWith(prefix)))) continue
    for (const name of classes) names.add(name)
  }
  return [...names]
}

test('every class selector in styles.css is one the renderer still puts on an element', () => {
  const selectors = classSelectors(readFileSync(STYLESHEET, 'utf8'))
  // A parse that silently collapsed would make every assertion below pass on nothing. The floor is
  // the count this stylesheet actually carries, less a little room to delete rules without editing
  // the test; a rewrite that halves it is a broken parser, not a tidy-up.
  assert.ok(selectors.length > 450, `expected the whole stylesheet, parsed ${selectors.length} selectors`)

  const tokens = sourceTokens(RENDERER)
  const dead = selectors.filter((name) => !tokens.has(name))

  assert.deepEqual(
    dead,
    [],
    `styles.css keeps rules for classes no renderer source names: ${dead.join(', ')}. Delete the rules, or add the family to GENERATED_PREFIXES if a library emits them.`
  )
})
