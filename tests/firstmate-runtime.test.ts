import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
    ...['node', 'git', 'gh', 'tmux', 'jq', 'claude', 'codex', 'treehouse', 'no-mistakes', 'gh-axi',
      'chrome-devtools-axi', 'lavish-axi', 'tasks-axi', 'quota-axi'].map((tool) => `tool.${tool}=1`),
    'wrapper.claude=1',
    'wrapper.codex=1',
    'daemon.no-mistakes=1',
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
    supervision: 'app-native',
    distribution: 'Ubuntu',
    message: 'ADE will provision FirstMate, native Claude and Codex agents, tmux, and the managed review toolchain in Ubuntu.'
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
  const launch = runtime.launch('codex', 'gpt-5.6-sol')
  const inspection = calls[0]?.at(-1) ?? ''

  assert.equal(status.state, 'ready')
  assert.equal(status.host, 'wsl')
  assert.equal(status.backend, 'tmux')
  assert.equal(status.githubAuth, 'required')
  assert.equal(status.codexProjectTrust, 'required')
  assert.match(
    inspection,
    /export PATH="\$HOME\/\.local\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin"/,
    'runtime checks must ignore Windows shims that the Linux no-mistakes daemon cannot execute'
  )
  assert.equal(launch?.cwd, '/home/tucaen/.local/share/ade/firstmate/distro')
  assert.equal(launch?.agentProcess?.executable, 'C:\\Windows\\System32\\wsl.exe')
  assert.deepEqual(launch?.agentProcess?.args.slice(0, 6), [
    '--distribution', 'Ubuntu',
    '--cd', '/home/tucaen/.local/share/ade/firstmate/distro',
    '--exec', '/bin/sh'
  ])
  assert.ok(launch?.agentProcess?.args.includes('FM_BACKEND=tmux'))
  assert.ok(launch?.agentProcess?.args.includes('NM_HOME=/home/tucaen/.local/share/ade/firstmate/home/no-mistakes'))
  assert.ok(launch?.agentProcess?.args.includes('FM_SUPERVISOR_BACKEND=ade'))
  assert.ok(launch?.agentProcess?.args.includes('FM_SUPERVISOR_TARGET=ade-firstmate-acp'))
  assert.ok(launch?.agentProcess?.args.includes('ADE_FIRSTMATE_RUNTIME_CONFIG=/home/tucaen/.local/share/ade/firstmate/home/config/ade-runtime.json'))
  assert.ok(launch?.agentProcess?.args.includes('ADE_FIRSTMATE_VALIDATOR_AGENT=codex'))
  assert.ok(launch?.agentProcess?.args.includes('ADE_FIRSTMATE_VALIDATOR_MODEL=gpt-5.6-sol'))
  assert.ok(launch?.agentProcess?.args.includes('/home/tucaen/.local/share/ade/firstmate/runner/node_modules/@agentclientprotocol/codex-acp/dist/index.js'))
  assert.ok(launch?.agentProcess?.args.includes('codex'))
  assert.match(calls[0].at(-1) ?? '', /in_section && \/\^\\\[\//)
  const claudeLaunch = (runtime.launch as (provider?: 'codex' | 'claude') => typeof launch)('claude')
  assert.ok(claudeLaunch?.agentProcess?.args.includes('/home/tucaen/.local/share/ade/firstmate/runner/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'))
  assert.ok(
    claudeLaunch?.agentProcess?.args.some((arg) => arg.includes('agent_path_override:')) &&
      claudeLaunch.agentProcess.args.includes('claude'),
    'the selected FirstMate provider should become the no-mistakes pipeline agent'
  )
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
  const managedCredential = launchArgs.indexOf('/home/tucaen/.local/share/ade/firstmate/home/codex/auth.json')
  assert.equal(launchArgs[managedCredential + 1], 'codex')
  assert.equal(launchArgs[managedCredential + 2], '/home/tucaen/.local/share/ade/firstmate/home/no-mistakes/config.yaml')
  assert.ok(launchArgs.some((arg) => arg.includes('cp "$host_auth" "$managed_auth"')))
})

