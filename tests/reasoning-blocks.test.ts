import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  estimateReasoningTokens,
  formatReasoningSize,
  mergeReasoningEntries,
  reasoningTailLine,
  type ReasoningMergeEntry
} from '../src/renderer/src/reasoning-blocks'

interface Entry {
  kind: 'thought' | 'other'
  id: string
  text?: string
}

const chunkOf = (entry: Entry): { id: string; text: string } | null =>
  entry.kind === 'thought' ? { id: entry.id, text: entry.text ?? '' } : null

const blocks = (entries: Entry[], working = false): ReasoningMergeEntry<Entry>[] =>
  mergeReasoningEntries(entries, chunkOf, { working })

describe('reasoning blocks', () => {
  test('merges consecutive thought chunks into a single block', () => {
    const merged = blocks([
      { kind: 'other', id: 'user-1' },
      { kind: 'thought', id: 't-1', text: 'First thought.' },
      { kind: 'thought', id: 't-2', text: 'Second thought.' },
      { kind: 'other', id: 'assistant-1' }
    ])

    assert.equal(merged.length, 3)
    const block = merged[1]
    assert.equal(block.kind, 'reasoning')
    if (block.kind !== 'reasoning') return
    assert.deepEqual(block.block.chunkIds, ['t-1', 't-2'])
    assert.equal(block.block.text, 'First thought.\n\nSecond thought.')
  })

  test('keeps a block identified by its first chunk so growth never changes its key', () => {
    const first = blocks([{ kind: 'thought', id: 't-1', text: 'One.' }])[0]
    const grown = blocks([
      { kind: 'thought', id: 't-1', text: 'One.' },
      { kind: 'thought', id: 't-2', text: 'Two.' }
    ])[0]

    assert.equal(first.kind === 'reasoning' && first.block.id, 't-1')
    assert.equal(grown.kind === 'reasoning' && grown.block.id, 't-1')
  })

  test('splits blocks that are interrupted by other transcript entries', () => {
    const merged = blocks([
      { kind: 'thought', id: 't-1', text: 'Before the tool call.' },
      { kind: 'other', id: 'tool-1' },
      { kind: 'thought', id: 't-2', text: 'After the tool call.' }
    ])

    assert.deepEqual(
      merged.map((entry) => (entry.kind === 'reasoning' ? entry.block.chunkIds : entry.entry.id)),
      [['t-1'], 'tool-1', ['t-2']]
    )
  })

  test('drops thought chunks with no text so an empty card can never render', () => {
    const merged = blocks([
      { kind: 'thought', id: 't-1', text: '   ' },
      { kind: 'other', id: 'assistant-1' }
    ])

    assert.deepEqual(
      merged.map((entry) => entry.kind),
      ['other']
    )
  })

  test('marks only the trailing block as streaming, and only while the turn is working', () => {
    const entries: Entry[] = [
      { kind: 'thought', id: 't-1', text: 'Earlier.' },
      { kind: 'other', id: 'tool-1' },
      { kind: 'thought', id: 't-2', text: 'Latest.' }
    ]

    assert.deepEqual(
      blocks(entries, true).flatMap((entry) => (entry.kind === 'reasoning' ? [entry.block.streaming] : [])),
      [false, true]
    )
    assert.deepEqual(
      blocks(entries, false).flatMap((entry) => (entry.kind === 'reasoning' ? [entry.block.streaming] : [])),
      [false, false]
    )
  })

  test('does not call a block streaming when something else came after it', () => {
    const merged = blocks(
      [
        { kind: 'thought', id: 't-1', text: 'Thinking.' },
        { kind: 'other', id: 'tool-1' }
      ],
      true
    )
    assert.equal(merged[0].kind === 'reasoning' && merged[0].block.streaming, false)
  })

  test('estimates size deterministically from the merged text', () => {
    assert.equal(estimateReasoningTokens(''), 0)
    assert.equal(estimateReasoningTokens('abcd'), 1)
    assert.equal(estimateReasoningTokens('a'.repeat(4000)), 1000)
    assert.equal(estimateReasoningTokens('a'), 1)
  })

  test('formats size for a collapsed summary line', () => {
    assert.equal(formatReasoningSize(0), '')
    assert.equal(formatReasoningSize(1), '~1 token')
    assert.equal(formatReasoningSize(350), '~350 tokens')
    assert.equal(formatReasoningSize(1000), '~1k tokens')
    assert.equal(formatReasoningSize(1200), '~1.2k tokens')
    assert.equal(formatReasoningSize(12400), '~12k tokens')
  })

  test('reports the newest line as the live preview', () => {
    assert.equal(reasoningTailLine('First line.\n\nStill working on it.\n'), 'Still working on it.')
    assert.equal(reasoningTailLine('## A heading'), 'A heading')
    assert.equal(reasoningTailLine('   '), '')
  })
})
