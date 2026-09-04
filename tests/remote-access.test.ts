import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import {
  REMOTE_ACCESS_DEFAULT_PORT,
  deriveRemoteWorkspaceProjection,
  remoteAccessPortProblem,
  type RemoteChatSummary,
  type RemoteWorkspaceSource
} from '../src/shared/remote-access'
import { recordAttention, type AttentionState } from '../src/shared/attention'
import type { TerminalNodeStatus, WorkspaceTerminalNode } from '../src/shared/terminal'
import { createRemoteAccessStore } from '../src/main/remote/remote-access-store'
import { pairingTokenMatches, presentedPairingToken } from '../src/main/remote/pairing'
import {
  clientContentType,
  resolveClientAsset,
  resolveRemoteRoute,
  routeRequiresPairing
} from '../src/main/remote/remote-routes'
import { describeHostAddresses, isTailscaleAddress } from '../src/main/remote/host-addresses'
import { chatNeedsApproval, countActiveChats, groupChatsByProject, isAwaitingDesktop } from '../mobile/src/chat-list'

/**
 * The decisions behind remote access, away from any socket: what a phone is allowed to see, what
 * counts as a valid port, what a presented token has to look like, and what a request resolves to.
 * `tests/remote-server.test.ts` exercises the same rules over a real listener.
 */

const temporaryDirectories: string[] = []

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-remote-'))
  temporaryDirectories.push(directory)
  return directory
}

function node(
  overrides: Partial<WorkspaceTerminalNode> & Pick<WorkspaceTerminalNode, 'id' | 'kind'>
): WorkspaceTerminalNode {
  return {
    label: overrides.id,
    projectId: 'toucan',
    position: { x: 0, y: 0 },
    width: 520,
    height: 340,
    ...overrides
  }
}

function source(overrides: Partial<RemoteWorkspaceSource> = {}): RemoteWorkspaceSource {
  return {
    projects: [{ id: 'toucan', name: 'Toucan', path: 'D:\\Development\\Toucan', color: '#71a9ff' }],
    nodes: [],
    ...overrides
  }
}

describe('workspace projection', () => {
  test('lists agent chats with their live status and leaves plain terminals out', () => {
    const projection = deriveRemoteWorkspaceProjection(
      source({
        nodes: [
          node({ id: 'chat-1', kind: 'claude', label: 'Fix the parser' }),
          node({ id: 'shell-1', kind: 'terminal', label: 'pwsh' }),
          node({ id: 'chat-2', kind: 'codex', label: 'Write the plan' })
        ]
      }),
      { 'chat-1': 'working', 'shell-1': 'idle' }
    )

    assert.deepEqual(
      projection.chats.map((chat) => [chat.id, chat.kind, chat.status]),
      [
        ['chat-1', 'claude', 'working'],
        // Nothing has reported on chat-2, and claiming it is starting would be a guess.
        ['chat-2', 'codex', 'dormant']
      ]
    )
    assert.deepEqual(projection.projects, [{ id: 'toucan', name: 'Toucan', color: '#71a9ff' }])
  })

  test('carries the unread count and the most blocking unread kind', () => {
    let attention: AttentionState = []
    attention = recordAttention(attention, { nodeId: 'chat-1', kind: 'result', key: 'turn-1', at: 1_000 })
    attention = recordAttention(attention, { nodeId: 'chat-1', kind: 'approval', key: 'req-9', at: 2_000 })

    const projection = deriveRemoteWorkspaceProjection(
      source({ nodes: [node({ id: 'chat-1', kind: 'claude' })], attention }),
      { 'chat-1': 'attention' }
    )

    assert.equal(projection.chats[0]?.unread, 2)
    assert.equal(projection.chats[0]?.attention, 'approval')
  })

  test('drops a chat whose project the snapshot does not name', () => {
    const projection = deriveRemoteWorkspaceProjection(
      source({ nodes: [node({ id: 'chat-1', kind: 'claude', projectId: 'gone' })] }),
      {}
    )
    assert.deepEqual(projection.chats, [])
  })

  test('groups by project for the phone and skips empty projects', () => {
    const snapshot = {
      updatedAt: 5_000,
      projects: [
        { id: 'toucan', name: 'Toucan', color: '#71a9ff' },
        { id: 'other', name: 'Other', color: '#ff8a71' }
      ],
      chats: [
        {
          id: 'a',
          kind: 'claude' as const,
          title: 'A',
          projectId: 'toucan',
          status: 'idle' as TerminalNodeStatus,
          unread: 2
        },
        {
          id: 'b',
          kind: 'codex' as const,
          title: 'B',
          projectId: 'toucan',
          status: 'working' as TerminalNodeStatus,
          unread: 0
        }
      ]
    }

    const groups = groupChatsByProject(snapshot)
    assert.equal(groups.length, 1)
    assert.equal(groups[0].project.id, 'toucan')
    assert.equal(groups[0].unread, 2)
    assert.equal(groups[0].approvals, 0)
    // A projection the host has stamped is never called stale, however long the canvas has been
    // idle; only one that has never arrived is.
    assert.equal(isAwaitingDesktop(snapshot), false)
    assert.equal(isAwaitingDesktop({ ...snapshot, updatedAt: 0 }), true)
  })

  test('a chat parked on a request badges as needing approval, distinctly from ordinary unread', () => {
    const chat = (id: string, extra: Partial<RemoteChatSummary>): RemoteChatSummary => ({
      id,
      kind: 'claude',
      title: id,
      projectId: 'toucan',
      status: 'working',
      unread: 0,
      ...extra
    })
    const snapshot = {
      updatedAt: 5_000,
      projects: [{ id: 'toucan', name: 'Toucan', color: '#71a9ff' }],
      chats: [
        chat('parked', { unread: 1, attention: 'approval' }),
        // Unread for another reason entirely: a finished turn is not a stalled chat.
        chat('finished', { status: 'result', unread: 3, attention: 'result' }),
        chat('quiet', {})
      ]
    }

    assert.equal(chatNeedsApproval(snapshot.chats[0]), true)
    assert.equal(chatNeedsApproval(snapshot.chats[1]), false)
    assert.equal(chatNeedsApproval(snapshot.chats[2]), false)
    // The counts stay separate: four unread records, but only one chat a tap can unblock.
    assert.deepEqual(countActiveChats(snapshot), { working: 2, unread: 4, approvals: 1 })
    assert.equal(groupChatsByProject(snapshot)[0].approvals, 1)
  })
})

