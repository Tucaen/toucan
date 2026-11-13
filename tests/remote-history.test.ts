import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test, vi } from 'vitest'
import { createConversationHistory, claudeConversationTranscriptPath } from '../src/main/conversation-history'
import { createRemoteHistory } from '../src/main/remote/remote-history'
import { parseRemoteHistoryOpen } from '../src/shared/remote-history'
import type { WorkspaceState } from '../src/shared/workspace'
import type { RemoteChatSpawnResult } from '../src/shared/remote-spawn'
import type { HistoryRestoreRequest } from '../src/shared/remote-history'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'toucan-remote-history-'))
  roots.push(home)
  const project = join(home, 'project')
  const worktree = join(home, 'worktree')
  mkdirSync(project)
  mkdirSync(worktree)
  const state: WorkspaceState = {
    version: 3,
    activeProjectId: 'p1',
    sidebarCollapsed: false,
    nodes: [],
    projects: [{ id: 'p1', name: 'Project', color: '#71a9ff', path: project }],
    worktrees: [
      {
        id: 'w1',
        projectId: 'p1',
        path: worktree,
        branch: 'feature',
        baseRef: 'main',
        createdAt: '',
        position: { x: 0, y: 0 },
        width: 1000,
        height: 800
      }
    ]
  }
  const claudePath = claudeConversationTranscriptPath(home, {}, project, 'claude-old')
  mkdirSync(dirname(claudePath), { recursive: true })
  writeFileSync(
    claudePath,
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix the parser' } }) +
      '\n' +
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'SECRET RESPONSE BODY' } })
  )
  const codexDir = join(home, '.codex', 'sessions', '2026', '11', '13')
  mkdirSync(codexDir, { recursive: true })
  writeFileSync(
    join(codexDir, 'rollout.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { id: 'codex-old', cwd: worktree } }) +
      '\n' +
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Resume feature' }] }
      })
  )
  const restored: HistoryRestoreRequest[] = []
  const restore = vi.fn(async (request: HistoryRestoreRequest): Promise<RemoteChatSpawnResult> => {
    restored.push(request)
    return { ok: true, chatId: 'restored-node' }
  })
  const history = createConversationHistory({ homeDirectory: home, environment: {} })
  const remote = createRemoteHistory({ history, workspace: async () => state, restore })
  return { home, project, worktree, state, restore, restored, remote, history, claudePath }
}

test('real discovery lists both providers with labels, without transcript paths, cwd or bodies', async () => {
  const { remote, project, worktree, restore, restored } = harness()
  const page = await remote.list('p1', 0)
  assert.equal(page.total, 2)
  assert.equal(page.nextOffset, 25)
  assert.deepEqual(page.entries.map((entry) => entry.provider).sort(), ['claude', 'codex'])
  assert.equal(page.entries.find((entry) => entry.provider === 'codex')!.directoryLabel, 'feature')
  const listed = JSON.stringify(page)
  assert.ok(!listed.includes(project))
  assert.ok(!listed.includes('.jsonl'))
  assert.ok(!listed.includes('SECRET RESPONSE BODY'))
  const entry = page.entries.find((item) => item.provider === 'codex')!
  assert.deepEqual(await remote.open({ projectId: 'p1', key: entry.key }), { ok: true, chatId: 'restored-node' })
  assert.equal(restore.mock.calls.length, 1)
  assert.equal(restored[0].entry.id, 'codex-old')
  assert.equal(restored[0].entry.provider, 'codex')
  assert.equal(restored[0].entry.cwd, worktree)
})

test('concurrent handles for one provider conversation share one restore', async () => {
  const { remote, restore } = harness()
  let settle!: (value: RemoteChatSpawnResult) => void
  restore.mockImplementation(
    () =>
      new Promise((resolve) => {
        settle = resolve
      })
  )
  const key = (await remote.list('p1', 0)).entries[0].key
  const first = remote.open({ projectId: 'p1', key })
  const second = remote.open({ projectId: 'p1', key })
  await vi.waitFor(() => assert.equal(restore.mock.calls.length, 1))
  settle({ ok: true, chatId: 'only-node' })
  assert.deepEqual(await Promise.all([first, second]), [
    { ok: true, chatId: 'only-node' },
    { ok: true, chatId: 'only-node' }
  ])
})

test('removed projects, worktrees, missing folders and deleted transcripts never fall back to the checkout', async () => {
  const { remote, state, worktree, restore, claudePath } = harness()
  const page = await remote.list('p1', 0)
  const codex = page.entries.find((entry) => entry.provider === 'codex')!
  const claude = page.entries.find((entry) => entry.provider === 'claude')!
  state.worktrees[0].unavailable = true
  assert.equal((await remote.open({ projectId: 'p1', key: codex.key })).ok, false)
  state.worktrees[0].unavailable = false
  rmSync(worktree, { recursive: true })
  assert.equal((await remote.open({ projectId: 'p1', key: codex.key })).ok, false)
  state.worktrees = []
  assert.equal((await remote.open({ projectId: 'p1', key: codex.key })).ok, false)
  rmSync(claudePath)
  const missing = await remote.open({ projectId: 'p1', key: claude.key })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.match(missing.message, /no longer on disk/)
  state.projects = []
  assert.equal((await remote.open({ projectId: 'p1', key: claude.key })).ok, false)
  assert.equal(restore.mock.calls.length, 0)
})

test('unknown handles, cross-project handles and access revoked during discovery cannot restore', async () => {
  const { remote, history, restore } = harness()
  const key = (await remote.list('p1', 0)).entries[0].key
  assert.equal((await remote.open({ projectId: 'p1', key: 'not-issued' })).ok, false)
  assert.equal((await remote.open({ projectId: 'p2', key })).ok, false)
  let permitted = true
  vi.spyOn(history, 'exists').mockImplementation(async () => {
    permitted = false
    return true
  })
  assert.equal((await remote.open({ projectId: 'p1', key }, () => permitted)).ok, false)
  assert.equal(restore.mock.calls.length, 0)
})

test('paging advances past candidates that vanish while the page is read; listing failures propagate', async () => {
  const { remote, history } = harness()
  vi.spyOn(history, 'list').mockResolvedValueOnce({ entries: [], total: 30, hasMore: true })
  assert.deepEqual(await remote.list('p1', 0), { entries: [], total: 30, hasMore: true, nextOffset: 25 })
  vi.spyOn(history, 'list').mockRejectedValueOnce(new Error('unreadable'))
  await assert.rejects(remote.list('p1', 25), /unreadable/)
})

test('the phone can send only bounded identifiers, never paths or provider launch data', () => {
  assert.deepEqual(parseRemoteHistoryOpen('{"projectId":"p1","key":"entry-1"}'), { projectId: 'p1', key: 'entry-1' })
  for (const value of [
    null,
    [],
    {},
    { projectId: '../project', key: 'k' },
    { projectId: 'p1', key: 'x'.repeat(129) },
    { projectId: 'p1', key: 'k', cwd: 'D:/elsewhere' },
    { projectId: 'p1', key: 'k', provider: 'codex' }
  ])
    assert.equal(parseRemoteHistoryOpen(JSON.stringify(value)), null)
})
