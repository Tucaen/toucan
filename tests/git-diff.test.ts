import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  changedFilesFromGit,
  parseNameStatus,
  parseNumstat,
  parseUnifiedDiff,
  parseUntrackedPaths
} from '../src/shared/git-diff'

/*
 * The diff node (issue #144) reads git's machine formats - `-z` separated name-status, numstat
 * and porcelain status, plus a unified diff - and these parsers are the only place those shapes
 * are known. Every fixture here is git's actual output, captured with `tr '\0' '|'`.
 */

const NUL = '\0'

test('name-status lists each changed file with its status and, for renames, its old path', () => {
  const stdout = [
    'R050',
    'a.txt',
    'b.txt',
    'M',
    'src/main.ts',
    'A',
    'docs/new.md',
    'D',
    'old.txt',
    'T',
    'link',
    ''
  ].join(NUL)
  assert.deepEqual(parseNameStatus(stdout), [
    { path: 'b.txt', status: 'renamed', oldPath: 'a.txt' },
    { path: 'src/main.ts', status: 'modified' },
    { path: 'docs/new.md', status: 'added' },
    { path: 'old.txt', status: 'deleted' },
    { path: 'link', status: 'type-changed' }
  ])
  assert.deepEqual(parseNameStatus(''), [])
})

test('numstat pairs line counts with paths, marks binary files and follows renames', () => {
  const stdout = ['1\t0\t', 'a.txt', 'b.txt', '-\t-\tbin.dat', '23\t1\tsrc/main.ts', ''].join(NUL)
  const counts = parseNumstat(stdout)
  assert.deepEqual(counts.get('b.txt'), { added: 1, deleted: 0, binary: false })
  assert.deepEqual(counts.get('bin.dat'), { added: 0, deleted: 0, binary: true })
  assert.deepEqual(counts.get('src/main.ts'), { added: 23, deleted: 1, binary: false })
  assert.equal(counts.has('a.txt'), false)
})

test('porcelain status yields only untracked paths and skips the second field of a rename', () => {
  const stdout = ['RM b.txt', 'a.txt', ' M bin.dat', '?? c.txt', '?? dir/d.txt', ''].join(NUL)
  assert.deepEqual(parseUntrackedPaths(stdout), ['c.txt', 'dir/d.txt'])
})

test('the file list merges tracked changes with counts and appends untracked files, sorted by path', () => {
  const files = changedFilesFromGit({
    nameStatus: ['M', 'src/z.ts', 'R100', 'a.txt', 'b.txt', ''].join(NUL),
    numstat: ['4\t2\tsrc/z.ts', '0\t0\t', 'a.txt', 'b.txt', ''].join(NUL),
    status: ['?? new.md', ' M src/z.ts', ''].join(NUL)
  })
  assert.deepEqual(files, [
    { path: 'b.txt', status: 'renamed', oldPath: 'a.txt', added: 0, deleted: 0, binary: false },
    { path: 'new.md', status: 'untracked' },
    { path: 'src/z.ts', status: 'modified', added: 4, deleted: 2, binary: false }
  ])
  assert.deepEqual(changedFilesFromGit({ nameStatus: '', numstat: '', status: '' }), [])
})

test('a unified diff becomes hunks with line kinds and the numbers its headers declare', () => {
  const diff = [
    'diff --git a/a.txt b/b.txt',
    'similarity index 50%',
    'rename from a.txt',
    'rename to b.txt',
    'index 5626abf..814f4a4 100644',
    '--- a/a.txt',
    '+++ b/b.txt',
    '@@ -1 +1,2 @@',
    ' one',
    '+two',
    '@@ -10,3 +11,2 @@ function main() {',
    ' keep',
    '-gone',
    '\\ No newline at end of file',
    ' tail',
    ''
  ].join('\n')
  const parsed = parseUnifiedDiff(diff)
  assert.equal(parsed.binary, false)
  assert.equal(parsed.hunks.length, 2)
  assert.deepEqual(parsed.hunks[0], {
    header: '@@ -1 +1,2 @@',
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 2,
    lines: [
      { kind: 'context', text: 'one' },
      { kind: 'added', text: 'two' }
    ]
  })
  assert.equal(parsed.hunks[1].header, '@@ -10,3 +11,2 @@ function main() {')
  assert.equal(parsed.hunks[1].oldStart, 10)
  assert.equal(parsed.hunks[1].newStart, 11)
  // The "no newline" marker is git's note about the file, not a line of it.
  assert.deepEqual(
    parsed.hunks[1].lines.map((line) => line.kind),
    ['context', 'removed', 'context']
  )
})

test('binary files and empty diffs produce no hunks', () => {
  const binary = parseUnifiedDiff(
    'diff --git a/bin.dat b/bin.dat\nindex 8352675..85025d9 100644\nBinary files a/bin.dat and b/bin.dat differ\n'
  )
  assert.equal(binary.binary, true)
  assert.deepEqual(binary.hunks, [])

  const empty = parseUnifiedDiff('')
  assert.equal(empty.binary, false)
  assert.deepEqual(empty.hunks, [])
})

test('a hunk header with a zero-length side still counts its lines', () => {
  const parsed = parseUnifiedDiff('--- /dev/null\n+++ b/c.txt\n@@ -0,0 +1 @@\n+new\n')
  assert.deepEqual(parsed.hunks[0], {
    header: '@@ -0,0 +1 @@',
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: 1,
    lines: [{ kind: 'added', text: 'new' }]
  })
})
