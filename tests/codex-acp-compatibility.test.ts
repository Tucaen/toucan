import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

interface PackageLock {
  packages: Record<string, { version?: string }>
}

test('pins Codex ACP before the 0.147 single-writer resume regression', () => {
  const root = process.cwd()
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
  }
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as PackageLock

  assert.equal(manifest.dependencies['@agentclientprotocol/codex-acp'], '1.1.10')
  assert.equal(lock.packages['node_modules/@agentclientprotocol/codex-acp']?.version, '1.1.10')
  assert.equal(lock.packages['node_modules/@openai/codex']?.version, '0.146.1')
})
