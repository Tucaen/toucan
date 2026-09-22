import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { WebContents } from 'electron'
import { createAcpSessionManager } from '../src/main/acp-session-manager'
import { installScriptedAdapter } from './helpers/scripted-adapter'

function replayingAdapter(appPath: string): void {
  installScriptedAdapter(appPath, 'claude-agent-acp', {
    handleRequest: `
  if (request.method !== 'session/load') return
  const sessionId = request.params.sessionId
  send({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId,
    update: {
      sessionUpdate: 'user_message_chunk',
      messageId: 'saved-user',
      content: { type: 'text', text: 'Persisted question' }
    }
  } })
  send({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'saved-progress',
      content: { type: 'text', text: 'Inspecting the saved workspace.' },
      _meta: { codex: { phase: 'commentary' } }
    }
  } })
  send({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'saved-assistant',
      content: { type: 'text', text: 'Persisted answer' },
      _meta: { codex: { phase: 'final_answer' } }
    }
  } })
  send({ jsonrpc: '2.0', id: request.id, result: {} })`
  })
}

function idlessReplayingAdapter(appPath: string): void {
  installScriptedAdapter(appPath, 'claude-agent-acp', {
    prelude: `
const update = (sessionId, sessionUpdate, text, phase) => send({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId,
    update: {
      sessionUpdate,
      content: { type: 'text', text },
      ...(phase ? { _meta: { codex: { phase } } } : {})
    }
  }
})`,
    handleRequest: `
  if (request.method !== 'session/load') return
  const sessionId = request.params.sessionId
  update(sessionId, 'user_message_chunk', 'First question')
  update(sessionId, 'agent_message_chunk', 'Inspecting ', 'commentary')
  update(sessionId, 'agent_message_chunk', 'the workspace.', 'commentary')
  update(sessionId, 'agent_message_chunk', 'First answer', 'final_answer')
  update(sessionId, 'user_message_chunk', 'Second question')
  update(sessionId, 'agent_message_chunk', 'Second answer', 'final_answer')
  send({ jsonrpc: '2.0', id: request.id, result: {} })`
  })
}

test('returns session/load transcript notifications atomically instead of streaming them separately', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-replay-adapter-'))
  replayingAdapter(appPath)
  const streamed: unknown[] = []
  const owner = {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => streamed.push({ channel, payload })
  } as unknown as WebContents
  const manager = createAcpSessionManager({ appPath })

  try {
    const result = await manager.create(
      {
        id: 'restored-node',
        provider: 'claude',
        cwd: appPath,
        sessionId: 'saved-conversation'
      },
      owner
    )

    assert.equal(result.status, 'ready')
    assert.equal(result.sessionId, 'saved-conversation')
    assert.deepEqual(result.replay, [
      {
        type: 'message',
        role: 'user',
        messageId: 'saved-user',
        text: 'Persisted question'
      },
      {
        type: 'message',
        role: 'assistant',
        presentation: 'progress',
        messageId: 'saved-progress',
        text: 'Inspecting the saved workspace.'
      },
      {
        type: 'message',
        role: 'assistant',
        presentation: 'final',
        messageId: 'saved-assistant',
        text: 'Persisted answer'
      }
    ])
    assert.equal(
      streamed.some((entry) => JSON.stringify(entry).includes('Persisted question')),
      false
    )
  } finally {
    manager.killAll()
  }
})

test('gives ID-less replay chunks stable identities without merging separate turns', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-idless-replay-adapter-'))
  idlessReplayingAdapter(appPath)
  const owner = {
    isDestroyed: () => false,
    send: () => {}
  } as unknown as WebContents
  const manager = createAcpSessionManager({ appPath })

  try {
    const result = await manager.create(
      {
        id: 'restored-idless-node',
        provider: 'claude',
        cwd: appPath,
        sessionId: 'saved-idless-conversation'
      },
      owner
    )

    assert.deepEqual(
      result.replay
        ?.filter((event) => event.type === 'message')
        .map((event) => ({
          role: event.role,
          messageId: event.messageId,
          presentation: event.presentation
        })),
      [
        { role: 'user', messageId: 'replay-user-1', presentation: undefined },
        { role: 'assistant', messageId: 'replay-assistant-2', presentation: 'progress' },
        { role: 'assistant', messageId: 'replay-assistant-2', presentation: 'progress' },
        { role: 'assistant', messageId: 'replay-assistant-3', presentation: 'final' },
        { role: 'user', messageId: 'replay-user-4', presentation: undefined },
        { role: 'assistant', messageId: 'replay-assistant-5', presentation: 'final' }
      ]
    )
  } finally {
    manager.killAll()
  }
})
