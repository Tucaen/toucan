import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { WebContents } from 'electron'
import type { AgentProcessLaunch } from '../src/main/agent-process'
import { agentProcessEnvironment, createAcpSessionManager } from '../src/main/acp-session-manager'
import { PROCESS_OWNER_ENV } from '../src/main/process-tree'
import { installAdapterStub, stubAdapterChild } from './helpers/scripted-adapter'

const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents

/** Lets the stop's tree kill settle, after which its sweep starts. */
const settled = (): Promise<void> => new Promise((done) => setTimeout(done, 0))

/** A manager on stub adapters that records each launch with its child, and every sweep. */
function harness() {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-acp-owned-'))
  installAdapterStub(appPath, 'codex-acp')
  const launches: { launch: AgentProcessLaunch; child: ChildProcessWithoutNullStreams }[] = []
  const sweeps: string[][] = []
  const manager = createAcpSessionManager({
    appPath,
    environment: { PATH: '/usr/bin' },
    spawnAgent: (launch) => {
      const child = stubAdapterChild()
      launches.push({ launch, child })
      return child
    },
    endOwnedProcesses: async (owners) => {
      sweeps.push([...owners])
    }
  })
  const markOf = (index: number): string | undefined => launches[index]?.launch.options.env?.[PROCESS_OWNER_ENV]
  return { manager, launches, sweeps, markOf }
}

test("a ticket session's adapter carries an owner mark of its own; nothing else carries one", () => {
  const { manager, markOf } = harness()
  void manager.create({ id: 'ticket', provider: 'codex', cwd: '/wt', orchestrated: true }, owner)
  void manager.create({ id: 'ticket-2', provider: 'codex', cwd: '/wt2', orchestrated: true }, owner)
  void manager.create({ id: 'plain', provider: 'codex', cwd: '/project' }, owner)
  assert.ok(markOf(0))
  assert.ok(markOf(1))
  assert.notEqual(markOf(0), markOf(1))
  assert.equal(markOf(2), undefined)
  manager.killAll()
})

test('a mark Toucan inherited is never handed on: it names the session Toucan itself runs under', () => {
  const inherited = { PATH: '/usr/bin', [PROCESS_OWNER_ENV]: 'outer' }
  assert.equal(agentProcessEnvironment(inherited, 'n')[PROCESS_OWNER_ENV], undefined)
  assert.equal(agentProcessEnvironment(inherited, 'n', { processOwner: 'inner' })[PROCESS_OWNER_ENV], 'inner')
})

test('stopping a ticket session ends what carries its mark, after its tree and without waiting for it', async () => {
  const { manager, launches, sweeps, markOf } = harness()
  void manager.create({ id: 'ticket', provider: 'codex', cwd: '/wt', orchestrated: true }, owner)
  let killed = false
  Object.assign(launches[0]!.child, { kill: () => (killed = true) })
  manager.kill('ticket')
  assert.deepEqual(sweeps, [])
  await settled()
  assert.ok(killed)
  assert.deepEqual(sweeps, [[markOf(0)]])
})

test('a ticket session whose adapter already exited still has its orphans ended when it is stopped', async () => {
  const { manager, launches, sweeps, markOf } = harness()
  void manager.create({ id: 'ticket', provider: 'codex', cwd: '/wt', orchestrated: true }, owner)
  launches[0]!.child.emit('exit', 1, null)
  await settled()
  assert.deepEqual(sweeps, [], 'an adapter exiting on its own is no stop')
  manager.kill('ticket')
  await settled()
  assert.deepEqual(sweeps, [[markOf(0)]])
  // Swept once: a second stop has nothing left to end.
  manager.kill('ticket')
  await settled()
  assert.equal(sweeps.length, 1)
})

test('a relaunched ticket session ends the exited launch and its own on its stop, never a later one', async () => {
  const { manager, launches, sweeps, markOf } = harness()
  void manager.create({ id: 'ticket', provider: 'codex', cwd: '/wt', orchestrated: true }, owner)
  launches[0]!.child.emit('exit', 1, null)
  void manager.create({ id: 'ticket', provider: 'codex', cwd: '/wt', orchestrated: true }, owner)
  manager.kill('ticket')
  // The stopped launch's pending `initialize` fails once its pipe closes and stops the node again,
  // which would also stop a relaunch made before that.
  await new Promise((done) => setTimeout(done, 50))
  void manager.create({ id: 'ticket', provider: 'codex', cwd: '/wt', orchestrated: true }, owner)
  await settled()
  assert.deepEqual(sweeps, [[markOf(0), markOf(1)]])
  assert.ok(!sweeps[0]!.includes(markOf(2)!))
  manager.killAll()
})

test('an ordinary session has nothing swept, and neither does a quitting Toucan', async () => {
  const { manager, sweeps } = harness()
  void manager.create({ id: 'plain', provider: 'codex', cwd: '/project' }, owner)
  manager.kill('plain')
  void manager.create({ id: 'ticket', provider: 'codex', cwd: '/wt', orchestrated: true }, owner)
  // Nothing runs after a quit: a sweep started there would die with Toucan half-way.
  manager.killAll()
  await settled()
  assert.deepEqual(sweeps, [])
})

test("a closing window ends its ticket sessions' marked processes too", async () => {
  const { manager, sweeps, markOf } = harness()
  void manager.create({ id: 'ticket', provider: 'codex', cwd: '/wt', orchestrated: true }, owner)
  manager.killOwned(owner)
  await settled()
  assert.deepEqual(sweeps, [[markOf(0)]])
})
