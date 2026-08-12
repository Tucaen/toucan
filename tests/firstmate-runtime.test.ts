import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFirstMateRuntime } from '../src/main/firstmate-runtime'

function writeDistro(path: string): void {
  mkdirSync(join(path, 'bin'), { recursive: true })
  writeFileSync(join(path, 'AGENTS.md'), '# FirstMate\n', 'utf8')
  writeFileSync(join(path, 'bin', 'fm-spawn.sh'), '#!/bin/sh\n', 'utf8')
}

test('reports the managed paths and Windows worker requirement before installation', () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'ade-firstmate-status-'))
  const runtime = createFirstMateRuntime({
    rootPath,
    platform: 'win32',
    resolveGit: () => 'git.exe'
  })

  assert.deepEqual(runtime.status(), {
    state: 'missing',
    distroPath: join(rootPath, 'distro'),
    homePath: join(rootPath, 'home'),
    workerSupport: 'wsl_required',
    message: 'FirstMate workers require a Linux runtime. Configure WSL with tmux and the FirstMate toolchain.'
  })
  assert.equal(runtime.launch(), null)
})

test('installs one distro and prepares one isolated operational home', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'ade-firstmate-install-'))
  const runtime = createFirstMateRuntime({
    rootPath,
    platform: 'linux',
    resolveGit: () => '/usr/bin/git',
    clone: async (_git, repository, target) => {
      assert.equal(repository, 'https://github.com/kunchenguid/firstmate.git')
      writeDistro(target)
    }
  })

  const result = await runtime.install()

  assert.equal(result.ok, true)
  assert.equal(result.status.state, 'ready')
  for (const directory of ['data', 'state', 'config', 'projects']) {
    assert.equal(existsSync(join(rootPath, 'home', directory)), true)
  }
  assert.deepEqual(runtime.launch(), {
    cwd: join(rootPath, 'distro'),
    environment: { ...process.env, FM_HOME: join(rootPath, 'home') }
  })
})

test('preserves an incomplete distro directory instead of overwriting it', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'ade-firstmate-incomplete-'))
  const distroPath = join(rootPath, 'distro')
  mkdirSync(distroPath)
  writeFileSync(join(distroPath, 'keep-me.txt'), 'user data', 'utf8')
  const runtime = createFirstMateRuntime({
    rootPath,
    platform: 'linux',
    resolveGit: () => '/usr/bin/git'
  })

  const result = await runtime.install()

  assert.equal(result.ok, false)
  assert.equal(result.status.state, 'error')
  assert.match(result.status.message ?? '', /exists but is incomplete/)
  assert.equal(existsSync(join(distroPath, 'keep-me.txt')), true)
})
