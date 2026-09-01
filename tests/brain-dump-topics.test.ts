import { deepEqual, equal } from 'node:assert/strict'
import { test } from 'node:test'
import type { BrainDumpTopic } from '../src/shared/brain-dump'
import type { WorkspaceProject } from '../src/shared/terminal'
import {
  BRAIN_DUMP_UNASSIGNED_LABEL,
  BRAIN_DUMP_UNREGISTERED_NOTE,
  brainDumpPathIdentity,
  brainDumpTopicPreview,
  describeBrainDumpDate,
  nextBrainDumpSelection,
  resolveBrainDumpProject,
  searchBrainDumpTopics
} from '../src/renderer/src/brain-dump-topics'

// What the library shows before any of it reaches the DOM: project identity, previews, search,
// and where selection lands once a topic leaves the collection it was selected in.

const projects: WorkspaceProject[] = [
  { id: 'toucan', name: 'Toucan', path: 'D:\\Development\\Toucan', color: '#71a9ff' },
  { id: 'site', name: 'Site', path: '/home/user/site', color: '#74d8a2' }
]

function topic(overrides: Partial<BrainDumpTopic> & Pick<BrainDumpTopic, 'slug'>): BrainDumpTopic {
  return {
    title: overrides.slug,
    created: '2026-08-01',
    updated: '2026-08-01',
    collection: 'active',
    markdown: '',
    ...overrides
  }
}

test('the same checkout matches whatever drive casing and separators it arrived with', () => {
  equal(brainDumpPathIdentity('D:\\Development\\Toucan\\'), brainDumpPathIdentity('d:/development/toucan'))
})

test('a registered project supplies its name and colour', () => {
  deepEqual(resolveBrainDumpProject('d:/development/toucan', projects), {
    label: 'Toucan',
    color: '#71a9ff',
    path: 'D:\\Development\\Toucan',
    registered: true,
    unassigned: false
  })
})

test('an unassigned topic says so explicitly', () => {
  deepEqual(resolveBrainDumpProject(undefined, projects), {
    label: BRAIN_DUMP_UNASSIGNED_LABEL,
    registered: false,
    unassigned: true
  })
})

test('a path no longer registered degrades to its basename and explains itself', () => {
  deepEqual(resolveBrainDumpProject('D:\\Archive\\OldApp', projects), {
    label: 'OldApp',
    path: 'D:\\Archive\\OldApp',
    note: BRAIN_DUMP_UNREGISTERED_NOTE,
    registered: false,
    unassigned: false
  })
})

test('a preview reads as prose, not as frontmatter and Markdown syntax', () => {
  const markdown = [
    '---',
    'title: Voice input',
    'updated: 2026-08-01',
    '---',
    '',
    '# Voice input',
    '',
    'Local **dictation** feels good; see [[node-resize-handles]] and [the docs](https://example.com).',
    '',
    '```ts',
    'const noise = 1',
    '```'
  ].join('\n')
  equal(brainDumpTopicPreview(markdown), 'Local dictation feels good; see node-resize-handles and the docs.')
})

test('recent dates read as days, and older ones stay exact', () => {
  equal(describeBrainDumpDate('2026-08-31', '2026-08-31'), 'today')
  equal(describeBrainDumpDate('2026-08-30', '2026-08-31'), 'yesterday')
  equal(describeBrainDumpDate('2026-08-28', '2026-08-31'), '3 days ago')
  equal(describeBrainDumpDate('2026-08-01', '2026-08-31'), '2026-08-01')
  equal(describeBrainDumpDate('not-a-date', '2026-08-31'), 'not-a-date')
})

test('an empty query keeps every row in library order', () => {
  const topics = [topic({ slug: 'b' }), topic({ slug: 'a' })]
  deepEqual(
    searchBrainDumpTopics(topics, '   ', projects).map((entry) => entry.slug),
    ['b', 'a']
  )
})

test('search is case-insensitive across title, slug, body, and project identity', () => {
  const topics = [
    topic({ slug: 'voice-input', title: 'Voice input', markdown: 'moonshine runs locally' }),
    topic({ slug: 'panel-width', title: 'Panel width', projectPath: 'D:\\Development\\Toucan' }),
    topic({ slug: 'other', title: 'Other' })
  ]
  deepEqual(
    searchBrainDumpTopics(topics, 'MOONSHINE', projects).map((entry) => entry.slug),
    ['voice-input']
  )
  deepEqual(
    searchBrainDumpTopics(topics, 'toucan', projects).map((entry) => entry.slug),
    ['panel-width']
  )
  deepEqual(
    searchBrainDumpTopics(topics, 'voice', projects).map((entry) => entry.slug),
    ['voice-input']
  )
})

test('an archived topic hands selection to the row that took its place', () => {
  const topics = [topic({ slug: 'a' }), topic({ slug: 'b' }), topic({ slug: 'c' })]
  equal(nextBrainDumpSelection(topics, 'b'), 'c')
  equal(nextBrainDumpSelection(topics, 'c'), 'b')
  equal(nextBrainDumpSelection([topic({ slug: 'only' })], 'only'), undefined)
})

test('selection falls back to the first row when the removed slug was not listed', () => {
  equal(nextBrainDumpSelection([topic({ slug: 'a' })], 'missing'), 'a')
  equal(nextBrainDumpSelection([], 'missing'), undefined)
})
