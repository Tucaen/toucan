import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSessionProviders } from '../src/main/session-providers'

test('prefers PowerShell 7 for a plain terminal', () => {
  const providers = createSessionProviders({
    homeDirectory: 'C:\\Users\\tester',
    environment: {},
    resolveCommand: (command) => (command === 'pwsh.exe' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : null)
  })

  assert.deepEqual(providers.resolveLaunch(), {
    executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    args: ['-NoLogo']
  })
})

test('reads the latest human and assistant text from a Claude transcript', () => {
  const configurationDirectory = mkdtempSync(join(tmpdir(), 'ade-claude-test-'))
  const projectDirectory = join(configurationDirectory, 'projects', 'D--Development-ADE')
  mkdirSync(projectDirectory, { recursive: true })
  writeFileSync(
    join(projectDirectory, 'conversation-3.jsonl'),
    [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-11T10:00:00.000Z',
        message: { role: 'user', content: 'Please add persistence.' }
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-11T10:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Persistence is implemented.' }] }
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-11T10:00:03.000Z',
        isMeta: true,
        message: { role: 'user', content: 'Ignore this metadata.' }
      })
    ].join('\n'),
    'utf8'
  )
  const providers = createSessionProviders({
    homeDirectory: 'C:\\Users\\tester',
    environment: { CLAUDE_CONFIG_DIR: configurationDirectory },
    resolveCommand: () => null
  })

  assert.deepEqual(providers.getConversationPreview('claude', 'conversation-3'), {
    user: 'Please add persistence.',
    assistant: 'Persistence is implemented.',
    updatedAt: '2026-08-11T10:00:02.000Z'
  })
})

test('reads the latest human and assistant text from a Codex transcript', () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'ade-codex-test-'))
  const sessionDirectory = join(codexHome, 'sessions', '2026', '08', '11')
  mkdirSync(sessionDirectory, { recursive: true })
  writeFileSync(
    join(sessionDirectory, 'rollout-2026-08-11-conversation-4.jsonl'),
    [
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-08-11T11:00:00.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Package the app.' }] }
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-08-11T11:00:01.000Z',
        payload: { type: 'function_call', name: 'shell_command' }
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-08-11T11:00:02.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'The Windows build is ready.' }]
        }
      })
    ].join('\n'),
    'utf8'
  )
  const providers = createSessionProviders({
    homeDirectory: 'C:\\Users\\tester',
    environment: { CODEX_HOME: codexHome },
    resolveCommand: () => null
  })

  assert.deepEqual(providers.getConversationPreview('codex', 'conversation-4'), {
    user: 'Package the app.',
    assistant: 'The Windows build is ready.',
    updatedAt: '2026-08-11T11:00:02.000Z'
  })
})
