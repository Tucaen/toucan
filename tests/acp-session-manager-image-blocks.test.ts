import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { imageCapabilityGuard, promptText, toPromptBlocks } from '../src/main/acp-session-manager'

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
