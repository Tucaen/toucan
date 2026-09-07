import { strict as assert } from 'node:assert'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import type { WebContents } from 'electron'
import type { AgentProcessLaunch } from '../src/main/agent-process'
import { agentProcessEnvironment, createAcpSessionManager } from '../src/main/acp-session-manager'

test('the node identity is part of the environment an agent process is built for', () => {
  const environment = agentProcessEnvironment({ PATH: '/usr/bin' }, 'node-42')

  assert.equal(environment.TOUCAN_NODE_ID, 'node-42')
  assert.equal(environment.PATH, '/usr/bin')
})

/** An app directory with an installed adapter, which is all `create` checks before spawning. */
function appWithAdapter(): string {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-acp-launch-'))
  const dist = join(appPath, 'node_modules', '@agentclientprotocol', 'codex-acp', 'dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'index.js'), '')
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
