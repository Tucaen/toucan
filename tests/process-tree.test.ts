import { strict as assert } from 'node:assert'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  descendantsOf,
  killProcessTree,
  killProcessTreesNow,
  parseWindowsSnapshot,
  processesInside,
  releaseFolder,
  type ProcessRecord
} from '../src/main/process-tree'

const record = (pid: number, ppid: number, extra: Partial<ProcessRecord> = {}): ProcessRecord => ({
  pid,
  ppid,
  ...extra
})

test('descendants follow parent links through every generation', () => {
  const table = [record(1, 0), record(10, 1), record(11, 10), record(12, 11), record(20, 1), record(30, 99)]
  assert.deepEqual(descendantsOf(table, [10]).sort(), [11, 12])
  assert.deepEqual(
    descendantsOf(table, [1]).sort((a, b) => a - b),
    [10, 11, 12, 20]
  )
})

test('a process older than the parent its PID names is no descendant: the PID was reused', () => {
  // 11 was started before 10 existed, so its parent was an earlier process that held PID 10.
  const table = [record(10, 1, { started: 500 }), record(11, 10, { started: 100 }), record(12, 10, { started: 600 })]
  assert.deepEqual(descendantsOf(table, [10]), [12])
})

test('descendants survive a parent-link cycle without looping', () => {
  const table = [record(1, 2), record(2, 1)]
  assert.deepEqual(descendantsOf(table, [1]), [2])
})

test('processes working or running from inside the folder are selected with their descendants', () => {
  const table = [
    record(1, 0, { cwd: 'C:\\Users\\me' }),
    // An orphan whose parent is gone: npm in the worktree, its watcher below it elsewhere.
    record(100, 4242, { cwd: 'C:\\Dev\\wt\\ticket-1\\' }),
    record(101, 100, { cwd: 'C:\\Dev\\wt\\ticket-1\\apps\\api\\' }),
    record(102, 101, { cwd: 'C:\\Users\\me\\' }),
    // An app binary built into the worktree, started from somewhere else.
    record(200, 1, { cwd: 'C:\\', executable: 'C:\\Dev\\wt\\ticket-1\\bin\\app.exe' }),
    // A sibling worktree whose name merely starts with the same characters.
    record(300, 1, { cwd: 'C:\\Dev\\wt\\ticket-10\\' }),
    // The user's own dev server in the main checkout.
    record(400, 1, { cwd: 'C:\\Dev\\project\\' })
  ]
  assert.deepEqual(
    processesInside(table, 'C:\\Dev\\wt\\ticket-1', { self: 1 }).sort((a, b) => a - b),
    [100, 101, 102, 200]
  )
})

test('folder matching ignores case, separator style and the extended-length prefix on Windows paths', () => {
  const table = [
    record(5, 0, { cwd: '\\\\?\\c:\\dev\\WT\\Ticket-1\\src' }),
    record(6, 0, { cwd: 'c:/dev/wt/ticket-1' })
  ]
  assert.deepEqual(processesInside(table, 'C:\\Dev\\wt\\ticket-1\\', { self: 1 }).sort(), [5, 6])
})

test('Toucan itself and every ancestor of it are never selected, even from inside the folder', () => {
  const table = [
    record(7, 1, { cwd: '/work/wt/t1' }),
    record(8, 7, { cwd: '/work/wt/t1' }),
    record(9, 8, { cwd: '/work/wt/t1' }),
    record(10, 9, { cwd: '/work/wt/t1' })
  ]
  // Toucan is 9: a dev build started from a shell in the worktree being removed.
  assert.deepEqual(processesInside(table, '/work/wt/t1', { self: 9 }), [10])
})

test('the Windows snapshot parses tab-separated rows and leaves unreadable fields absent', () => {
  const output = [
    '100\t4\t133000000000000000\tC:\\Program Files\\dotnet\\dotnet.exe\tC:\\Dev\\wt\\ticket-1\\',
    '101\t100\t0\t\t',
    'garbage',
    ''
  ].join('\r\n')
  assert.deepEqual(parseWindowsSnapshot(output), [
    {
      pid: 100,
      ppid: 4,
      started: 133000000000000000,
      executable: 'C:\\Program Files\\dotnet\\dotnet.exe',
      cwd: 'C:\\Dev\\wt\\ticket-1\\'
    },
    { pid: 101, ppid: 100 }
  ])
})

