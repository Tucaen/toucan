import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createSetupCommandRunner, setupCommandLaunch } from '../src/main/setup-command'

// A ticket worktree's setup command (#34) runs to completion in the terminal's own shell before
// the ticket session starts.

test('the setup command runs in the shell a terminal would use, once, and exits', () => {
  assert.deepEqual(
    setupCommandLaunch({ executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: ['-NoLogo'] }, 'npm ci'),
    {
      executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      args: ['-NoLogo', '-NonInteractive', '-Command', 'npm ci']
    }
  )
  assert.deepEqual(setupCommandLaunch({ executable: 'C:\\Windows\\system32\\cmd.exe', args: [] }, 'npm ci').args, [
    '/d',
    '/s',
    '/c',
    'npm ci'
  ])
  assert.deepEqual(setupCommandLaunch({ executable: '/bin/bash', args: [] }, 'npm ci').args, ['-c', 'npm ci'])
})

test.runIf(process.platform === 'win32')('a setup command reports success, and failure with its output', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'toucan-setup-command-'))
  const run = createSetupCommandRunner({
    shell: { resolveLaunch: () => ({ executable: process.env.ComSpec ?? 'cmd.exe', args: [] }) }
  })
  assert.deepEqual(await run('echo ready> marker.txt', cwd), { ok: true })
  assert.ok(existsSync(join(cwd, 'marker.txt')), 'the command ran in the worktree')

  const failed = await run('echo dependency install broke && exit 3', cwd)
  assert.equal(failed.ok, false)
  assert.match(!failed.ok ? failed.error : '', /dependency install broke/)
})

test.runIf(process.platform === 'win32')(
  'a setup command past its bound is killed with its children and reported',
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'toucan-setup-command-'))
    const run = createSetupCommandRunner({
      shell: { resolveLaunch: () => ({ executable: process.env.ComSpec ?? 'cmd.exe', args: [] }) },
      timeoutMs: 500
    })
    const started = Date.now()
    // A grandchild holding the pipes open, like an `npm install` under the shell.
    const result = await run('ping -n 30 127.0.0.1', cwd)
    assert.equal(result.ok, false)
    assert.match(!result.ok ? result.error : '', /timed out/)
    assert.ok(Date.now() - started < 10_000, 'answered at the bound, not when the child finished')
  }
)
