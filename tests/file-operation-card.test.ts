import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  clampFileOperationBlocks,
  fileOperationBlocks,
  formatByteSize,
  parseFileOperation,
  shortenFilePath
} from '../src/renderer/src/file-operation'

test('a ranged read carries its path and line range out of the raw tool input', () => {
  const operation = parseFileOperation({
    id: 'r1',
    kind: 'read',
    toolName: 'Read',
    rawInput: { file_path: 'D:\\Development\\Toucan\\src\\main\\index.ts', offset: 120, limit: 40 }
  })
  assert.deepEqual(operation, {
    kind: 'read',
    path: 'D:\\Development\\Toucan\\src\\main\\index.ts',
    range: { start: 120, end: 159 }
  })
})

test('a whole-file read reports no range', () => {
  const operation = parseFileOperation({
    id: 'r2',
    kind: 'read',
    toolName: 'Read',
    rawInput: { file_path: '/repo/src/app.ts' }
  })
  assert.deepEqual(operation, { kind: 'read', path: '/repo/src/app.ts' })
})

test('a read known only by its ACP location still renders as a file card', () => {
  assert.deepEqual(parseFileOperation({ id: 'r3', kind: 'read', locations: ['/repo/src/app.ts'] }), {
    kind: 'read',
    path: '/repo/src/app.ts'
  })
})

test('write keeps its payload so the card can show a size and a preview', () => {
  const operation = parseFileOperation({
    id: 'w1',
    kind: 'edit',
    toolName: 'Write',
    rawInput: { file_path: '/repo/a.txt', content: 'one\ntwo' }
  })
  assert.deepEqual(operation, { kind: 'write', path: '/repo/a.txt', content: 'one\ntwo' })
})

test('edit keeps the old and new strings as a single before/after pair', () => {
  const operation = parseFileOperation({
    id: 'e1',
    kind: 'edit',
    toolName: 'Edit',
    rawInput: { file_path: '/repo/a.ts', old_string: 'const a = 1', new_string: 'const a = 2' }
  })
  assert.deepEqual(operation, {
    kind: 'edit',
    path: '/repo/a.ts',
    edits: [{ oldText: 'const a = 1', newText: 'const a = 2' }]
  })
})

test('MultiEdit keeps every edit in order', () => {
  const operation = parseFileOperation({
    id: 'e2',
    kind: 'edit',
    toolName: 'MultiEdit',
    rawInput: {
      file_path: '/repo/a.ts',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd' }
      ]
    }
  })
  assert.equal(operation?.kind, 'multi-edit')
  assert.deepEqual(operation?.edits, [
    { oldText: 'a', newText: 'b' },
    { oldText: 'c', newText: 'd' }
  ])
})

test('a Write is a write and keeps the adapter diff that proves what changed', () => {
  // claude-agent-acp emits Write as kind 'edit' with a diff content item whose oldText is null
  // (see its tools.js). The content still identifies this as Write, while the diff is the evidence
  // the inline review card renders.
  const operation = parseFileOperation({
    id: 'w2',
    kind: 'edit',
    rawInput: { file_path: '/repo/a.ts', content: 'hello\nworld' },
    diffs: [{ path: '/repo/a.ts', newText: 'hello\nworld' }]
  })
  assert.deepEqual(operation, {
    kind: 'write',
    path: '/repo/a.ts',
    content: 'hello\nworld',
    diffs: [{ path: '/repo/a.ts', oldText: '', newText: 'hello\nworld' }]
  })
})

test('an edit reported only as an ACP diff still yields a before/after', () => {
  const operation = parseFileOperation({
    id: 'e3',
    kind: 'edit',
    locations: ['/repo/a.ts'],
    diffs: [{ path: '/repo/a.ts', oldText: 'before', newText: 'after' }]
  })
  assert.deepEqual(operation, {
    kind: 'edit',
    path: '/repo/a.ts',
    edits: [{ oldText: 'before', newText: 'after' }],
    diffs: [{ path: '/repo/a.ts', oldText: 'before', newText: 'after' }]
  })
})

test('NotebookEdit names the cell it replaced', () => {
  const operation = parseFileOperation({
    id: 'n1',
    kind: 'edit',
    toolName: 'NotebookEdit',
    rawInput: { notebook_path: '/repo/a.ipynb', cell_id: 'cell-3', edit_mode: 'replace', new_source: 'print(1)' }
  })
  assert.deepEqual(operation, {
    kind: 'notebook-edit',
    path: '/repo/a.ipynb',
    cell: 'cell-3',
    editMode: 'replace',
    content: 'print(1)'
  })
})

test('tools that touch no file are not file operations', () => {
  assert.equal(parseFileOperation({ id: 'b1', kind: 'execute', rawInput: { command: 'npm test' } }), null)
  assert.equal(parseFileOperation({ id: 's1', kind: 'search', rawInput: { pattern: 'foo' } }), null)
  assert.equal(parseFileOperation({ id: 't1', kind: 'other' }), null)
})

