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

function readyWslInspection(): string {
  return [
    'home=/home/tucaen',
    'distro=1',
    'runner.codex=1',
    'runner.claude=1',
    ...['node', 'git', 'gh', 'tmux', 'jq', 'treehouse', 'no-mistakes', 'gh-axi',
      'chrome-devtools-axi', 'lavish-axi', 'tasks-axi', 'quota-axi'].map((tool) => `tool.${tool}=1`),
    'githubAuth=required',
    'codexTrust=required'
  ].join('\n')
}

test('reports the managed Ubuntu runtime before WSL provisioning', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'ade-firstmate-status-'))
  const runtime = createFirstMateRuntime({
    rootPath,
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: {
      run: async () => ({ stdout: 'home=/home/tucaen\ntool.git=1\n', stderr: '' })
    }
  })

  assert.deepEqual(await runtime.status(), {
    state: 'missing',
    distroPath: '/home/tucaen/.local/share/ade/firstmate/distro',
    homePath: '/home/tucaen/.local/share/ade/firstmate/home',
    host: 'wsl',
    backend: 'tmux',
    distribution: 'Ubuntu',
    message: 'ADE will provision FirstMate, Codex and Claude ACP, tmux, and 14 supporting tools in Ubuntu.'
  })
  assert.equal(runtime.launch(), null)
})

test('builds the Linux ACP launch only after the complete WSL runtime is ready', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'ade-firstmate-wsl-ready-'))
  const calls: string[][] = []
  const runtime = createFirstMateRuntime({
    rootPath,
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: {
      executable: 'C:\\Windows\\System32\\wsl.exe',
      run: async (args) => {
        calls.push(args)
        return { stdout: readyWslInspection(), stderr: '' }
      }
    }
  })

  const status = await runtime.status()
  const launch = runtime.launch()

  assert.equal(status.state, 'ready')
  assert.equal(status.host, 'wsl')
  assert.equal(status.backend, 'tmux')
  assert.equal(status.githubAuth, 'required')
  assert.equal(status.codexProjectTrust, 'required')
  assert.equal(launch?.cwd, '/home/tucaen/.local/share/ade/firstmate/distro')
  assert.equal(launch?.agentProcess?.executable, 'C:\\Windows\\System32\\wsl.exe')
  assert.deepEqual(launch?.agentProcess?.args.slice(0, 6), [
    '--distribution', 'Ubuntu',
    '--cd', '/home/tucaen/.local/share/ade/firstmate/distro',
    '--exec', '/bin/sh'
  ])
  assert.ok(launch?.agentProcess?.args.includes('FM_BACKEND=tmux'))
  assert.ok(launch?.agentProcess?.args.includes('/home/tucaen/.local/share/ade/firstmate/runner/node_modules/@agentclientprotocol/codex-acp/dist/index.js'))
  assert.match(calls[0].at(-1) ?? '', /in_section && \/\^\\\[\//)
  const claudeLaunch = (runtime.launch as (provider?: 'codex' | 'claude') => typeof launch)('claude')
  assert.ok(claudeLaunch?.agentProcess?.args.includes('/home/tucaen/.local/share/ade/firstmate/runner/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'))
})

test('reuses host Codex credentials without sharing Windows state databases', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'ade-firstmate-wsl-codex-auth-'))
  const runtime = createFirstMateRuntime({
    rootPath,
    platform: 'win32',
    codexHome: 'C:\\Users\\tester\\.codex',
    resolveGit: () => 'git.exe',
    wsl: {
      run: async () => ({ stdout: readyWslInspection(), stderr: '' })
    }
  })

  await runtime.status()

  const launchArgs = runtime.launch()?.agentProcess?.args ?? []
  assert.ok(
    launchArgs.includes('CODEX_HOME=/home/tucaen/.local/share/ade/firstmate/home/codex'),
    'FirstMate should keep its Codex state on the Linux filesystem'
  )
  assert.doesNotMatch(
    launchArgs.join(' '),
    /CODEX_HOME=\/mnt\/c/i,
    'FirstMate must not open Windows SQLite state from WSL'
  )
  assert.match(
    launchArgs.join(' '),
    /\/mnt\/c\/Users\/tester\/\.codex\/auth\.json[\s\S]*?\/home\/tucaen\/\.local\/share\/ade\/firstmate\/home\/codex/,
    'FirstMate should bootstrap only the existing file-backed Codex credentials'
  )
  assert.ok(launchArgs.some((arg) => arg.includes('cp "$host_auth" "$codex_home/auth.json"')))
})

