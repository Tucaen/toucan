import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { WebContents } from 'electron'
import { createWorkspaceContainment } from '../src/main/workspace-containment'
import { registerAgentIpc } from '../src/main/register-agent-ipc'
import { registerWorktreeIpc } from '../src/main/worktree-ipc'
import { registerWorkspaceFileIpc } from '../src/main/workspace-file-ipc'
import { registerGithubIssuesIpc } from '../src/main/github-issues-ipc'
import { openWebUrl } from '../src/main/open-web-url'
import type { AcpSessionManager } from '../src/main/acp-session-manager'
import type { WorktreeManager } from '../src/main/git-worktree'
import type { IpcEventRegistrar } from '../src/main/ipc-registrar'
import {
  AGENT_CHANNELS,
  WORKTREE_CHANNELS,
  WORKSPACE_CHANNELS,
  GITHUB_ISSUES_CHANNELS
} from '../src/shared/ipc-channels'
import { parseRemoteChatClientMessage } from '../src/shared/remote-chat'

function boundary() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipc: IpcEventRegistrar<WebContents> = {
    handle: (channel, listener) => {
      handlers.set(channel, (...args) => listener({ sender: {} as WebContents }, ...args))
    },
    on: (channel, listener) => {
      handlers.set(channel, (...args) => listener({ sender: {} as WebContents }, ...args))
    }
  }
  return { ipc, call: (channel: string, ...args: unknown[]) => handlers.get(channel)!(...args) }
}

test('agent IPC refuses malformed launches, outside grants, and malformed commands before dispatch', async () => {
  const { ipc, call } = boundary()
  const calls: string[] = []
  const manager = new Proxy(
    {},
    {
      get: (_target, key) => () => {
        calls.push(String(key))
        return { ok: true }
      }
    }
  ) as AcpSessionManager
  const root = join(tmpdir(), 'toucan-allowed')
  registerAgentIpc(ipc, manager, createWorkspaceContainment({ roots: () => [root] }))
  const valid = { id: 'node', provider: 'codex', cwd: root }
  for (const request of [
    null,
    [],
    {},
    { ...valid, provider: 'unknown' },
    { ...valid, cwd: tmpdir() },
    { ...valid, additionalDirectories: [tmpdir()] },
    { ...valid, additionalDirectories: 'bad' },
    { ...valid, sessionId: 5 },
    { ...valid, forkFromSessionId: {} },
    { ...valid, modelId: [] },
    { ...valid, sessionId: 's', forkFromSessionId: 'f' },
    { ...valid, routineDelegation: true },
    { ...valid, routineDelegation: { workerModelId: [] } },
    { ...valid, decisionDelegation: 'yes' }
  ])
    assert.equal(((await call(AGENT_CHANNELS.create, request)) as { ok: boolean }).ok, false)
  for (const channel of [
    'prompt',
    'promptWhenIdle',
    'setMode',
    'setModel',
    'setEffort',
    'authenticate',
    'submitAuthCode'
  ] as const) {
    await call(AGENT_CHANNELS[channel], {}, 'value')
    await call(AGENT_CHANNELS[channel], 'node', {})
  }
  await call(AGENT_CHANNELS.prompt, 'node', [{ type: 'image', data: 4, mimeType: 'image/png' }])
  await call(AGENT_CHANNELS.approval, 'node', 'approval', {})
  await call(AGENT_CHANNELS.elicitation, 'node', 'question', { answer: {} })
  await call(AGENT_CHANNELS.kill, {})
  await call(AGENT_CHANNELS.cancel, [])
  assert.deepEqual(calls, [])
  await call(AGENT_CHANNELS.create, { ...valid, additionalDirectories: [join(root, 'src')] })
  await call(AGENT_CHANNELS.prompt, 'node', [{ type: 'text', text: 'hello' }])
  assert.deepEqual(calls, ['create', 'prompt'])
})

