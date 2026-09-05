import { readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

/**
 * One scrollbar for the whole app. `scrollbar-color` and `scrollbar-width` are inherited
 * properties, so declaring them once on `:root` gives every scroll container - panels, dialogs,
 * the chat transcript, file nodes, the terminal viewport - the same thin canvas scrollbar.
 * A per-component redeclaration is how surfaces drift apart again, so there must be none.
 */

const styles = readFileSync('src/renderer/src/styles.css', 'utf8')

const declarationsIn = (block: string): string[] =>
  block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('scrollbar-'))
    .sort()

const rootBlock = (): string => {
  const match = /:root \{([^}]*)\}/.exec(styles)
  if (!match) throw new Error('styles.css must declare a :root rule')
  return match[1]
}

test(':root declares the app-wide scrollbar', () => {
  assert.deepEqual(declarationsIn(rootBlock()), ['scrollbar-color: #3b4553 transparent;', 'scrollbar-width: thin;'])
})

test('no component redeclares a scrollbar of its own', () => {
  assert.deepEqual(declarationsIn(styles.replace(rootBlock(), '')), [])
})
