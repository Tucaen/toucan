import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { WebContents } from 'electron'
import {
  createAcpSessionManager,
  imageCapabilityGuard,
  promptText,
  toPromptBlocks
} from '../src/main/acp-session-manager'

/** Replays one assistant message whose picture arrives as a second, `image`-content chunk. */
function imageReplayingAdapter(appPath: string): void {
  const directory = join(appPath, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist')
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'index.js'),
    `
const readline = require('node:readline')
const lines = readline.createInterface({ input: process.stdin })
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: []
    } })
  } else if (request.method === 'session/load') {
    const sessionId = request.params.sessionId
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'saved-answer',
      content: { type: 'text', text: 'Here is the comparison.' }
    } } })
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'saved-answer',
      content: { type: 'image', data: 'Zmlyc3Q=', mimeType: 'image/png' }
    } } })
    send({ jsonrpc: '2.0', id: request.id, result: {} })
  }
})
`,
    'utf8'
  )
}

test('toPromptBlocks wraps a plain-text submission in a single text content block', () => {
  assert.deepEqual(toPromptBlocks('hello there'), [{ type: 'text', text: 'hello there' }])
})

test('toPromptBlocks passes an explicit content-block array through unchanged, text and image together', () => {
  const blocks = [
    { type: 'text' as const, text: 'look at this' },
    { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' }
  ]
  assert.deepEqual(toPromptBlocks(blocks), blocks)
})

test('imageCapabilityGuard allows a text-only submission even when the agent has no image support', () => {
  const running = { imageSupport: false }
  const blocks = toPromptBlocks('just text')
  assert.equal(imageCapabilityGuard(running, blocks), null)
})

test('imageCapabilityGuard allows an image submission once the agent has advertised image support', () => {
  const running = { imageSupport: true }
  const blocks = toPromptBlocks([
    { type: 'text', text: 'a screenshot' },
    { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }
  ])
  assert.equal(imageCapabilityGuard(running, blocks), null)
})

test('imageCapabilityGuard rejects an image submission when the agent never advertised promptCapabilities.image', () => {
  const running = { imageSupport: false }
  const blocks = toPromptBlocks([
    { type: 'text', text: 'a screenshot' },
    { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }
  ])
  const guard = imageCapabilityGuard(running, blocks)
  assert.deepEqual(guard, { ok: false, message: 'This agent does not support image attachments.' })
})

test('promptText is the text a host-authored user message carries: text blocks only, never image bytes', () => {
  assert.equal(promptText('hello there'), 'hello there')
  assert.equal(
    promptText([
      { type: 'text', text: 'look at this' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }
    ]),
    'look at this'
  )
  // An image-only prompt has nothing a host without the bytes could show; the desktop keeps the
  // images as its own render state and no user message is published for it.
  assert.equal(promptText([{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }]), '')
})

// The assistant's own picture arrives as an `image` chunk of the message its prose is in. Toucan
// used to require `content.type === 'text'` on every branch, so the picture was dropped outright
// (issue #174) and the reply referred to an image nobody could see.
test('an assistant image chunk is published as images on the message, carrying no text', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-image-chunk-adapter-'))
  imageReplayingAdapter(appPath)
  const manager = createAcpSessionManager({ appPath })
  const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents

  try {
    const result = await manager.create(
      { id: 'image-node', provider: 'claude', cwd: appPath, sessionId: 'saved-images' },
      owner
    )

    assert.deepEqual(result.replay, [
      { type: 'message', role: 'assistant', messageId: 'saved-answer', text: 'Here is the comparison.' },
      {
        type: 'message',
        role: 'assistant',
        messageId: 'saved-answer',
        text: '',
        images: [{ data: 'Zmlyc3Q=', mimeType: 'image/png' }]
      }
    ])
  } finally {
    manager.killAll()
  }
})