describe('settings', () => {
  test('refuses ports Toucan could not bind as the user', () => {
    assert.equal(remoteAccessPortProblem(REMOTE_ACCESS_DEFAULT_PORT), null)
    assert.equal(remoteAccessPortProblem(1024), null)
    assert.match(remoteAccessPortProblem(80) ?? '', /1024 or higher/)
    assert.match(remoteAccessPortProblem(70_000) ?? '', /65535 or lower/)
    assert.match(remoteAccessPortProblem(8080.5) ?? '', /whole number/)
  })

  test('a fresh store is off by default and already has a token', () => {
    const store = createRemoteAccessStore({ path: join(temporaryDirectory(), 'remote-access.json') })
    const record = store.read()
    assert.equal(record.settings.enabled, false)
    assert.equal(record.settings.port, REMOTE_ACCESS_DEFAULT_PORT)
    assert.ok(record.token.length >= 32)
  })

  test('settings and token survive a restart, and a rejected port is not persisted', () => {
    const path = join(temporaryDirectory(), 'remote-access.json')
    const store = createRemoteAccessStore({ path })
    const token = store.read().token
    store.saveSettings({ enabled: true, port: 7500 })
    store.saveSettings({ enabled: true, port: 80 })

    const reopened = createRemoteAccessStore({ path })
    assert.deepEqual(reopened.read().settings, { enabled: true, port: 7500 })
    assert.equal(reopened.read().token, token)
  })

  test('a damaged file becomes a fresh install with a new token, never an open door', () => {
    const path = join(temporaryDirectory(), 'remote-access.json')
    writeFileSync(path, '{ "version": 1, "settings": { "enabled": true, "port": 7500 }, "token": "x" }', 'utf8')
    const store = createRemoteAccessStore({ path })
    assert.equal(store.read().settings.enabled, false)
    assert.ok(store.read().token.length >= 32)
  })

  test('regenerating replaces the stored token', () => {
    const path = join(temporaryDirectory(), 'remote-access.json')
    const store = createRemoteAccessStore({ path })
    const before = store.read().token
    const after = store.regenerateToken().token
    assert.notEqual(before, after)
    assert.match(readFileSync(path, 'utf8'), new RegExp(after.replace(/[-_]/g, '.')))
  })
})