test('every worktree operation refuses paths outside the workspace, including forced removal', async () => {
  const { ipc, call } = boundary()
  const calls: string[] = []
  const manager = new Proxy(
    {},
    {
      get: (_target, key) => () => {
        calls.push(String(key))
        return { ok: true }
      }
    }
  ) as WorktreeManager
  const root = join(tmpdir(), 'toucan-allowed')
  registerWorktreeIpc(ipc, manager, createWorkspaceContainment({ roots: () => [root] }))
  const request = {
    projectPath: tmpdir(),
    path: tmpdir(),
    branch: 'fix',
    baseRef: 'HEAD',
    force: true,
    known: [],
    file: { path: 'README.md', status: 'modified' }
  }
  for (const channel of Object.values(WORKTREE_CHANNELS)) {
    await call(
      channel,
      channel === WORKTREE_CHANNELS.currentBranch || channel === WORKTREE_CHANNELS.listBranches ? tmpdir() : request
    )
    await call(channel, null)
  }
  await call(WORKTREE_CHANNELS.remove, { ...request, projectPath: root })
  await call(WORKTREE_CHANNELS.remove, { ...request, projectPath: root, path: root, force: 'yes' })
  await call(WORKTREE_CHANNELS.diffFile, { ...request, path: root, file: { path: '../secret', status: 'untracked' } })
  await call(WORKTREE_CHANNELS.discover, { projectPath: root, known: [tmpdir()] })
  await call(WORKTREE_CHANNELS.diffFile, { ...request, path: root, file: { path: 'README.md', status: ['modified'] } })
  assert.deepEqual(calls, [])
  await call(WORKTREE_CHANNELS.create, { projectPath: root, branch: 'fix' })
  await call(WORKTREE_CHANNELS.checkoutBranch, { path: root, branch: 'fix' })
  assert.deepEqual(calls, ['create', 'checkoutBranch'])
})

test('file indexes and GitHub queries cannot name an outside checkout', async () => {
  const { ipc, call } = boundary()
  const containment = createWorkspaceContainment({ roots: () => [] })
  const unexpected = async (): Promise<never> => {
    throw new Error('must not dispatch')
  }
  registerWorkspaceFileIpc(ipc, { read: unexpected }, containment)
  registerGithubIssuesIpc(ipc, { availability: unexpected, list: unexpected }, containment)
  assert.deepEqual(((await call(WORKSPACE_CHANNELS.fileIndex, tmpdir())) as { entries: unknown[] }).entries, [])
  for (const channel of Object.values(GITHUB_ISSUES_CHANNELS))
    assert.equal(((await call(channel, tmpdir())) as { available: boolean }).available, false)
})

test('workspace gates reject relative paths and junction escapes, and accept registered worktrees', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'toucan-privilege-'))
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const project = join(directory, 'project')
  const worktree = join(directory, 'worktree')
  const outside = join(directory, 'outside')
  for (const path of [project, worktree, outside]) await mkdir(path)
  await symlink(outside, join(project, 'escape'), 'junction')
  const roots = [project, worktree]
  const containment = createWorkspaceContainment({ roots: () => roots })
  assert.equal(await containment.contains('relative/path'), false)
  assert.equal(await containment.contains(join(project, 'escape', 'new-file')), false)
  assert.equal(await containment.contains(worktree), true)
  roots.pop()
  assert.equal(await containment.contains(worktree), false)
})

test('only web URLs reach an external opener and remote approval ids are bounded', async () => {
  const opened: string[] = []
  const open = async (url: string) => {
    opened.push(url)
  }
  for (const url of ['file:///C:/secret', 'ms-msdt:launch', 'search-ms:query=x', 'javascript:alert(1)', 'bad', null])
    assert.equal(await openWebUrl(url, open), false)
  assert.deepEqual(opened, [])
  assert.equal(await openWebUrl('https://example.com/auth', open), true)
  assert.deepEqual(opened, ['https://example.com/auth'])
  const approval = { type: 'approval', requestId: 'r', approvalId: 'a' }
  for (const optionId of ['', 'x'.repeat(201), false])
    assert.equal(parseRemoteChatClientMessage(JSON.stringify({ ...approval, optionId })), null)
  assert.deepEqual(parseRemoteChatClientMessage(JSON.stringify(approval)), approval)
  assert.ok(parseRemoteChatClientMessage(JSON.stringify({ ...approval, optionId: 'allow_once' })))
})
