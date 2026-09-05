import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  describeFileReadFailure,
  describeFileWriteFailure,
  editStateAfterEdit,
  editStateAfterRead,
  editStateAfterRefusedSave,
  editStateAfterSave,
  fileEditability,
  fileNodeName,
  isDirty,
  joinWorkspacePath,
  keepDraftOverDisk,
  projectOwningPath,
  UNEDITED,
  type FileEditState
} from '../src/renderer/src/file-node'
import { defaultFileViewMode, fileViewPathIdentity, isMarkdownPath, type FileReadResult } from '../src/shared/file-view'

test('a picked relative path joins the root in the root’s own separator', () => {
  assert.equal(
    joinWorkspacePath('D:\\Development\\Toucan', 'docs/plans/tickets.md'),
    'D:\\Development\\Toucan\\docs\\plans\\tickets.md'
  )
  assert.equal(joinWorkspacePath('D:\\Development\\Toucan\\', 'README.md'), 'D:\\Development\\Toucan\\README.md')
  assert.equal(joinWorkspacePath('/home/me/toucan', 'src/main/index.ts'), '/home/me/toucan/src/main/index.ts')
})

test('the header shows the file name and the same file is recognised whatever its spelling', () => {
  assert.equal(fileNodeName('D:\\Development\\Toucan\\docs\\plan.md'), 'plan.md')
  assert.equal(fileNodeName('/home/me/notes.md'), 'notes.md')
  assert.equal(fileViewPathIdentity('D:\\Dev\\Plan.MD'), fileViewPathIdentity('d:/dev/plan.md'))
})

test('Markdown opens rendered, everything else raw', () => {
  assert.equal(isMarkdownPath('README.md'), true)
  assert.equal(isMarkdownPath('notes.MARKDOWN'), true)
  assert.equal(isMarkdownPath('index.ts'), false)
  assert.equal(defaultFileViewMode('docs/plan.md'), 'rendered')
  assert.equal(defaultFileViewMode('src/index.ts'), 'raw')
})

test('a file opened from a card is filed under the deepest root that contains it', () => {
  const roots = [
    { projectId: 'outer', root: 'D:\\Development' },
    { projectId: 'toucan', root: 'D:\\Development\\Toucan' },
    { projectId: 'toucan', root: 'D:\\Development\\Toucan-worktrees\\feature' },
    { projectId: 'other', root: 'D:\\Development\\Other' }
  ]
  assert.equal(projectOwningPath('D:\\Development\\Toucan\\docs\\plan.md', roots), 'toucan')
  assert.equal(projectOwningPath('d:/development/toucan-worktrees/feature/src/a.ts', roots), 'toucan')
  assert.equal(projectOwningPath('D:\\Development\\Other\\x.md', roots), 'other')
  assert.equal(projectOwningPath('D:\\Development\\readme.md', roots), 'outer')
  // A sibling that merely shares a prefix is not inside the root.
  assert.equal(projectOwningPath('D:\\Development\\Toucan-old\\x.md', roots.slice(1)), undefined)
  assert.equal(projectOwningPath('E:\\elsewhere\\x.md', roots), undefined)
})

test('every failure has words', () => {
  for (const reason of ['not-found', 'outside-workspace', 'directory', 'unreadable'] as const) {
    assert.ok(describeFileReadFailure(reason, 'EPERM').length > 0)
  }
  assert.equal(describeFileReadFailure('unreadable', 'EPERM: denied'), 'EPERM: denied')
  for (const reason of ['conflict', 'not-found', 'outside-workspace', 'directory', 'unwritable'] as const) {
    assert.ok(describeFileWriteFailure(reason, 'EPERM').length > 0)
  }
  assert.equal(describeFileWriteFailure('unwritable', 'EACCES: denied'), 'EACCES: denied')
})

/*
 * Editing (issue #148): the draft is the reader's only copy of their work, so a change on disk
 * never replaces it silently - it becomes a conflict the reader resolves - while the node's own
 * save, which the watcher also reports, is recognised by its mtime and changes nothing.
 */

