import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { WebContents } from 'electron'
import type { AgentEvent, AgentEventEnvelope } from '../src/shared/agent'
import { agentProcessEnvironment, createAcpSessionManager } from '../src/main/acp-session-manager'
import { createPluginRegistry } from '../src/main/plugin-registry'
import type { AcpMcpHttpServer } from '../src/main/terminal-context-mcp'
import { installScriptedAdapter, type AdapterPackage } from './helpers/scripted-adapter'

// #55: the plugins a session's project enabled ride its launch. Claude loads each folder as a
// local plugin beside the skills plugins; Codex gets the skills through a Toucan-owned root and
// the MCP servers beside the terminal-context one; both are told each plugin's root and run with
// TOUCAN_PROJECT_DIR. A plugin that cannot be used is a notice, never a failed launch.

interface Recorded {
  params: {
    additionalDirectories?: string[]
    mcpServers?: unknown[]
    _meta?: {
      claudeCode?: { options?: { plugins?: Array<{ type: string; path: string }> } }
      systemPrompt?: { append: string }
    }
  }
  env: { projectDirectory?: string; config?: string }
}

function recordingAdapter(appPath: string, adapter: AdapterPackage): string {
  const recordPath = join(appPath, `${adapter}-requests.json`)
  installScriptedAdapter(appPath, adapter, {
    prelude: `
const fs = require('node:fs')
const env = { projectDirectory: process.env.TOUCAN_PROJECT_DIR, config: process.env.CODEX_CONFIG }
const record = (request) => fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ params: request.params, env }) + '\\n')`,
    handleRequest: `
  if (request.method === 'session/new') {
    record(request)
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'conversation-1' } })
  }`
  })
  return recordPath
}

function recorded(recordPath: string): Recorded[] {
  return readFileSync(recordPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Recorded)
}

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `toucan-acp-plugins-${prefix}-`))
}

/** A plugin folder in Claude's layout. */
function pluginFolder(name: string, files: Record<string, string> = {}): string {
  const root = scratch(name)
  mkdirSync(join(root, '.claude-plugin'))
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }))
  for (const [relative, contents] of Object.entries(files)) {
    mkdirSync(join(root, relative, '..'), { recursive: true })
    writeFileSync(join(root, relative), contents)
  }
  return root
}

function recordingOwner(events: AgentEvent[]): WebContents {
  return {
    isDestroyed: () => false,
    send: (_channel: string, envelope: AgentEventEnvelope) => void events.push(envelope.event)
  } as unknown as WebContents
}

test('the project checkout is part of the environment an agent process is built for', () => {
  assert.equal(
    agentProcessEnvironment({ PATH: '/usr/bin' }, 'node-1', { projectDirectory: 'D:\\checkout' }).TOUCAN_PROJECT_DIR,
    'D:\\checkout'
  )
  // One Toucan started from a session's shell must not hand that session's project to its own.
  assert.equal(agentProcessEnvironment({ TOUCAN_PROJECT_DIR: 'D:\\inherited' }, 'node-1').TOUCAN_PROJECT_DIR, undefined)
})

test('a Claude session loads each enabled plugin beside the skills plugins and is told its root', async () => {
  const appPath = scratch('app')
  mkdirSync(join(appPath, '.agents', 'skills'), { recursive: true })
  const recordPath = recordingAdapter(appPath, 'claude-agent-acp')
  const project = scratch('project')
  mkdirSync(join(project, '.agents', 'skills'), { recursive: true })
  const pluginRoot = 'D:\\plugins\\godot-runtime'
  const asked: unknown[] = []
  const manager = createAcpSessionManager({
    appPath,
    environment: { PATH: process.env.PATH },
    plugins: {
      forSession: (request) => {
        asked.push(request)
        return Promise.resolve({ plugins: [{ id: 'godot-runtime', root: pluginRoot }], notices: [] })
      }
    }
  })
  try {
    const result = await manager.create({ id: 'chat', provider: 'claude', cwd: project }, recordingOwner([]))
    assert.equal(result.status, 'ready')
    const [session] = recorded(recordPath)
    assert.deepEqual(session?.params._meta?.claudeCode?.options?.plugins, [
      { type: 'local', path: join(project, '.agents') },
      { type: 'local', path: join(appPath, '.agents') },
      { type: 'local', path: pluginRoot }
    ])
    assert.ok(
      session?.params._meta?.systemPrompt?.append.includes(
        'Toucan plugin "godot-runtime" is enabled for this project: its root is D:\\plugins\\godot-runtime'
      )
    )
    // Claude reads the plugin's MCP servers and hooks out of the folder itself.
    assert.deepEqual(session?.params.mcpServers, [])
    assert.equal(session?.env.projectDirectory, project)
    assert.deepEqual(asked, [{ provider: 'claude', projectPath: project }])
  } finally {
    manager.killAll()
  }
})

