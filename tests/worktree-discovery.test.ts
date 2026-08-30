import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { discoverWorktrees, parseWorktreeList, type WorktreeClaim } from '../src/shared/worktree'

const PROJECT = 'D:\\Development\\ADE'
const FEATURE = 'D:\\Development\\ADE-worktrees\\feat-login'

const porcelain = [
  `worktree ${PROJECT}`,
  'HEAD abc123',
  'branch refs/heads/main',
  '',
  `worktree ${FEATURE}`,
  'HEAD def456',
  'branch refs/heads/feat/login',
  ''
].join('\n')

test('the first block of the porcelain listing is the project checkout, not a worktree', () => {
  const entries = parseWorktreeList(porcelain)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].isMain, true)
  assert.equal(entries[0].branch, 'main')
  assert.equal(entries[1].isMain, false)
  assert.equal(entries[1].branch, 'feat/login')
  assert.equal(entries[1].path, FEATURE)
})

test('a detached worktree reports no branch rather than a guessed one', () => {
  const entries = parseWorktreeList([
    `worktree ${PROJECT}`,
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    `worktree ${FEATURE}`,
    'HEAD def456',
    'detached',
    ''
  ].join('\n'))
  assert.equal(entries[1].branch, '')
})

test('a worktree git knows about and the workspace does not becomes a discovery', () => {
  const discovered = discoverWorktrees(parseWorktreeList(porcelain), [], [], 'main')
  assert.equal(discovered.length, 1)
  assert.equal(discovered[0].path, FEATURE)
  assert.equal(discovered[0].branch, 'feat/login')
  assert.equal(discovered[0].baseRef, 'main')
})

test('the project checkout is never discovered as a worktree', () => {
  const discovered = discoverWorktrees(parseWorktreeList(porcelain), [], [], 'main')
  assert.equal(discovered.some((worktree) => worktree.path === PROJECT), false)
})

test('a worktree the workspace already records is left alone', () => {
  const discovered = discoverWorktrees(parseWorktreeList(porcelain), [{ path: FEATURE }], [], 'main')
  assert.deepEqual(discovered, [])
})

test('a recorded path matches whatever slash and case shape git reports', () => {
  const discovered = discoverWorktrees(
    parseWorktreeList(porcelain),
    [{ path: 'd:/development/ade-worktrees/feat-login/' }],
    [],
    'main'
  )
  assert.deepEqual(discovered, [])
})

test('a detached worktree is skipped: there is no branch for the record to own', () => {
  const entries = parseWorktreeList([
    `worktree ${PROJECT}`,
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    `worktree ${FEATURE}`,
    'HEAD def456',
    'detached',
    ''
  ].join('\n'))
  assert.deepEqual(discoverWorktrees(entries, [], [], 'main'), [])
})

test('a claim on the discovered path names the node that asked for the work', () => {
  const claims: WorktreeClaim[] = [
    { nodeId: 'node-7', path: FEATURE, branch: 'feat/login', claimedAt: '2026-08-30T10:00:00.000Z' }
  ]
  const discovered = discoverWorktrees(parseWorktreeList(porcelain), [], claims, 'main')
  assert.equal(discovered[0].claimedByNodeId, 'node-7')
})

test('a claim for some other path costs the association, not the discovery', () => {
  const claims: WorktreeClaim[] = [
    { nodeId: 'node-7', path: 'D:\\elsewhere', branch: 'feat/other', claimedAt: '2026-08-30T10:00:00.000Z' }
  ]
  const discovered = discoverWorktrees(parseWorktreeList(porcelain), [], claims, 'main')
  assert.equal(discovered.length, 1)
  assert.equal(discovered[0].claimedByNodeId, undefined)
})

test('a listing with no worktrees beyond the checkout discovers nothing', () => {
  const entries = parseWorktreeList([`worktree ${PROJECT}`, 'HEAD abc123', 'branch refs/heads/main', ''].join('\n'))
  assert.deepEqual(discoverWorktrees(entries, [], [], 'main'), [])
})