/** A process that stays alive until killed, started in `cwd`; its own child too when `child`. */
function sleeper(cwd: string, child?: { cwd: string; detached?: boolean }): ChildProcess {
  const inner = child
    ? `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: ${JSON.stringify(child.cwd)}, stdio: 'ignore', detached: ${Boolean(child.detached)}, windowsHide: true }); c.unref(); process.stdout.write(String(c.pid) + '\\n');`
    : `process.stdout.write('0\\n');`
  return spawn(process.execPath, ['-e', `${inner} setInterval(() => {}, 1000)`], {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
}

const firstLine = (child: ChildProcess): Promise<number> =>
  new Promise((resolve, reject) => {
    let text = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      text += chunk.toString()
      if (text.includes('\n')) resolve(Number(text.trim()))
    })
    child.on('error', reject)
  })

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(condition: () => boolean, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (condition()) return true
    await new Promise((wait) => setTimeout(wait, 100))
  }
  return condition()
}

test('killing a session tree takes the grandchildren a parent kill alone would leave behind', async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'toucan-tree-')))
  const parent = sleeper(folder, { cwd: folder })
  parent.on('error', () => {})
  const grandchild = await firstLine(parent)
  try {
    assert.ok(alive(grandchild))
    killProcessTree(parent)
    assert.ok(await waitUntil(() => !alive(grandchild)), 'the grandchild outlived its tree')
    assert.ok(await waitUntil(() => parent.exitCode !== null || parent.signalCode !== null))
  } finally {
    if (alive(grandchild)) process.kill(grandchild)
    parent.kill()
    rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}, 30_000)

test('a teardown ends every tree before returning, even beside a root that has already exited', async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'toucan-teardown-')))
  const parents = [sleeper(folder, { cwd: folder }), sleeper(folder, { cwd: folder })]
  for (const parent of parents) parent.on('error', () => {})
  const grandchildren = await Promise.all(parents.map(firstLine))
  const gone = sleeper(folder)
  gone.on('error', () => {})
  await firstLine(gone)
  const goneExited = new Promise((done) => gone.once('exit', done))
  gone.kill()
  await goneExited
  try {
    killProcessTreesNow([gone, ...parents])
    // Synchronous: the trees are ended by the time it returns, give or take the OS reaping them.
    assert.ok(await waitUntil(() => grandchildren.every((pid) => !alive(pid)), 2_000), 'a grandchild outlived teardown')
  } finally {
    for (const pid of grandchildren) if (alive(pid)) process.kill(pid)
    for (const parent of parents) parent.kill()
    rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}, 30_000)

test('releasing a folder ends an orphan working inside it and spares a process working elsewhere', async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'toucan-release-')))
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'toucan-elsewhere-')))
  // The parent starts the orphan-to-be and is then killed alone, so nothing links it to a session.
  const parent = sleeper(elsewhere, { cwd: folder, detached: true })
  parent.on('error', () => {})
  const orphan = await firstLine(parent)
  const bystander = sleeper(elsewhere)
  bystander.on('error', () => {})
  await firstLine(bystander)
  try {
    parent.kill()
    await waitUntil(() => parent.exitCode !== null || parent.signalCode !== null)
    assert.ok(alive(orphan))
    const released = await releaseFolder(folder)
    assert.ok(released.includes(orphan), `released ${released.join(', ')} without ${orphan}`)
    assert.ok(await waitUntil(() => !alive(orphan)), 'the orphan outlived the release')
    assert.ok(alive(bystander.pid!), 'a process outside the folder was killed')
  } finally {
    if (alive(orphan)) process.kill(orphan)
    bystander.kill()
    rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    rmSync(elsewhere, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}, 120_000)
