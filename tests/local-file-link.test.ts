import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { classifyMarkdownLink, opensInSystemViewer } from '../src/shared/local-file-link'

/*
 * Covers issue #175: a Markdown link to a local artifact - the shape an agent writes for a
 * Windows path, angle-bracketed because the workspace name has spaces in it - has to be
 * recognized as a file rather than silently discarded as an unparseable URL.
 */

test('web URLs are external and keep exactly what they pointed at', () => {
  assert.deepEqual(classifyMarkdownLink('https://example.com/docs'), {
    kind: 'external',
    url: 'https://example.com/docs'
  })
  assert.deepEqual(classifyMarkdownLink('http://localhost:5173/page?a=1#top'), {
    kind: 'external',
    url: 'http://localhost:5173/page?a=1#top'
  })
})

test('every absolute Windows path form resolves to the same native path', () => {
  const expected = { kind: 'file', path: 'D:\\Projects\\My Game\\docs\\art\\studies.png' }
  for (const href of [
    'D:/Projects/My Game/docs/art/studies.png',
    'D:\\Projects\\My Game\\docs\\art\\studies.png',
    '/D:/Projects/My Game/docs/art/studies.png',
    '<D:/Projects/My Game/docs/art/studies.png>',
    '/D:/Projects/My%20Game/docs/art/studies.png',
    'file:///D:/Projects/My%20Game/docs/art/studies.png',
    'file:///D:/Projects/My Game/docs/art/studies.png'
  ]) {
    assert.deepEqual(classifyMarkdownLink(href), expected, href)
  }
})

test('a UNC path written with backslashes is a file; a protocol-relative URL is not a path', () => {
  assert.deepEqual(classifyMarkdownLink('\\\\build\\share\\out.png'), {
    kind: 'file',
    path: '\\\\build\\share\\out.png'
  })
  assert.deepEqual(classifyMarkdownLink('file://build/share/out.png'), {
    kind: 'file',
    path: '\\\\build\\share\\out.png'
  })
  assert.deepEqual(classifyMarkdownLink('//example.com/logo.png'), { kind: 'unsupported' })
})

test('a POSIX absolute path stays a path, and a percent-encoded one is decoded', () => {
  assert.deepEqual(classifyMarkdownLink('/home/morgan/art/studies.png'), {
    kind: 'file',
    path: '/home/morgan/art/studies.png'
  })
  assert.deepEqual(classifyMarkdownLink('file:///home/morgan/My%20Art/studies.png'), {
    kind: 'file',
    path: '/home/morgan/My Art/studies.png'
  })
})

test('anything that is not a web URL or an absolute path is unsupported', () => {
  for (const href of [
    undefined,
    '',
    '   ',
    '#section',
    'docs/art/studies.png',
    './studies.png',
    'mailto:morgan@example.com',
    'javascript:alert(1)',
    'ms-settings:privacy',
    'toucan-topic:some-slug',
    'file://',
    'D:'
  ]) {
    assert.deepEqual(classifyMarkdownLink(href), { kind: 'unsupported' }, String(href))
  }
})

test('only inert media Toucan cannot render itself is handed to the system viewer', () => {
  for (const path of ['a.png', 'a.JPG', 'a.jpeg', 'a.gif', 'a.webp', 'a.avif', 'a.bmp', 'a.ico']) {
    assert.equal(opensInSystemViewer(path), true, path)
  }
  for (const path of ['a.pdf', 'a.mp4', 'a.webm', 'a.mp3', 'a.wav']) {
    assert.equal(opensInSystemViewer(path), true, path)
  }
  // Everything else opens as a file node instead, so nothing the OS would execute is handed over -
  // `.svg` included, because the browser the OS opens one in runs the script it may carry.
  for (const path of ['a.svg', 'a.md', 'a.ts', 'a.js', 'a.json', 'a.bat', 'a.cmd', 'a.exe', 'a.ps1', 'a', 'a.pngx']) {
    assert.equal(opensInSystemViewer(path), false, path)
  }
})
