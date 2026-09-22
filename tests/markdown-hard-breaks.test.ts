import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { remarkHardBreaks } from '../src/shared/markdown-hard-breaks'

/**
 * Markdown turns a single newline into a space, so a composed message with one thought per line
 * would arrive in the transcript as one reflowed paragraph. These are the mdast shapes the plugin
 * has to change, and the ones it must leave exactly as they are.
 */

type MdastNode = { type: string; value?: string; children?: MdastNode[] }

function paragraph(...values: string[]): MdastNode {
  return { type: 'root', children: [{ type: 'paragraph', children: values.map((value) => ({ type: 'text', value })) }] }
}

function apply(tree: MdastNode): MdastNode {
  remarkHardBreaks()(tree)
  return tree
}

test('a newline a person typed becomes a line break instead of a space', () => {
  const tree = apply(paragraph('first thought\nsecond thought'))

  assert.deepEqual(tree.children?.[0].children, [
    { type: 'text', value: 'first thought' },
    { type: 'break' },
    { type: 'text', value: 'second thought' }
  ])
})

test('a blank line between two lines keeps its empty text node, so the gap survives', () => {
  const tree = apply(paragraph('one\n\ntwo'))

  assert.deepEqual(tree.children?.[0].children, [
    { type: 'text', value: 'one' },
    { type: 'break' },
    { type: 'text', value: '' },
    { type: 'break' },
    { type: 'text', value: 'two' }
  ])
})

test('a single-line text node is returned untouched, not rebuilt', () => {
  const original = { type: 'text', value: 'just one line' }
  const tree = apply({ type: 'root', children: [{ type: 'paragraph', children: [original] }] })

  assert.equal(tree.children?.[0].children?.[0], original, 'an unchanged node must keep its identity')
})

test('a fence keeps its newlines, because its source lives in value rather than in child text', () => {
  const code = { type: 'code', value: 'const a = 1\nconst b = 2' }
  const tree = apply({ type: 'root', children: [code] })

  assert.equal(code.value, 'const a = 1\nconst b = 2')
  assert.deepEqual(tree.children, [code])
})

test('nested inline nodes are reached, so a newline inside emphasis breaks too', () => {
  const tree = apply({
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [{ type: 'emphasis', children: [{ type: 'text', value: 'up\ndown' }] }]
      }
    ]
  })

  assert.deepEqual(tree.children?.[0].children?.[0].children, [
    { type: 'text', value: 'up' },
    { type: 'break' },
    { type: 'text', value: 'down' }
  ])
})

test('a leaf with no children at all is not a crash', () => {
  const tree: MdastNode = { type: 'thematicBreak' }

  assert.doesNotThrow(() => apply(tree))
  assert.deepEqual(tree, { type: 'thematicBreak' })
})
