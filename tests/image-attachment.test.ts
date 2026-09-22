import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { isSaveableImage, unavailableImageNote } from '../src/renderer/src/image-attachment'

test('an image with bytes in a type the browser paints has nothing to explain', () => {
  assert.equal(unavailableImageNote({ id: 'a', data: 'Zmlyc3Q=', mimeType: 'image/png' }), null)
  assert.equal(unavailableImageNote({ id: 'a', data: 'Zmlyc3Q=', mimeType: 'IMAGE/WebP' }), null)
  // SVG reaches the DOM only as an `<img>`, where a browser disables its scripting and external
  // references - unlike handing the file to the OS, which `opensInSystemViewer` refuses to do.
  assert.equal(unavailableImageNote({ id: 'a', data: 'Zmlyc3Q=', mimeType: 'image/svg+xml' }), null)
})

test('an image the adapter sent no bytes for says so, and names where it lives when it can', () => {
  assert.equal(
    unavailableImageNote({ id: 'a', data: '', mimeType: '', uri: 'https://example.test/a.png' }),
    'The image was not included in the reply. It lives at https://example.test/a.png.'
  )
  assert.equal(
    unavailableImageNote({ id: 'a', data: '', mimeType: 'image/png' }),
    'The image was not included in the reply.'
  )
})

test('a type the browser cannot decode is named rather than left as a broken frame', () => {
  assert.equal(
    unavailableImageNote({ id: 'a', data: 'Zmlyc3Q=', mimeType: 'image/heic' }),
    'Toucan cannot display image/heic. Save it to open it elsewhere.'
  )
  assert.equal(
    unavailableImageNote({ id: 'a', data: 'Zmlyc3Q=', mimeType: '' }),
    'Toucan cannot display this image type. Save it to open it elsewhere.'
  )
})

test('only an image with bytes is worth offering a save for', () => {
  assert.equal(isSaveableImage({ id: 'a', data: 'Zmlyc3Q=', mimeType: 'image/heic' }), true)
  assert.equal(isSaveableImage({ id: 'a', data: '', mimeType: '', uri: 'https://example.test/a.png' }), false)
})
