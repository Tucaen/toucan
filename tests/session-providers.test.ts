import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSessionProviders } from '../src/main/session-providers'

test('launches a new Claude conversation through the Windows command shell', () => {
  const providers = createSessionProviders({
    homeDirectory: 'C:\\Users\\tester',
    environment: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    resolveCommand: (command) => command === 'claude' ? 'C:\\Tools\\claude.cmd' : null
  })

  assert.deepEqual(providers.resolveLaunch({
    id: 'node-1',
    kind: 'claude',
    cols: 80,
    rows: 24,
    cwd: 'D:\\Development\\ADE',
    conversationId: 'conversation-1'
  }), {
    executable: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', 'C:\\Tools\\claude.cmd', '--session-id', 'conversation-1']
  })
})

test('resumes a Codex conversation with its saved conversation ID', () => {
  const providers = createSessionProviders({
    homeDirectory: 'C:\\Users\\tester',
    environment: {},
    resolveCommand: (command) => command === 'codex' ? 'C:\\Tools\\codex.exe' : null
  })

  assert.deepEqual(providers.resolveLaunch({
    id: 'node-2',
    kind: 'codex',
    cols: 80,
    rows: 24,
    cwd: 'D:\\Development\\ADE',
    conversationId: 'conversation-2',
    resume: true
  }), {
    executable: 'C:\\Tools\\codex.exe',
    args: ['resume', 'conversation-2']
  })
})

test('prefers PowerShell 7 for a plain terminal', () => {
  const providers = createSessionProviders({
    homeDirectory: 'C:\\Users\\tester',
    environment: {},
    resolveCommand: (command) => command === 'pwsh.exe' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : null
  })

  assert.deepEqual(providers.resolveLaunch({
    id: 'node-3',
    kind: 'terminal',
    cols: 80,
    rows: 24,
    cwd: 'D:\\Development\\ADE'
  }), {
    executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    args: ['-NoLogo']
  })
})

test('reads the latest human and assistant text from a Claude transcript', () => {
  const configurationDirectory = mkdtempSync(join(tmpdir(), 'ade-claude-test-'))
  const projectDirectory = join(configurationDirectory, 'projects', 'D--Development-ADE')
  mkdirSync(projectDirectory, { recursive: true })
  writeFileSync(join(projectDirectory, 'conversation-3.jsonl'), [
    JSON.stringify({ type: 'user', timestamp: '2026-08-11T10:00:00.000Z', message: { role: 'user', content: 'Please add persistence.' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-08-11T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Persistence is implemented.' }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-08-11T10:00:03.000Z', isMeta: true, message: { role: 'user', content: 'Ignore this metadata.' } })
  ].join('\n'), 'utf8')
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
  writeFileSync(join(sessionDirectory, 'rollout-2026-08-11-conversation-4.jsonl'), [
    JSON.stringify({ type: 'response_item', timestamp: '2026-08-11T11:00:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Package the app.' }] } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-08-11T11:00:01.000Z', payload: { type: 'function_call', name: 'shell_command' } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-08-11T11:00:02.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The Windows build is ready.' }] } })
  ].join('\n'), 'utf8')
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

test('discovers the Codex conversation created for a project directory', () => {
  const codexHome = mkdtempSync(join(tmpdir(), 'ade-codex-discovery-test-'))
  const startedAt = Date.now() - 100
  const date = new Date(startedAt)
  const sessionDirectory = join(
    codexHome,
    'sessions',
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  )
  mkdirSync(sessionDirectory, { recursive: true })
  writeFileSync(join(sessionDirectory, 'rollout-conversation-5.jsonl'), `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id: 'conversation-5',
      cwd: 'D:\\Development\\ADE',
      timestamp: new Date(startedAt + 25).toISOString()
    }
  })}\n`, 'utf8')
  const providers = createSessionProviders({
    homeDirectory: 'C:\\Users\\tester',
    environment: { CODEX_HOME: codexHome },
    resolveCommand: () => null
  })

  assert.equal(
    providers.discoverConversation('codex', 'D:\\Development\\ADE', startedAt, new Set()),
    'conversation-5'
  )
})
