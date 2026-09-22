import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'

const styles = readFileSync('src/renderer/src/styles.css', 'utf8')
const chatNode = readFileSync('src/renderer/src/ChatNode.tsx', 'utf8')

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