test('reuses host Claude credentials inside an isolated Linux config home', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'ade-firstmate-wsl-claude-auth-'))
  const runtime = createFirstMateRuntime({
    rootPath,
    platform: 'win32',
    claudeHome: 'C:\\Users\\tester\\.claude',
    resolveGit: () => 'git.exe',
    wsl: {
      run: async () => ({ stdout: readyWslInspection(), stderr: '' })
    }
  })

  await runtime.status()

  const launch = runtime.launch('claude')
  const launchArgs = launch?.agentProcess?.args ?? []
  assert.ok(launchArgs.includes('CLAUDE_CONFIG_DIR=/home/tucaen/.local/share/ade/firstmate/home/claude'))
  const managedCredential = launchArgs.indexOf('/home/tucaen/.local/share/ade/firstmate/home/claude/.credentials.json')
  assert.equal(launchArgs[managedCredential + 1], 'claude')
  assert.equal(launchArgs[managedCredential + 2], '/home/tucaen/.local/share/ade/firstmate/home/no-mistakes/config.yaml')
  assert.match(
    launchArgs.join(' '),
    /\/mnt\/c\/Users\/tester\/\.claude\/\.credentials\.json[\s\S]*?\/home\/tucaen\/\.local\/share\/ade\/firstmate\/home\/claude\/\.credentials\.json/,
    'FirstMate should bootstrap only the existing file-backed Claude credential'
  )
  assert.ok(launch?.authProcess?.(['--cli', 'auth', 'login', '--claudeai']).args.includes('--claudeai'))
})

test('keeps provider-specific Codex App Server configuration out of the Claude launch', async () => {
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
  assert.doesNotMatch(launchArgs.join(' '), /APP_SERVER_LOGS|codex-acp/)
  assert.ok(
    launchArgs.includes('CODEX_HOME=/home/tucaen/.local/share/ade/firstmate/home/codex'),
    'all providers should receive the authoritative validator homes explicitly'
  )
  assert.match(launchArgs.join(' '), /claude-agent-acp/)
})

test('continues validation with the persisted runtime validator instead of guessed home configuration', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'ade-firstmate-wsl-continue-'))
  const calls: string[][] = []
  const runtimeConfig = JSON.stringify({
    version: 1,
    host: { kind: 'ade-app', supervisor: 'app-native', terminalTarget: false },
    validator: {
      agent: 'codex',
      model: 'gpt-5.6-sol',
      nmHome: '/home/tucaen/.local/share/ade/firstmate/home/no-mistakes',
      agentHome: '/home/tucaen/.local/share/ade/firstmate/home/codex'
    }
  })
  const runtime = createFirstMateRuntime({
    rootPath,
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: {
      run: async (args) => {
        calls.push(args)
        if (args.includes('-e')) {
          return {
            stdout: JSON.stringify({
              runtimeConfig,
              tasks: [{
                id: 'resize',
                meta: 'kind=ship\nmode=no-mistakes\nharness=codex\n',
                status: 'done: committed implementation\n'
              }]
            }),
            stderr: ''
          }
        }
        return { stdout: readyWslInspection(), stderr: '' }
      }
    }
  })

  await runtime.status()
  const result = await runtime.continueValidation('resize')

  assert.equal(result.ok, true)
  const continuation = calls.find((args) => args.some((arg) => arg.endsWith('/bin/fm-send.sh')))
  assert.ok(continuation)
  assert.ok(continuation.includes('resize'))
  const continuationPrompt = continuation.find((arg) => arg.startsWith('$no-mistakes')) ?? ''
  assert.match(continuationPrompt, /ade-runtime\.json/)
  assert.match(continuationPrompt, /do not infer the validator from filtered doctor text or guessed homes/i)
  assert.ok(continuation.includes('ADE_FIRSTMATE_RUNTIME_CONFIG=/home/tucaen/.local/share/ade/firstmate/home/config/ade-runtime.json'))
  assert.ok(continuation.includes('ADE_FIRSTMATE_VALIDATOR_AGENT=codex'))
  assert.ok(continuation.includes('ADE_FIRSTMATE_VALIDATOR_MODEL=gpt-5.6-sol'))
  assert.ok(continuation.includes('NM_HOME=/home/tucaen/.local/share/ade/firstmate/home/no-mistakes'))
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
  assert.match(prepare.at(-1) ?? '', /@openai\/codex@/)
  assert.match(prepare.at(-1) ?? '', /@anthropic-ai\/claude-code@/)
  assert.match(prepare.at(-1) ?? '', /@agentclientprotocol\/claude-agent-acp@/)
  assert.match(
    prepare.at(-1) ?? '',
    /ln -sfn "\$base\/runner\/node_modules\/\.bin\/codex" "\$HOME\/\.local\/bin\/codex"/,
    'the native Linux Codex bundled with codex-acp should be on FirstMate and no-mistakes daemon PATH'
  )
  assert.match(
    prepare.at(-1) ?? '',
    /ln -sfn "\$base\/runner\/node_modules\/\.bin\/claude" "\$HOME\/\.local\/bin\/claude"/,
    'the native Linux Claude CLI should be on FirstMate and no-mistakes daemon PATH'
  )
  assert.match(prepare.at(-1) ?? '', /NM_HOME="\$base\/home\/no-mistakes"/)
  assert.match(prepare.at(-1) ?? '', /CLAUDE_CONFIG_DIR="\$base\/home\/claude"/)
  assert.match(prepare.at(-1) ?? '', /no-mistakes daemon restart/)
})