test("a Codex session in a worktree gets its project's plugins: skills root, MCP servers and instruction", async () => {
  const appPath = scratch('app')
  const recordPath = recordingAdapter(appPath, 'codex-acp')
  const userDataPath = scratch('user-data')
  const project = scratch('project')
  const worktree = scratch('worktree')
  const pluginRoot = pluginFolder('godot-runtime', {
    'skills/run-scene/SKILL.md': '---\nname: run-scene\ndescription: Runs a scene headless.\n---\n',
    '.mcp.json': JSON.stringify({
      mcpServers: {
        godot: {
          command: '${CLAUDE_PLUGIN_ROOT}/bin/server',
          args: ['--headless'],
          env: { GODOT_HOME: '${CLAUDE_PLUGIN_ROOT}/data' }
        },
        docs: { type: 'http', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer token' } }
      }
    })
  })
  const registry = createPluginRegistry({ userDataPath })
  assert.equal((await registry.add(pluginRoot)).ok, true)
  assert.deepEqual(await registry.enable(project, 'godot-runtime'), { ok: true })
  const terminal: AcpMcpHttpServer = {
    name: 'toucan-terminal',
    type: 'http',
    url: 'http://127.0.0.1:65530/mcp',
    headers: [{ name: 'Authorization', value: 'Bearer terminal' }]
  }
  const events: AgentEvent[] = []
  const manager = createAcpSessionManager({
    appPath,
    environment: { PATH: process.env.PATH },
    plugins: registry,
    projectPathFor: (cwd) => Promise.resolve(cwd === worktree ? project : undefined),
    terminalContext: { serverFor: () => Promise.resolve(terminal) }
  })
  try {
    const result = await manager.create({ id: 'codex-chat', provider: 'codex', cwd: worktree }, recordingOwner(events))
    assert.equal(result.status, 'ready')
    const [session] = recorded(recordPath)
    assert.ok(
      session?.params.additionalDirectories?.includes(join(userDataPath, 'codex-plugin-skills', 'godot-runtime'))
    )
    assert.deepEqual(session?.params.mcpServers, [
      terminal,
      {
        name: 'godot',
        command: `${pluginRoot}/bin/server`,
        args: ['--headless'],
        env: [{ name: 'GODOT_HOME', value: `${pluginRoot}/data` }]
      },
      {
        type: 'http',
        name: 'docs',
        url: 'https://docs.example/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer token' }]
      }
    ])
    const config = JSON.parse(session?.env.config ?? '{}') as { developer_instructions?: string }
    assert.ok(
      config.developer_instructions?.includes(
        `Toucan plugin "godot-runtime" is enabled for this project: its root is ${pluginRoot}`
      )
    )
    // The worktree inherits its project's plugins, and its scripts are told which project that is.
    assert.equal(session?.env.projectDirectory, project)
    assert.equal(session?.params._meta?.claudeCode, undefined)
    assert.deepEqual(
      events.filter((event) => event.type === 'error'),
      []
    )
  } finally {
    manager.killAll()
  }
})

test('a plugin that cannot be used is a notice on the session, never a failed launch', async () => {
  const appPath = scratch('app')
  const recordPath = recordingAdapter(appPath, 'claude-agent-acp')
  const project = scratch('project')
  const registry = createPluginRegistry({ userDataPath: scratch('user-data') })
  const pluginRoot = pluginFolder('godot-runtime')
  await registry.add(pluginRoot)
  await registry.enable(project, 'godot-runtime')
  renameSync(pluginRoot, `${pluginRoot}-moved`)
  const events: AgentEvent[] = []
  const manager = createAcpSessionManager({ appPath, environment: { PATH: process.env.PATH }, plugins: registry })
  const failing = createAcpSessionManager({
    appPath,
    environment: { PATH: process.env.PATH },
    plugins: { forSession: () => Promise.reject(new Error('registry unreadable')) }
  })
  try {
    const result = await manager.create({ id: 'chat', provider: 'claude', cwd: project }, recordingOwner(events))
    assert.equal(result.ok, true)
    assert.equal(result.status, 'ready')
    const [session] = recorded(recordPath)
    assert.equal(session?.params._meta?.claudeCode?.options?.plugins, undefined)
    assert.ok(!session?.params._meta?.systemPrompt?.append.includes('Toucan plugin'))
    const notices = events.flatMap((event) => (event.type === 'error' ? [event.message] : []))
    assert.equal(notices.length, 1)
    assert.ok(notices[0]?.includes('"godot-runtime" was skipped') && notices[0].includes('missing'))

    const failingEvents: AgentEvent[] = []
    const unresolved = await failing.create(
      { id: 'other', provider: 'claude', cwd: project },
      recordingOwner(failingEvents)
    )
    assert.equal(unresolved.status, 'ready')
    assert.ok(failingEvents.some((event) => event.type === 'error' && event.message.includes('registry unreadable')))
  } finally {
    manager.killAll()
    failing.killAll()
  }
})