const disk = (content: string, mtime: string): Extract<FileReadResult, { ok: true }> => ({
  ok: true,
  content,
  truncated: false,
  size: content.length,
  mtime,
  binary: false
})

test('without a draft every read is simply the new base', () => {
  const first = editStateAfterRead(UNEDITED, disk('a', 't1'))
  assert.deepEqual(first, { draft: null, baseMtime: 't1', conflict: false })
  assert.deepEqual(editStateAfterRead(first, disk('b', 't2')), { draft: null, baseMtime: 't2', conflict: false })
  assert.deepEqual(editStateAfterRead(first, { ok: false, reason: 'not-found', message: '' }), UNEDITED)
})

test('typing makes a draft based on the current read, and typing the file back is no edit', () => {
  const base = editStateAfterRead(UNEDITED, disk('a', 't1'))
  const edited = editStateAfterEdit(base, 'ab', { content: 'a', mtime: 't1' })
  assert.deepEqual(edited, { draft: 'ab', baseMtime: 't1', conflict: false })
  assert.equal(isDirty(edited), true)
  const restored = editStateAfterEdit(edited, 'a', { content: 'a', mtime: 't1' })
  assert.deepEqual(restored, { draft: null, baseMtime: 't1', conflict: false })
  assert.equal(isDirty(restored), false)
})

test('a read with the same mtime under a draft is the node’s own save; a different one is a conflict', () => {
  const edited = editStateAfterEdit(editStateAfterRead(UNEDITED, disk('a', 't1')), 'ab', { content: 'a', mtime: 't1' })
  assert.equal(editStateAfterRead(edited, disk('a', 't1')), edited)
  const conflict = editStateAfterRead(edited, disk('external', 't2'))
  assert.deepEqual(conflict, { draft: 'ab', baseMtime: 't1', conflict: true })
  // The file vanishing under a draft is a conflict too: the draft must not be lost.
  assert.deepEqual(editStateAfterRead(edited, { ok: false, reason: 'not-found', message: '' }), {
    draft: 'ab',
    baseMtime: 't1',
    conflict: true
  })
  // Further external writes do not reset a conflict the reader has yet to see.
  assert.equal(editStateAfterRead(conflict, disk('external 2', 't3')), conflict)
})

test('the reader resolves a conflict by keeping the draft (rebased) or by reloading; a save clears it', () => {
  const conflict: FileEditState = { draft: 'ab', baseMtime: 't1', conflict: true }
  assert.deepEqual(keepDraftOverDisk(conflict, disk('external', 't2')), {
    draft: 'ab',
    baseMtime: 't2',
    conflict: false
  })
  assert.deepEqual(editStateAfterRead(UNEDITED, disk('external', 't2')), {
    draft: null,
    baseMtime: 't2',
    conflict: false
  })
  assert.deepEqual(editStateAfterSave('t3', 'ab', 'ab'), { draft: null, baseMtime: 't3', conflict: false })
  assert.deepEqual(editStateAfterSave('t3', 'ab', null), { draft: null, baseMtime: 't3', conflict: false })
  // Typed while the write was in flight: a new draft on the saved file, not lost and not "saved".
  assert.deepEqual(editStateAfterSave('t3', 'ab', 'abc'), { draft: 'abc', baseMtime: 't3', conflict: false })
  const refused = editStateAfterRefusedSave({ draft: 'ab', baseMtime: 't1', conflict: false })
  assert.deepEqual(refused, { draft: 'ab', baseMtime: 't1', conflict: true })
  assert.equal(editStateAfterRefusedSave(refused), refused)
})

test('only a whole text file may be edited', () => {
  assert.deepEqual(fileEditability(disk('a', 't1')), { editable: true })
  assert.deepEqual(fileEditability(null), { editable: false, reason: 'unavailable' })
  assert.deepEqual(fileEditability({ ok: false, reason: 'not-found', message: '' }), {
    editable: false,
    reason: 'unavailable'
  })
  assert.deepEqual(fileEditability({ ...disk('', 't1'), binary: true }), { editable: false, reason: 'binary' })
  assert.deepEqual(fileEditability({ ...disk('head', 't1'), truncated: true }), {
    editable: false,
    reason: 'truncated'
  })
})