describe('pairing', () => {
  test('only a bearer header presents a token', () => {
    assert.equal(presentedPairingToken({ authorization: 'Bearer abc123' }), 'abc123')
    assert.equal(presentedPairingToken({ authorization: '  Bearer   abc123  ' }), 'abc123')
    assert.equal(presentedPairingToken({}), null)
    assert.equal(presentedPairingToken({ authorization: 'abc123' }), null)
    assert.equal(presentedPairingToken({ authorization: 'Basic abc123' }), null)
  })

  test('comparison rejects a wrong token, a wrong length, and an absent one', () => {
    assert.equal(pairingTokenMatches('secret-token', 'secret-token'), true)
    assert.equal(pairingTokenMatches('secret-token', 'secret-tokes'), false)
    assert.equal(pairingTokenMatches('secret-token', 'secret'), false)
    assert.equal(pairingTokenMatches('secret-token', null), false)
    assert.equal(pairingTokenMatches('', ''), false)
  })
})

describe('routing', () => {
  test('api routes require pairing and the client bundle does not', () => {
    assert.deepEqual(resolveRemoteRoute('GET', '/api/workspace'), { kind: 'workspace' })
    assert.equal(routeRequiresPairing(resolveRemoteRoute('GET', '/api/workspace')), true)
    assert.equal(routeRequiresPairing(resolveRemoteRoute('GET', '/api/pairing')), true)
    // The pairing screen has to load before a token exists, so the bundle itself is public.
    assert.equal(routeRequiresPairing(resolveRemoteRoute('GET', '/')), false)
    assert.deepEqual(resolveRemoteRoute('GET', '/assets/app.js'), { kind: 'client', pathname: '/assets/app.js' })
    assert.deepEqual(resolveRemoteRoute('GET', '/api/chats/1'), { kind: 'not-found' })
    assert.deepEqual(resolveRemoteRoute('POST', '/api/workspace'), { kind: 'method-not-allowed', allow: 'GET, HEAD' })
    assert.deepEqual(resolveRemoteRoute('GET', undefined), { kind: 'not-found' })
  })

  test('starting a chat is a POST-only route, and it is behind the same gate', () => {
    assert.deepEqual(resolveRemoteRoute('POST', '/api/chats'), { kind: 'create-chat' })
    assert.equal(routeRequiresPairing(resolveRemoteRoute('POST', '/api/chats')), true)
    // The collection is not readable: what chats exist is the workspace projection's answer, and
    // `Allow` names the method this path really takes rather than the server's usual pair.
    assert.deepEqual(resolveRemoteRoute('GET', '/api/chats'), { kind: 'method-not-allowed', allow: 'POST' })
  })

  test('a query string never carries a route decision', () => {
    assert.deepEqual(resolveRemoteRoute('GET', '/api/workspace?token=leaked'), { kind: 'workspace' })
  })

  test('client paths cannot escape the build directory', () => {
    const root = join('C:', 'app', 'out', 'mobile')
    assert.equal(resolveClientAsset(root, '/'), join(root, 'index.html'))
    assert.equal(resolveClientAsset(root, '/assets/app.js'), join(root, 'assets', 'app.js'))
    assert.equal(resolveClientAsset(root, '/../../secrets.txt'), null)
    assert.equal(resolveClientAsset(root, '/assets/../../../secrets.txt'), null)
  })

  test('content types cover the client bundle and default to bytes', () => {
    assert.equal(clientContentType('index.html'), 'text/html; charset=utf-8')
    assert.equal(clientContentType('app.JS'), 'text/javascript; charset=utf-8')
    assert.equal(clientContentType('mystery.bin'), 'application/octet-stream')
  })
})

describe('host addresses', () => {
  test('tailnet addresses are labelled and offered first', () => {
    assert.equal(isTailscaleAddress('100.101.102.103'), true)
    assert.equal(isTailscaleAddress('100.200.0.1'), false)
    assert.equal(isTailscaleAddress('192.168.1.5'), false)

    assert.deepEqual(
      describeHostAddresses({
        Ethernet: [{ address: '192.168.1.5', family: 'IPv4', internal: false } as never],
        Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
        Tailscale: [{ address: '100.90.80.70', family: 'IPv4', internal: false } as never]
      }),
      [
        { kind: 'tailscale', host: '100.90.80.70' },
        { kind: 'local', host: '192.168.1.5' }
      ]
    )
  })
})
