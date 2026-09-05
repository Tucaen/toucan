import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  describeFileReadFailure,
  fileNodeName,
  joinWorkspacePath,
  projectOwningPath,
  rawFileLines
} from '../src/renderer/src/file-node'
import { defaultFileViewMode, fileViewPathIdentity, isMarkdownPath } from '../src/shared/file-view'

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

test('raw lines drop only the trailing newline, and every failure has words', () => {
  assert.deepEqual(rawFileLines('a\nb\n'), ['a', 'b'])
  assert.deepEqual(rawFileLines('a\r\nb'), ['a', 'b'])
  assert.deepEqual(rawFileLines(''), [''])
  assert.deepEqual(rawFileLines('a\n\n'), ['a', ''])
  for (const reason of ['not-found', 'outside-workspace', 'directory', 'unreadable'] as const) {
    assert.ok(describeFileReadFailure(reason, 'EPERM').length > 0)
  }
  assert.equal(describeFileReadFailure('unreadable', 'EPERM: denied'), 'EPERM: denied')
})
