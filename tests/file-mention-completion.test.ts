import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  acceptFileMention,
  acceptedFileMention,
  dismissFileMentionCompletion,
  emptyFileMentionCompletion,
  fileMentionCompletionView,
  fileMentionExclusionNote,
  fileMentionQuery,
  fileMentionReference,
  rankFileMentions,
  recentMentionPaths
} from '../src/renderer/src/file-mention-completion'
import type { WorkspaceFileEntry, WorkspaceFileIndex } from '../src/shared/workspace-files'

const file = (path: string): WorkspaceFileEntry => ({ path, directory: false })
const directory = (path: string): WorkspaceFileEntry => ({ path, directory: true })

const entries: WorkspaceFileEntry[] = [
  directory('src'),
  directory('src/main'),
  file('src/main/index.ts'),
  file('src/main/terminal-manager.ts'),
  file('src/renderer/src/ChatNode.tsx'),
  file('README.md'),
  file('tests/attention.test.ts')
]

const index = (overrides: Partial<WorkspaceFileIndex> = {}): WorkspaceFileIndex => ({
  root: 'D:/Development/ADE',
  entries,
  truncated: false,
  gitignored: true,
  ...overrides
})

test('an @ opening the draft is a mention token', () => {
  assert.deepEqual(fileMentionQuery('@', 1), { query: '', start: 0 })
  assert.deepEqual(fileMentionQuery('@src/main', 9), { query: 'src/main', start: 0 })
})

test('an @ after whitespace is a mention token, anywhere in the draft', () => {
  assert.deepEqual(fileMentionQuery('look at @src/ma', 15), { query: 'src/ma', start: 8 })
  assert.deepEqual(fileMentionQuery('first line\n@REA', 15), { query: 'REA', start: 11 })
})

test('an @ welded to a word is ordinary prose, not a mention', () => {
  assert.equal(fileMentionQuery('mail me at morgan@example.com', 29), null)
  assert.equal(fileMentionQuery('npm i react@19', 14), null)
})

test('the query stops at the caret and never spans whitespace', () => {
  // The caret parked mid-token still narrows the list to what precedes it.
  assert.deepEqual(fileMentionQuery('@src/main/index.ts', 5), { query: 'src/', start: 0 })
  // Once a space is typed the reader has moved on to prose again.
  assert.equal(fileMentionQuery('@src/main and also', 18), null)
})

test('an empty query offers everything in index order', () => {
  assert.deepEqual(
    rankFileMentions(entries, '', []).map((entry) => entry.path),
    entries.map((entry) => entry.path)
  )
})

test('paths the agent already touched come first, newest first', () => {
  const ranked = rankFileMentions(entries, '', ['src/main/terminal-manager.ts', 'README.md'])
  assert.deepEqual(
    ranked.slice(0, 2).map((entry) => entry.path),
    ['src/main/terminal-manager.ts', 'README.md']
  )
})

test('a recent path still outranks an equally good match while filtering', () => {
  const ranked = rankFileMentions(entries, 'index', ['src/main/index.ts'])
  assert.equal(ranked[0].path, 'src/main/index.ts')
})

test('a file-name prefix beats a mid-path match', () => {
  assert.deepEqual(
    rankFileMentions(entries, 'chat', []).map((entry) => entry.path),
    ['src/renderer/src/ChatNode.tsx']
  )
  const ranked = rankFileMentions([file('src/attention.ts'), file('attention.test.ts')], 'atten', [])
  assert.deepEqual(
    ranked.map((entry) => entry.path),
    ['attention.test.ts', 'src/attention.ts']
  )
})

test('matching is case-insensitive and fuzzy across a path', () => {
  assert.deepEqual(
    rankFileMentions(entries, 'mainidx', []).map((entry) => entry.path),
    []
  )
  assert.deepEqual(
    rankFileMentions(entries, 'srcmainindex', []).map((entry) => entry.path),
    ['src/main/index.ts']
  )
  assert.deepEqual(
    rankFileMentions(entries, 'CHATNODE', []).map((entry) => entry.path),
    ['src/renderer/src/ChatNode.tsx']
  )
})