test('paths are shortened against the workspace or worktree root, case- and separator-insensitively', () => {
  const roots = ['d:\\Development\\Toucan', 'd:\\Development\\Toucan\\.worktrees\\feature']
  assert.equal(shortenFilePath('D:\\Development\\Toucan\\src\\a.ts', roots), 'src/a.ts')
  // The deepest matching root wins, so a worktree file is not shown as .worktrees/feature/src/a.ts.
  assert.equal(shortenFilePath('d:/Development/Toucan/.worktrees/feature/src/a.ts', roots), 'src/a.ts')
  // A file outside every root keeps its full path rather than a misleading relative one.
  assert.equal(shortenFilePath('C:\\other\\a.ts', roots), 'C:/other/a.ts')
  assert.equal(shortenFilePath('/repo/a.ts', []), '/repo/a.ts')
})

test('a read excerpt is numbered from the start of the range', () => {
  const blocks = fileOperationBlocks(
    { kind: 'read', path: '/repo/a.ts', range: { start: 10, end: 12 } },
    'alpha\nbeta\ngamma'
  )
  assert.deepEqual(blocks, [
    {
      languagePath: '/repo/a.ts',
      lines: [
        { number: 10, text: 'alpha' },
        { number: 11, text: 'beta' },
        { number: 12, text: 'gamma' }
      ]
    }
  ])
})

test('an excerpt the agent already numbered is not numbered twice', () => {
  const blocks = fileOperationBlocks({ kind: 'read', path: '/repo/a.ts' }, '   10\talpha\n   11\tbeta\n   12\tgamma')
  assert.deepEqual(blocks[0].lines, [
    { number: 10, text: 'alpha' },
    { number: 11, text: 'beta' },
    { number: 12, text: 'gamma' }
  ])
})

test('write shows a size and a preview instead of the whole payload', () => {
  const blocks = fileOperationBlocks({ kind: 'write', path: '/repo/a.txt', content: 'one\ntwo' }, undefined)
  assert.equal(blocks[0].label, '7 B · 2 lines')
  assert.equal(blocks[0].languagePath, '/repo/a.txt')
  assert.deepEqual(blocks[0].lines, [
    { number: 1, text: 'one', tone: 'new' },
    { number: 2, text: 'two', tone: 'new' }
  ])
})

test('edits render as a compact before/after', () => {
  const blocks = fileOperationBlocks(
    {
      kind: 'multi-edit',
      path: '/repo/a.ts',
      edits: [
        { oldText: 'a\nb', newText: 'c' },
        { oldText: 'd', newText: 'e' }
      ]
    },
    undefined
  )
  assert.deepEqual(blocks, [
    {
      languagePath: '/repo/a.ts',
      label: 'Edit 1 of 2',
      lines: [
        { text: 'a', tone: 'old' },
        { text: 'b', tone: 'old' },
        { text: 'c', tone: 'new' }
      ]
    },
    {
      languagePath: '/repo/a.ts',
      label: 'Edit 2 of 2',
      lines: [
        { text: 'd', tone: 'old' },
        { text: 'e', tone: 'new' }
      ]
    }
  ])
})

test('an insertion has no before side and a deletion has no after side', () => {
  const inserted = fileOperationBlocks(
    { kind: 'edit', path: '/repo/a.ts', edits: [{ oldText: '', newText: 'added' }] },
    undefined
  )
  assert.deepEqual(inserted[0].lines, [{ text: 'added', tone: 'new' }])
  const deleted = fileOperationBlocks(
    { kind: 'edit', path: '/repo/a.ts', edits: [{ oldText: 'gone', newText: '' }] },
    undefined
  )
  assert.deepEqual(deleted[0].lines, [{ text: 'gone', tone: 'old' }])
})

test('blocks are clamped to the line budget and report what was held back', () => {
  const blocks = [
    { label: 'one', lines: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] },
    { label: 'two', lines: [{ text: 'd' }, { text: 'e' }] }
  ]
  const clamped = clampFileOperationBlocks(blocks, 4)
  assert.deepEqual(clamped, {
    blocks: [
      { label: 'one', lines: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] },
      { label: 'two', lines: [{ text: 'd' }] }
    ],
    hiddenLines: 1
  })
  // A block left with nothing to show is dropped rather than rendered empty.
  assert.deepEqual(clampFileOperationBlocks(blocks, 3).blocks, [blocks[0]])
  assert.deepEqual(clampFileOperationBlocks(blocks, null), { blocks, hiddenLines: 0 })
})

test('sizes read as bytes, kilobytes and megabytes', () => {
  assert.equal(formatByteSize(0), '0 B')
  assert.equal(formatByteSize(999), '999 B')
  assert.equal(formatByteSize(2048), '2.0 KB')
  assert.equal(formatByteSize(5 * 1024 * 1024), '5.0 MB')
})
