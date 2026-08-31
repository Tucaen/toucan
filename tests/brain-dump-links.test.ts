import { deepEqual, equal } from 'node:assert/strict'
import { test } from 'node:test'
import {
  BRAIN_DUMP_TOPIC_SCHEME,
  classifyBrainDumpLink,
  linkifyBrainDumpReferences,
  parseBrainDumpReferences,
  resolveBrainDumpReference
} from '../src/renderer/src/brain-dump-links'

// `[[slug]]` is the library's own cross-reference syntax and Markdown knows nothing about it, so
// these are the rules that decide what navigates, what reveals a file, and what stays inert.

const index = { active: new Set(['voice-input']), archived: new Set(['node-resize-handles']) }

test('references are collected in first-appearance order without duplicates', () => {
  deepEqual(parseBrainDumpReferences('See [[voice-input]] and [[node-resize-handles]], then [[voice-input]].'), [
    'voice-input',
    'node-resize-handles'
  ])
})

test('a reference that is not a well-formed slug is not a reference', () => {
  deepEqual(parseBrainDumpReferences('[[Voice Input]] [[ok-slug]] [[]] [[--]]'), ['ok-slug'])
})

test('references inside code are documentation about the syntax, not links', () => {
  const markdown = ['Write `[[in-code]]` to link.', '', '```md', '[[in-fence]]', '```', '', '[[real-one]]'].join('\n')
  deepEqual(parseBrainDumpReferences(markdown), ['real-one'])
  const linkified = linkifyBrainDumpReferences(markdown)
  equal(linkified.includes('`[[in-code]]`'), true)
  equal(linkified.includes('[[in-fence]]'), true)
  equal(linkified.includes(`[real-one](${BRAIN_DUMP_TOPIC_SCHEME}real-one)`), true)
})

test('a malformed reference is left as literal text rather than promised as a link', () => {
  equal(linkifyBrainDumpReferences('[[Not A Slug]]'), '[[Not A Slug]]')
})

test('ordinary Markdown links survive linkification untouched', () => {
  const markdown = '[docs](https://example.com/a) and ![shot](file:///D:/shots/a.png)'
  equal(linkifyBrainDumpReferences(markdown), markdown)
})

test('a topic href classifies back to its slug', () => {
  deepEqual(classifyBrainDumpLink(`${BRAIN_DUMP_TOPIC_SCHEME}voice-input`), { kind: 'topic', slug: 'voice-input' })
  deepEqual(classifyBrainDumpLink(`${BRAIN_DUMP_TOPIC_SCHEME}Not A Slug`), { kind: 'unsupported' })
})

test('only http and https reach the external browser handler', () => {
  deepEqual(classifyBrainDumpLink('https://example.com/a'), { kind: 'external', url: 'https://example.com/a' })
  deepEqual(classifyBrainDumpLink('javascript:alert(1)'), { kind: 'unsupported' })
  deepEqual(classifyBrainDumpLink('mailto:someone@example.com'), { kind: 'unsupported' })
  deepEqual(classifyBrainDumpLink('./relative.md'), { kind: 'unsupported' })
  deepEqual(classifyBrainDumpLink(undefined), { kind: 'unsupported' })
})

test('an absolute file URL becomes a local path for the reveal action', () => {
  deepEqual(classifyBrainDumpLink('file:///D:/Development/ADE/notes%20and%20more.md'), {
    kind: 'file',
    path: 'D:\\Development\\ADE\\notes and more.md'
  })
  deepEqual(classifyBrainDumpLink('file:///home/user/notes.md'), { kind: 'file', path: '/home/user/notes.md' })
})

test('a reference resolves against whichever collection currently holds it', () => {
  deepEqual(resolveBrainDumpReference('voice-input', index), {
    status: 'found',
    slug: 'voice-input',
    collection: 'active'
  })
  deepEqual(resolveBrainDumpReference('node-resize-handles', index), {
    status: 'found',
    slug: 'node-resize-handles',
    collection: 'archived'
  })
  deepEqual(resolveBrainDumpReference('never-written', index), { status: 'missing', slug: 'never-written' })
})