test('keeps Codex App Server configuration out of the Claude provider launch', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'ade-firstmate-wsl-claude-launch-'))
  const runtime = createFirstMateRuntime({
    rootPath,
    platform: 'win32',
    codexHome: 'C:\\Users\\tester\\.codex',
    resolveGit: () => 'git.exe',
    wsl: {
      run: async () => ({ stdout: readyWslInspection(), stderr: '' })
    }
  })

  await runtime.status()

  const launchArgs = runtime.launch('claude')?.agentProcess?.args ?? []
  assert.doesNotMatch(launchArgs.join(' '), /CODEX_HOME|APP_SERVER_LOGS|codex-acp/)
  assert.match(launchArgs.join(' '), /claude-agent-acp/)
})

test('trusts only the managed FirstMate distro after explicit approval', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'ade-firstmate-wsl-trust-'))
  const calls: string[][] = []
  let trusted = false
  const runtime = createFirstMateRuntime({
    rootPath,
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: {
      run: async (args) => {
        calls.push(args)
        if (args.includes('ade-firstmate-trust')) trusted = true
        return {
          stdout: readyWslInspection().replace(
            'codexTrust=required',
            trusted ? 'codexTrust=trusted' : 'codexTrust=required'
          ),
          stderr: ''
        }
      }
    }
  })

  assert.equal((await runtime.status()).codexProjectTrust, 'required')
  const result = await runtime.trustCodexProject()

  assert.equal(result.ok, true)
  assert.equal((await runtime.status()).codexProjectTrust, 'trusted')
  const trustCall = calls.find((args) => args.includes('ade-firstmate-trust'))
  assert.ok(trustCall)
  assert.ok(trustCall.includes('/home/tucaen/.local/share/ade/firstmate/home/codex/config.toml'))
  assert.ok(trustCall.includes('/home/tucaen/.local/share/ade/firstmate/distro'))
  assert.match(trustCall.join(' '), /in_section && \/\^\\\[\//)
  assert.match(trustCall.join(' '), /existing non-trusted section/)
})

test('opens GitHub authentication in the managed Ubuntu environment', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'ade-firstmate-wsl-auth-'))
  let terminal: { title: string; executable: string; args: string[] } | undefined
  const runtime = createFirstMateRuntime({
    rootPath,
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: {
      executable: 'wsl.exe',
      run: async () => ({ stdout: readyWslInspection(), stderr: '' }),
      openTerminal: async (title, executable, args) => { terminal = { title, executable, args } }
    }
  })
  await runtime.status()

  const result = await runtime.authenticateGitHub()

  assert.equal(result.ok, true)
  assert.equal(terminal?.title, 'ADE FirstMate - GitHub sign in')
  assert.equal(terminal?.executable, 'wsl.exe')
  assert.ok(terminal?.args.includes('Ubuntu'))
  assert.ok(terminal?.args.includes('gh'))
  assert.ok(terminal?.args.includes('login'))
})

test('provisions Ubuntu packages and the managed FirstMate toolchain', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'ade-firstmate-wsl-install-'))
  const calls: string[][] = []
  const runtime = createFirstMateRuntime({
    rootPath,
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: {
      run: async (args) => {
        calls.push(args)
        const inspecting = args.at(-2) === '-lc' || args.includes('/bin/sh')
        return { stdout: inspecting ? readyWslInspection() : '', stderr: '' }
      }
    }
  })

  const result = await runtime.install()

  assert.equal(result.ok, true)
  assert.equal(result.status.state, 'ready')
  assert.ok(calls.some((args) => args.includes('update') && args.includes('/usr/bin/apt-get')))
  assert.ok(calls.some((args) => args.includes('install') && args.includes('tmux')))
  const prepare = calls.find((args) => args.includes('/bin/bash') && args.includes('-lc'))
  assert.ok(prepare)
  assert.match(prepare.at(-1) ?? '', /mkdir -p "\$HOME\/.local\/bin"/)
  assert.match(prepare.at(-1) ?? '', /NPM_CONFIG_PREFIX="\$HOME\/.local"/)
  assert.match(prepare.at(-1) ?? '', /@agentclientprotocol\/claude-agent-acp@/)
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
    environment: { ...process.env, FM_HOME: join(rootPath, 'home'), FM_BACKEND: 'tmux' }
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
