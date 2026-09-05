import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { describeFileReadFailure, fileNodeName, joinWorkspacePath, rawFileLines } from '../src/renderer/src/file-node'
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
