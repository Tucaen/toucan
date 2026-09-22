import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { createImageArtifactSaver, imageArtifactBytes } from '../src/main/image-save'
import {
  imageArtifactFileName,
  MAX_IMAGE_ARTIFACT_BASE64_LENGTH,
  MAX_IMAGE_ARTIFACT_BYTES
} from '../src/shared/image-artifact'

const PNG = Buffer.from('pretend-png-bytes').toString('base64')

test('the suggested file name takes its extension from the media type', () => {
  assert.equal(imageArtifactFileName('generated-image-1', 'image/png'), 'generated-image-1.png')
  assert.equal(imageArtifactFileName('generated-image-1', 'IMAGE/JPEG'), 'generated-image-1.jpg')
  assert.equal(imageArtifactFileName('generated-image-1', 'image/svg+xml'), 'generated-image-1.svg')
})

test('an unrecognized media type still saves, but is never named as a format it might not be', () => {
  assert.equal(imageArtifactFileName('generated-image-1', 'image/x-unknown'), 'generated-image-1.bin')
  assert.equal(imageArtifactFileName('generated-image-1', ''), 'generated-image-1.bin')
})

test('path separators and reserved characters never reach the suggested name', () => {
  assert.equal(imageArtifactFileName('../../etc/passwd', 'image/png'), '....etcpasswd.png')
  assert.equal(imageArtifactFileName('   ', 'image/png'), 'image.png')
})

test('an image with no bytes is refused with what is actually wrong, not a write error', () => {
  assert.deepEqual(imageArtifactBytes({ data: '', mimeType: 'image/png', suggestedName: 'x' }), {
    ok: false,
    message: 'That image was not included in the reply, so there is nothing to save.'
  })
})

test('a payload that is not base64 at all is refused rather than written as zero bytes', () => {
  // Node's decoder skips anything outside the alphabet instead of throwing, so nothing but the
  // empty result distinguishes junk from real bytes.
  assert.deepEqual(imageArtifactBytes({ data: '!!!!', mimeType: 'image/png', suggestedName: 'x' }), {
    ok: false,
    message: 'That image could not be decoded.'
  })
})

// The ceiling is a byte count but the payload is base64, which inflates by 4/3 - so an image of
// exactly the permitted size must still pass, and only one past it may be refused.
test('the seam ceiling is measured in image bytes, not in the base64 that carries them', () => {
  const encodedFor = (bytes: number): string => Buffer.alloc(bytes).toString('base64')
  assert.equal(
    imageArtifactBytes({ data: encodedFor(MAX_IMAGE_ARTIFACT_BYTES), mimeType: '', suggestedName: 'x' }).ok,
    true
  )
  assert.deepEqual(
    imageArtifactBytes({
      data: 'A'.repeat(MAX_IMAGE_ARTIFACT_BASE64_LENGTH + 1),
      mimeType: 'image/png',
      suggestedName: 'x'
    }),
    { ok: false, message: 'That image is too large to save.' }
  )
})

test('saving writes the decoded bytes to the path the user picked', async () => {
  const written: Array<{ path: string; bytes: Buffer }> = []
  const names: string[] = []
  const save = createImageArtifactSaver({
    showSaveDialog: async (_sender, defaultName) => {
      names.push(defaultName)
      return 'D:/pictures/keep.png'
    },
    writeFile: async (path, bytes) => {
      written.push({ path, bytes })
    }
  })

  const result = await save(null, { data: PNG, mimeType: 'image/png', suggestedName: 'generated-image-1' })

  assert.deepEqual(result, { status: 'saved', path: 'D:/pictures/keep.png' })
  assert.deepEqual(names, ['generated-image-1.png'])
  assert.equal(written[0]?.path, 'D:/pictures/keep.png')
  assert.equal(written[0]?.bytes.toString('utf8'), 'pretend-png-bytes')
})

test('a cancelled dialog writes nothing and is not reported as a failure', async () => {
  let writes = 0
  const save = createImageArtifactSaver({
    showSaveDialog: async () => null,
    writeFile: async () => {
      writes += 1
    }
  })

  assert.deepEqual(await save(null, { data: PNG, mimeType: 'image/png', suggestedName: 'x' }), {
    status: 'cancelled'
  })
  assert.equal(writes, 0)
})

test('a failed write is reported back rather than swallowed, so the click is never a no-op', async () => {
  const save = createImageArtifactSaver({
    showSaveDialog: async () => 'D:/read-only/keep.png',
    writeFile: async () => {
      throw new Error('EACCES: permission denied')
    }
  })

  assert.deepEqual(await save(null, { data: PNG, mimeType: 'image/png', suggestedName: 'x' }), {
    status: 'refused',
    message: 'EACCES: permission denied'
  })
})
