import { equal, notEqual, ok } from 'node:assert/strict'
import { test } from 'node:test'
import { isAbsolutePath, pathIdentity } from '../src/shared/paths'

/**
 * "Are these two strings the same file?" is asked by the ticket board's attribution, the file
 * node's watcher and the brain-dump library's project association, and it has one answer. These
 * are the spellings one checkout genuinely reaches Toucan under, and the ones that only look alike.
 */

test('one checkout matches whatever drive casing and separators it arrived with', () => {
  const identity = pathIdentity('D:\\Development\\Toucan')
  equal(pathIdentity('d:/development/toucan'), identity)
  equal(pathIdentity('D:\\Development\\Toucan\\'), identity)
  equal(pathIdentity('D:/Development\\Toucan//'), identity)
})

test('a run of separators is one separator, whichever way they lean', () => {
  // An agent that joined a path by hand, or a tool that echoed one back, routinely doubles these;
  // `a//b` and `a/b` are the same file on both platforms, so they must read as one.
  equal(pathIdentity('D:\\\\Development\\\\Toucan'), pathIdentity('D:/Development/Toucan'))
  equal(pathIdentity('/home//morgan/notes.md'), pathIdentity('/home/morgan/notes.md'))
})

test('a UNC share keeps its leading pair, so it cannot collide with an absolute path', () => {
  equal(pathIdentity('\\\\build\\share\\Toucan'), '//build/share/toucan')
  notEqual(pathIdentity('\\\\build\\share\\Toucan'), pathIdentity('/build/share/Toucan'))
})

test('the locale is pinned, so a Turkish host still matches a drive letter', () => {
  // `'I'.toLowerCase()` is 'ı' under a Turkish default locale, which would split one checkout in
  // two depending on where Toucan happens to be running.
  equal(pathIdentity('I:\\Inbox'), 'i:/inbox')
})

test('it compares, and does not resolve: `..` is left exactly where it was written', () => {
  // Callers that need `..` resolved layer `node:path` over this (see `brain-dump-capture.ts`), and
  // callers deciding whether a path is *inside* a root use `createWorkspaceContainment` instead -
  // this function must never be mistaken for that check.
  notEqual(pathIdentity('D:/Development/Toucan/../Toucan'), pathIdentity('D:/Development/Toucan'))
})

test('absolute covers both flavours and neither is confused for a relative path', () => {
  ok(isAbsolutePath('D:\\Development'))
  ok(isAbsolutePath('/home/morgan'))
  ok(isAbsolutePath('\\\\build\\share'))
  ok(!isAbsolutePath('docs/tickets/to-tickets.md'))
})