test('repairs a WSL runtime whose daemon PATH has no native Codex CLI', async () => {
  const inspectionWithoutCodex = readyWslInspection()
    .split('\n')
    .filter((line) => line !== 'tool.codex=1')
    .join('\n')
  const runtime = createFirstMateRuntime({
    rootPath: mkdtempSync(join(tmpdir(), 'ade-firstmate-wsl-no-codex-')),
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: { run: async () => ({ stdout: inspectionWithoutCodex, stderr: '' }) }
  })

  assert.equal((await runtime.status()).state, 'missing')
  assert.equal(runtime.launch(), null)
})

test('repairs a WSL runtime whose daemon PATH has no native Claude CLI', async () => {
  const inspectionWithoutClaude = readyWslInspection()
    .split('\n')
    .filter((line) => line !== 'tool.claude=1')
    .join('\n')
  const runtime = createFirstMateRuntime({
    rootPath: mkdtempSync(join(tmpdir(), 'ade-firstmate-wsl-no-claude-')),
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: { run: async () => ({ stdout: inspectionWithoutClaude, stderr: '' }) }
  })

  assert.equal((await runtime.status()).state, 'missing')
  assert.equal(runtime.launch('claude'), null)
})

test('installs one distro and prepares one isolated operational home', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'ade-firstmate-install-'))
  const runtime = createFirstMateRuntime({
    rootPath,
    platform: 'linux',
    environment: { ...process.env, TMUX: '/tmp/unrelated-tmux', TMUX_PANE: '%0' },
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
  const launch = runtime.launch('codex', 'gpt-5.6-sol')
  assert.equal(launch?.cwd, join(rootPath, 'distro'))
  assert.equal(launch?.environment.FM_HOME, join(rootPath, 'home'))
  assert.equal(launch?.environment.FM_BACKEND, 'tmux')
  assert.equal(launch?.environment.FM_SUPERVISOR_BACKEND, 'ade')
  assert.equal(launch?.environment.FM_SUPERVISOR_TARGET, 'ade-firstmate-acp')
  assert.equal(
    launch?.environment.ADE_FIRSTMATE_RUNTIME_CONFIG,
    join(rootPath, 'home', 'config', 'ade-runtime.json')
  )
  assert.equal(launch?.environment.ADE_FIRSTMATE_VALIDATOR_AGENT, 'codex')
  assert.equal(launch?.environment.ADE_FIRSTMATE_VALIDATOR_MODEL, 'gpt-5.6-sol')
  assert.equal(launch?.environment.TMUX, undefined, 'an inherited terminal pane must not become captain')
  assert.equal(launch?.environment.TMUX_PANE, undefined, 'an inherited terminal pane must not become captain')
  assert.equal(typeof launch?.prepare, 'function')
  const structuredRuntime = JSON.parse(
    readFileSync(join(rootPath, 'home', 'config', 'ade-runtime.json'), 'utf8')
  )
  assert.deepEqual(structuredRuntime.host, {
    kind: 'ade-app',
    supervisor: 'app-native',
    terminalTarget: false
  })
  assert.deepEqual(structuredRuntime.validator, {
      agent: 'codex',
      model: 'gpt-5.6-sol',
      nmHome: join(rootPath, 'home', 'no-mistakes'),
      agentHome: join(rootPath, 'home', 'codex')
  })
  assert.match(readFileSync(join(rootPath, 'home', 'no-mistakes', 'config.yaml'), 'utf8'), /^agent: codex$/m)
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

test('registers an ADE checkout as a durable external project inside the private home', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'ade-firstmate-external-'))
  writeDistro(join(rootPath, 'distro'))
  mkdirSync(join(rootPath, 'home', 'data'), { recursive: true })
  writeFileSync(
    join(rootPath, 'home', 'data', 'projects.md'),
    '# Projects\n\n- firstmate [no-mistakes] - the managed distro (added 2026-01-01)\n',
    'utf8'
  )
  const options = {
    rootPath,
    platform: 'linux' as const,
    resolveGit: (): string => '/usr/bin/git',
    inspectCheckout: async (): Promise<{ exists: boolean; origin?: string }> => ({
      exists: true,
      origin: 'git@github.com:acme/alpha-api.git'
    })
  }
  const runtime = createFirstMateRuntime(options)

  const registered = await runtime.registerProject({
    projectId: 'alpha',
    name: 'Api',
    path: 'D:\\Development\\alpha\\api'
  })
  const afterRestart = await createFirstMateRuntime(options).recordedProject('alpha')

  assert.equal(registered.ok, true)
  assert.equal(registered.project?.registryName, 'api')
  assert.equal(registered.project?.wslPath, '/mnt/d/Development/alpha/api')
  assert.equal(registered.project?.mode, 'no-mistakes-prod-only')
  assert.equal(registered.project?.initialization, 'required')
  assert.deepEqual(afterRestart, registered.project)

  const store = JSON.parse(readFileSync(join(rootPath, 'home', 'data', 'ade-external-projects.json'), 'utf8'))
  assert.equal(store.version, 1)
  assert.equal(store.projects.alpha.windowsPath, 'D:\\Development\\alpha\\api')
  assert.equal(
    readFileSync(join(rootPath, 'home', 'data', 'projects.md'), 'utf8'),
    '# Projects\n\n- firstmate [no-mistakes] - the managed distro (added 2026-01-01)\n',
    'the firstmate-private fleet registry belongs to the captain and is only read'
  )
  assert.equal(
    existsSync(join(rootPath, 'home', 'projects', 'api')),
    false,
    'an external project must never be cloned or linked into the managed projects directory'
  )
})

