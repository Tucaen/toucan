import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { linkCopyChoices, markdownLinkAction } from '../src/renderer/src/markdown-link-action'

/*
 * What a rendered link does and what it says it will do come from one decision, so a link can
 * never promise the canvas and then hand the path to the OS (#175).
 */

test('a web link goes to the browser and says so', () => {
  assert.deepEqual(markdownLinkAction('https://example.com/docs', true), {
    kind: 'browser',
    url: 'https://example.com/docs',
    title: 'Open https://example.com/docs in your browser'
  })
})

test('inert media Toucan has no view for goes to the system viewer, canvas or not', () => {
  for (const canOpenFileNode of [true, false]) {
    assert.deepEqual(markdownLinkAction('</D:/Projects/My Game/studies.png>', canOpenFileNode), {
      kind: 'system-viewer',
      path: 'D:\\Projects\\My Game\\studies.png',
      title: 'Open D:\\Projects\\My Game\\studies.png'
    })
  }
})

test('anything Toucan can render opens as a node, and reveals where there is no canvas', () => {
  assert.deepEqual(markdownLinkAction('</D:/Projects/My Game/docs/plan.md>', true), {
    kind: 'file-node',
    path: 'D:\\Projects\\My Game\\docs\\plan.md',
    title: 'Open D:\\Projects\\My Game\\docs\\plan.md as a node on the canvas'
  })
  assert.deepEqual(markdownLinkAction('</D:/Projects/My Game/docs/plan.md>', false), {
    kind: 'reveal',
    path: 'D:\\Projects\\My Game\\docs\\plan.md',
    title: 'Reveal D:\\Projects\\My Game\\docs\\plan.md in the file manager'
  })
})

test('a file the OS would execute is never a system-viewer action', () => {
  assert.equal(markdownLinkAction('</D:/Projects/My Game/setup.bat>', true).kind, 'file-node')
  // An SVG is markup a browser executes, so it is read rather than handed over.
  assert.equal(markdownLinkAction('</D:/Projects/My Game/logo.svg>', true).kind, 'file-node')
})

test('a link that names nothing openable has no action at all', () => {
  for (const href of [undefined, '', 'docs/plan.md', '#top', 'javascript:alert(1)']) {
    assert.deepEqual(markdownLinkAction(href, true), { kind: 'none' }, String(href))
  }
})

test('every link with a target offers to copy it, whether or not it can be opened', () => {
  const copy = (href: string): string[][] =>
    linkCopyChoices(markdownLinkAction(href, true), href).map(({ label, text }) => [label, text])

  assert.deepEqual(copy('https://example.com/a?b=1'), [['Copy link', 'https://example.com/a?b=1']])
  assert.deepEqual(copy('</D:/My Game/shot.png>'), [
    ['Copy path', 'D:\\My Game\\shot.png'],
    ['Copy as file URL', 'file:///D:/My%20Game/shot.png']
  ])
  // A relative link has no base to open against, but its text is still worth having.
  assert.deepEqual(copy('ui3-shots/hideout%20icons.png'), [['Copy link target', 'ui3-shots/hideout icons.png']])
  assert.deepEqual(linkCopyChoices({ kind: 'none' }, undefined), [])
})
