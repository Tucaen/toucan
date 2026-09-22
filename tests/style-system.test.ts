import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'vitest'

const styles = readFileSync('src/renderer/src/styles.css', 'utf8')
const chatNode = readFileSync('src/renderer/src/ChatNode.tsx', 'utf8')
const rendererSource = readdirSync('src/renderer/src')
  .filter((path) => path.endsWith('.tsx'))
  .map((path) => readFileSync(`src/renderer/src/${path}`, 'utf8'))
  .join('\n')

function rootBlock(): string {
  const match = /:root \{([^}]*)\}/.exec(styles)
  if (!match) throw new Error('styles.css must declare a :root rule')
  return match[1]
}

const neutralTokens = new Map([
  ['--neutral-050', '#e4e9f1'],
  ['--neutral-100', '#cbd2dc'],
  ['--neutral-300', '#9aa4b2'],
  ['--neutral-400', '#8a94a2'],
  ['--neutral-500', '#6f7a89'],
  ['--neutral-600', '#687280'],
  ['--neutral-700', '#3a4350'],
  ['--neutral-750', '#2b323d'],
  ['--neutral-800', '#222832'],
  ['--neutral-850', '#1c222b'],
  ['--neutral-900', '#171b22'],
  ['--neutral-925', '#161a21']
])

test('the repeated neutral palette has one token source', () => {
  const root = rootBlock()
  const componentStyles = styles.replace(root, '')

  for (const [token, color] of neutralTokens) {
    assert.match(root, new RegExp(`${token}: ${color};`), `${token} must declare ${color}`)
    assert.doesNotMatch(componentStyles, new RegExp(color, 'i'), `${color} must be consumed through ${token}`)
  }
})

test('provider accents are consumed through their CSS tokens', () => {
  const componentStyles = styles.replace(rootBlock(), '')
  assert.doesNotMatch(componentStyles, /#71a9ff|#74d8a2/i)
  assert.doesNotMatch(chatNode, /#71a9ff/i)
  assert.match(chatNode, /provider === 'claude' \? 'var\(--claude\)' : 'var\(--codex\)'/)
})

test('every modal uses the shared dialog shell without specificity overrides', () => {
  for (const selector of ['.dialog-overlay {', '.dialog {', '.dialog-actions {', '.dialog-error {']) {
    assert.ok(styles.includes(selector), `${selector} must define the shared shell`)
  }
  assert.doesNotMatch(styles, /\.(?:unrecoverable-workspace|worktree|app|brain-dump)-dialog(?:\b|-)/)
  assert.doesNotMatch(rendererSource, /(?:unrecoverable-workspace|worktree|app|brain-dump)-dialog(?:\b|-)/)
  assert.doesNotMatch(styles, /!important/)
  assert.match(styles, /\.dialog :where\(p\)/)
  assert.match(styles, /\.dialog-compact :where\(p\)/)
})

test('tool cards emit one shared chrome vocabulary', () => {
  for (const selector of [
    '.tool-summary {',
    '.tool-block-label {',
    '.tool-inline-button {',
    '.tool-line-number {',
    '.eyebrow-label {'
  ]) {
    assert.ok(styles.includes(selector), `${selector} must define shared chrome`)
    assert.ok(rendererSource.includes(`className="${selector.slice(1, -2)}"`), `${selector} must be emitted`)
  }

  assert.doesNotMatch(
    styles,
    /\.(?:file-op-summary|shell-summary|search-navigation-summary|subagent-summary|mcp-summary|skill-summary)\s*[,\{]/
  )
  assert.doesNotMatch(styles, /\.(?:file-op|shell)-block-label\b/)
  assert.doesNotMatch(styles, /\.(?:file-op|search-result)-line-number\b/)
  assert.doesNotMatch(styles, /\.(?:file-op-path|shell-command) button/)
})

test('every stacking context uses the five-step z-index scale', () => {
  const root = rootBlock()
  const zTokens = new Map([
    ['--z-base', '1'],
    ['--z-control', '2'],
    ['--z-chrome', '10'],
    ['--z-popover', '20'],
    ['--z-dialog', '30']
  ])

  assert.equal([...root.matchAll(/--z-[\w-]+:/g)].length, zTokens.size)
  for (const [token, value] of zTokens) assert.match(root, new RegExp(`${token}: ${value};`))

  const declarations = [...styles.matchAll(/z-index:\s*([^;]+);/g)].map((match) => match[1])
  assert.ok(declarations.length > 0)
  assert.deepEqual(new Set(declarations), new Set([...zTokens.keys()].map((token) => `var(${token})`)))
})
