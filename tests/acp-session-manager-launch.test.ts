import { strict as assert } from 'node:assert'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import type { WebContents } from 'electron'
import type { AgentProcessLaunch } from '../src/main/agent-process'
import { agentProcessEnvironment, createAcpSessionManager } from '../src/main/acp-session-manager'
import { installAdapterStub } from './helpers/scripted-adapter'

test('the node identity is part of the environment an agent process is built for', () => {
  const environment = agentProcessEnvironment({ PATH: '/usr/bin' }, 'node-42')

  assert.equal(environment.TOUCAN_NODE_ID, 'node-42')
  assert.equal(environment.PATH, '/usr/bin')
})

/** An app directory with an installed adapter, which is all `create` checks before spawning. */
function appWithAdapter(): string {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-acp-launch-'))
  installAdapterStub(appPath, 'codex-acp')
  return appPath
}

function stubChild(): ChildProcessWithoutNullStreams {
  const child = new PassThrough() as unknown as ChildProcessWithoutNullStreams & { kill(): boolean }
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true
  })
  return child
}

test('the adapter process itself is launched with the node id, not only the record beside it', () => {
  // The regression this locks down: the manager stored `TOUCAN_NODE_ID` on the running agent
  // but launched the adapter with the untouched environment, so the Codex child - and the
  // worktree script it ran - never saw the node that asked for the work, and every worktree an
  // agent created for itself came back unclaimed.
  const launches: AgentProcessLaunch[] = []
  const manager = createAcpSessionManager({
    appPath: appWithAdapter(),
    environment: { PATH: '/usr/bin' },
    spawnAgent: (launch) => {
      launches.push(launch)
      return stubChild()
    }
  })

  // The spawn happens before `create` awaits anything, so the launch is observable without
  // standing up an adapter that would answer the `initialize` handshake.
  void manager.create({ id: 'node-42', provider: 'codex', cwd: '/project' }, {
    isDestroyed: () => false,
    send: () => {}
  } as unknown as WebContents)

  assert.equal(launches.length, 1)
  assert.equal(launches[0]?.options.env?.TOUCAN_NODE_ID, 'node-42')
  assert.equal(launches[0]?.options.cwd, '/project')
  manager.killAll()
})

test('routine delegation configures the Codex launch environment, and only when requested', () => {
  const appPath = appWithAdapter()
  // The claude adapter must exist too: delegation isolation is proven by launching both providers.
  installAdapterStub(appPath, 'claude-agent-acp')
  const launches: AgentProcessLaunch[] = []
  const manager = createAcpSessionManager({
    appPath,
    environment: { PATH: '/usr/bin' },
    spawnAgent: (launch) => {
      launches.push(launch)
      return stubChild()
    }
  })
  const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents
  const routineDelegation = { workerModelId: 'gpt-5.6-luna', workerEffortId: 'low' }

  void manager.create({ id: 'delegating', provider: 'codex', cwd: '/project', routineDelegation }, owner)
  void manager.create({ id: 'plain', provider: 'codex', cwd: '/project' }, owner)
  void manager.create({ id: 'claude', provider: 'claude', cwd: '/project', routineDelegation }, owner)

  const configured = JSON.parse(launches[0]?.options.env?.CODEX_CONFIG ?? 'null') as {
    agents: Record<string, unknown>
    developer_instructions: string
  }
  assert.equal(configured.agents.default_subagent_model, 'gpt-5.6-luna')
  assert.equal(configured.agents.default_subagent_reasoning_effort, 'low')
  assert.equal(configured.agents.max_concurrent_threads_per_session, 2)
  assert.equal(configured.agents.max_depth, 1)
  assert.match(configured.developer_instructions, /Delegate routine work cheaply/)
  // The preference never leaks into a session that did not request it, nor into another provider's
  // carrier: a Claude session carries its worker in session `_meta` only (the `routine-delegation.ts`
  // header explains why the CLI's subagent-model variables are never used).
  assert.equal(launches[1]?.options.env?.CODEX_CONFIG, undefined)
  assert.equal(launches[2]?.options.env?.CODEX_CONFIG, undefined)
  assert.equal(launches[2]?.options.env?.CLAUDE_CODE_SUBAGENT_MODEL, undefined)
  assert.equal(launches[2]?.options.env?.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, undefined)
  manager.killAll()
})

test('a worker missing from the account model cache withholds the configuration', () => {
  const appPath = appWithAdapter()
  const codexHome = mkdtempSync(join(tmpdir(), 'toucan-codex-home-'))
  writeFileSync(
    join(codexHome, 'models_cache.json'),
    JSON.stringify({ models: [{ slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list' }] })
  )
  const launches: AgentProcessLaunch[] = []
  const manager = createAcpSessionManager({
    appPath,
    codexHome,
    environment: {},
    spawnAgent: (launch) => {
      launches.push(launch)
      return stubChild()
    }
  })
  const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents
  void manager.create(
    {
      id: 'delegating',
      provider: 'codex',
      cwd: '/project',
      routineDelegation: { workerModelId: 'gpt-5.6-luna', workerEffortId: 'low' }
    },
    owner
  )
  // Never claim the cheap policy without evidence the model can exist here: the session launches,
  // but unconfigured, and the create result will report `unavailable` instead.
  assert.equal(launches[0]?.options.env?.CODEX_CONFIG, undefined)
  manager.killAll()
})

test('new sessions resolve the selected adapter while existing sessions retain their process', () => {
  const appPath = appWithAdapter()
  const original = join(appPath, 'node_modules/@agentclientprotocol/codex-acp/dist/index.js')
  const updated = join(appPath, 'updated.js')
  writeFileSync(updated, '')
  let selected = original
  const launches: AgentProcessLaunch[] = []
  const manager = createAcpSessionManager({
    appPath,
    resolveAdapter: () => selected,
    spawnAgent: (launch) => {
      launches.push(launch)
      return stubChild()
    }
  })
  const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents
  void manager.create({ id: 'before', provider: 'codex', cwd: appPath }, owner)
  selected = updated
  void manager.create({ id: 'after', provider: 'codex', cwd: appPath }, owner)
  assert.deepEqual(
    launches.map((launch) => launch.args[0]),
    [original, updated]
  )
  manager.killAll()
})
