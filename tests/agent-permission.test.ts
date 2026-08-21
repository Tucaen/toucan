import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { agentPermissionTitle } from '../src/shared/agent-permission'

test('Codex command approvals describe the command instead of showing only a generic permission label', () => {
  const title = agentPermissionTitle({
    kind: 'execute',
    status: 'pending',
    rawInput: {
      command: 'npm test',
      cwd: '/workspace/ade'
    }
  })

  assert.equal(title, 'Run command: npm test')
})

test('a generic adapter title does not hide a specific Codex command', () => {
  assert.equal(agentPermissionTitle({
    title: 'Permission required',
    kind: 'execute',
    rawInput: { command: 'git push origin feature' }
  }), 'Run command: git push origin feature')
})

test('Codex file-change approvals remain informative when the adapter supplies no title or raw input', () => {
  assert.equal(agentPermissionTitle({ kind: 'edit', status: 'pending' }), 'Change files')
})

test('Claude approval titles remain authoritative when supplied', () => {
  assert.equal(agentPermissionTitle({
    title: 'Update package.json dependencies',
    kind: 'edit',
    rawInput: { file_path: '/workspace/package.json' }
  }), 'Update package.json dependencies')
})