test('the ranked list is bounded so a huge repository cannot flood the menu', () => {
  const many = Array.from({ length: 500 }, (_value, position) => file(`src/file-${position}.ts`))
  assert.equal(rankFileMentions(many, 'file', []).length, 50)
})

test('a reference is the root-relative path, quoted only when it contains whitespace', () => {
  assert.equal(fileMentionReference(file('src/main/index.ts')), '@src/main/index.ts')
  assert.equal(fileMentionReference(file('docs/design notes.md')), '@"docs/design notes.md"')
})

test('accepting a file replaces the token and leaves the caret past a trailing space', () => {
  const next = acceptFileMention('look at @ind', 12, { start: 8 }, file('src/main/index.ts'))
  assert.equal(next.draft, 'look at @src/main/index.ts ')
  assert.equal(next.caret, 'look at @src/main/index.ts '.length)
})

test('accepting a directory leaves the caret inside it so the path can be walked further', () => {
  const next = acceptFileMention('@src', 4, { start: 0 }, directory('src/main'))
  assert.equal(next.draft, '@src/main/')
  assert.equal(next.caret, '@src/main/'.length)
})

test('accepting keeps whatever already followed the caret', () => {
  const next = acceptFileMention('@ind and then some', 4, { start: 0 }, file('src/main/index.ts'))
  assert.equal(next.draft, '@src/main/index.ts  and then some')
})

test('the view is closed when nothing matches, and open when something does', () => {
  assert.equal(fileMentionCompletionView('@zzz', 4, index(), [], emptyFileMentionCompletion).open, false)
  assert.equal(fileMentionCompletionView('@ind', 4, index(), [], emptyFileMentionCompletion).open, true)
})

test('an empty index never opens the menu, so an unreadable directory stays out of the way', () => {
  const view = fileMentionCompletionView('@', 1, index({ entries: [] }), [], emptyFileMentionCompletion)
  assert.equal(view.open, false)
  assert.notEqual(view.token, null)
})

test('Escape hides the list for this token only', () => {
  const view = fileMentionCompletionView('@ind', 4, index(), [], emptyFileMentionCompletion)
  const dismissed = dismissFileMentionCompletion(emptyFileMentionCompletion, view.token)
  assert.equal(fileMentionCompletionView('@ind', 4, index(), [], dismissed).open, false)
  // A second mention, elsewhere in the draft, is a different token and is offered normally.
  assert.equal(fileMentionCompletionView('@ind @REA', 9, index(), [], dismissed).open, true)
})

test('an accepted reference does not immediately re-offer itself', () => {
  const accepted = acceptedFileMention(emptyFileMentionCompletion, file('README.md'))
  assert.equal(fileMentionCompletionView('@README.md', 10, index(), [], accepted).open, false)
})

test('the highlight can never point past a list that has since narrowed', () => {
  const view = fileMentionCompletionView('@index', 6, index(), [], { ...emptyFileMentionCompletion, highlight: 9 })
  assert.equal(view.activeIndex, view.matches.length - 1)
})

test('the picker names what it is not showing', () => {
  assert.equal(fileMentionExclusionNote(null), null)
  assert.match(fileMentionExclusionNote(index()) ?? '', /\.gitignore/)
  assert.match(fileMentionExclusionNote(index({ gitignored: false })) ?? '', /Not a git checkout/)
  assert.match(fileMentionExclusionNote(index({ truncated: true })) ?? '', /too large to list in full/)
})

test('recent paths are the agent-touched files under this root, newest first and deduplicated', () => {
  const recent = recentMentionPaths(
    [
      'D:\\Development\\ADE\\src\\main\\index.ts',
      'C:\\elsewhere\\other.ts',
      'D:/Development/ADE/README.md',
      'D:\\Development\\ADE\\src\\main\\index.ts'
    ],
    'D:\\Development\\ADE'
  )
  assert.deepEqual(recent, ['src/main/index.ts', 'README.md'])
})

test('recent paths are bounded, so a long conversation cannot dominate the whole menu', () => {
  const touched = Array.from({ length: 40 }, (_value, position) => `/repo/file-${position}.ts`)
  assert.equal(recentMentionPaths(touched, '/repo').length, 10)
})