test('keeps the external-project mapping inside the WSL FirstMate home', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'ade-firstmate-external-wsl-'))
  const files: { store?: string; registry?: string } = {}
  const calls: string[][] = []
  const runtime = createFirstMateRuntime({
    rootPath,
    platform: 'win32',
    resolveGit: () => 'git.exe',
    inspectCheckout: async () => ({ exists: true }),
    wsl: {
      run: async (args) => {
        calls.push(args)
        if (args[3] === '/bin/sh') return { stdout: readyWslInspection(), stderr: '' }
        const script = args[5] ?? ''
        if (script.includes('renameSync')) {
          files.store = Buffer.from(args.at(-1) ?? '', 'base64url').toString('utf8')
          return { stdout: '', stderr: '' }
        }
        return { stdout: JSON.stringify(files), stderr: '' }
      }
    }
  })

  const registered = await runtime.registerProject({
    projectId: 'alpha',
    name: 'Api',
    path: 'D:\\Development\\alpha\\api'
  })

  assert.equal(registered.ok, true)
  assert.equal(registered.project?.mode, 'local-only', 'a checkout with no origin stays local-only')
  assert.equal(registered.project?.initialization, 'not-required')
  assert.equal(
    JSON.parse(files.store ?? '{}').projects.alpha.wslPath,
    '/mnt/d/Development/alpha/api'
  )
  assert.equal(files.registry, undefined, 'the firstmate-private fleet registry is only ever read')

  const homeCalls = calls.filter((args) => args[3] === '/usr/bin/node')
  assert.ok(homeCalls.length >= 2, 'the mapping is read and written through the private WSL home')
  for (const args of homeCalls) {
    assert.ok(
      args.includes('/home/tucaen/.local/share/ade/firstmate/home'),
      'every mapping call targets ADE\'s private FirstMate home'
    )
  }
  assert.equal(
    calls.some((args) => args.some((argument) => /\bgit clone\b|ln -s|\/home\/projects\//.test(argument))),
    false,
    'registration must never clone or link the checkout into the managed projects directory'
  )
})
