import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const uiTextFiles = [
  'README.md',
  'src/main/acp-session-manager.ts',
  'src/renderer/src/ChatNode.prototype.tsx',
  'src/renderer/src/PrototypeSwitcher.tsx'
]

test('user-facing prototype text contains no UTF-8 mojibake markers', () => {
  for (const relativePath of uiTextFiles) {
    const source = readFileSync(join(process.cwd(), relativePath), 'utf8')
    assert.doesNotMatch(
      source,
      /[\u00c2\u00c3\u00e2]/,
      `${relativePath} contains a common mojibake marker`
    )
  }
})
