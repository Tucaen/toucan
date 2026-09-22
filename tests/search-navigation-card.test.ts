import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { parseSearchNavigation, searchNavigationSummary } from '../src/renderer/src/search-navigation'

test('a grep result is grouped by file with line numbers and an aggregate count', () => {
  const search = parseSearchNavigation({
    id: 'grep-1',
    kind: 'search',
    toolName: 'Grep',
    status: 'completed',
    rawInput: { pattern: 'useAgentConversation', output_mode: 'content' },
    content: [
      'src/renderer/src/ChatNode.tsx:14:useAgentConversation()',
      'src/renderer/src/ChatNode.tsx:29:const state = useAgentConversation()',
      'src/renderer/src/App.tsx:82:useAgentConversation()',
      'tests/chat-node.test.tsx:51:useAgentConversation()'
    ].join('\n')
  })

  assert.deepEqual(search, {
    kind: 'grep',
    pattern: 'useAgentConversation',
    matchCount: 4,
    groups: [
      {
        path: 'src/renderer/src/ChatNode.tsx',
        matches: [
          { line: 14, text: 'useAgentConversation()' },
          { line: 29, text: 'const state = useAgentConversation()' }
        ]
      },
      { path: 'src/renderer/src/App.tsx', matches: [{ line: 82, text: 'useAgentConversation()' }] },
      { path: 'tests/chat-node.test.tsx', matches: [{ line: 51, text: 'useAgentConversation()' }] }
    ]
  })
})

test('a grep summary states its pattern, match count, and file count', () => {
  assert.equal(
    searchNavigationSummary({
      kind: 'grep',
      pattern: 'useAgentConversation',
      matchCount: 7,
      groups: [
        { path: 'one.ts', matches: [] },
        { path: 'two.ts', matches: [] },
        { path: 'three.ts', matches: [] }
      ]
    }),
    'useAgentConversation — 7 matches in 3 files'
  )
})

test('a completed grep with no output is unmistakably a zero-result search', () => {
  const search = parseSearchNavigation({
    id: 'grep-empty',
    kind: 'search',
    toolName: 'Grep',
    status: 'completed',
    rawInput: { pattern: 'neverAppears' }
  })
  assert.ok(search)
  assert.equal(searchNavigationSummary(search), 'neverAppears — No matches')
})

test('a glob reports the matching paths as file results', () => {
  const search = parseSearchNavigation({
    id: 'glob-1',
    kind: 'search',
    toolName: 'Glob',
    status: 'completed',
    rawInput: { pattern: 'src/**/*.tsx' },
    content: 'src/App.tsx\nsrc/ChatNode.tsx\nsrc/MarkdownMessage.tsx'
  })

  assert.deepEqual(search, {
    kind: 'glob',
    pattern: 'src/**/*.tsx',
    paths: ['src/App.tsx', 'src/ChatNode.tsx', 'src/MarkdownMessage.tsx']
  })
  assert.ok(search)
  assert.equal(searchNavigationSummary(search), 'src/**/*.tsx — 3 files')
})

test('a web search preserves each result title, URL, and host', () => {
  const search = parseSearchNavigation({
    id: 'web-search-1',
    kind: 'fetch',
    toolName: 'WebSearch',
    status: 'completed',
    rawInput: { query: 'React documentation' },
    content: ['React (https://react.dev/)', 'React repository (https://github.com/facebook/react)'].join('\n')
  })

  assert.deepEqual(search, {
    kind: 'web-search',
    query: 'React documentation',
    results: [
      { title: 'React', url: 'https://react.dev/', host: 'react.dev' },
      { title: 'React repository', url: 'https://github.com/facebook/react', host: 'github.com' }
    ]
  })
})

test('a web fetch leads with the fetched page host and provider title', () => {
  const fetch = parseSearchNavigation({
    id: 'web-fetch-1',
    kind: 'fetch',
    toolName: 'WebFetch',
    status: 'completed',
    rawInput: {
      url: 'https://docs.example.com/reference/cards',
      title: 'Tool card reference',
      prompt: 'Summarize the card contract'
    },
    content: 'Cards share one shell and provide only their summary and body.'
  })

  assert.deepEqual(fetch, {
    kind: 'web-fetch',
    url: 'https://docs.example.com/reference/cards',
    host: 'docs.example.com',
    title: 'Tool card reference',
    content: 'Cards share one shell and provide only their summary and body.'
  })
  assert.ok(fetch)
  assert.equal(searchNavigationSummary(fetch), 'docs.example.com — Tool card reference')
})

test('a Codex open-page action is recognized without a programmatic tool name', () => {
  const fetch = parseSearchNavigation({
    id: 'codex-open-1',
    kind: 'search',
    status: 'completed',
    rawInput: {
      type: 'webSearch',
      action: { type: 'openPage', url: 'https://example.com/articles/cards' }
    }
  })

  assert.deepEqual(fetch, {
    kind: 'web-fetch',
    url: 'https://example.com/articles/cards',
    host: 'example.com',
    title: 'Open page'
  })
})

test('a Codex web-search action is recognized even when it exposes no result body', () => {
  const search = parseSearchNavigation({
    id: 'codex-search-1',
    kind: 'search',
    status: 'completed',
    rawInput: {
      type: 'webSearch',
      query: 'fallback query',
      action: { type: 'search', queries: ['tool cards', 'ACP tools'] }
    }
  })

  assert.deepEqual(search, {
    kind: 'web-search',
    query: 'tool cards, ACP tools',
    results: []
  })
})

test('grep files-with-matches output reports matching files without inventing line matches', () => {
  const search = parseSearchNavigation({
    id: 'grep-files-1',
    kind: 'search',
    toolName: 'Grep',
    status: 'completed',
    rawInput: { pattern: 'AgentActivity', output_mode: 'files_with_matches' },
    content: 'src/shared/agent.ts\nsrc/shared/agent-activity.ts'
  })

  assert.deepEqual(search, {
    kind: 'grep',
    pattern: 'AgentActivity',
    matchCount: 2,
    filesOnly: true,
    groups: [
      { path: 'src/shared/agent.ts', matches: [] },
      { path: 'src/shared/agent-activity.ts', matches: [] }
    ]
  })
  assert.ok(search)
  assert.equal(searchNavigationSummary(search), 'AgentActivity — 2 matching files')
})
