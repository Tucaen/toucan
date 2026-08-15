import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFirstMateRuntime } from '../src/main/firstmate-runtime'
import {
  firstMateTaskContextFromMetadata,
  firstMateTaskContextMetadata,
  type FirstMateTaskContext
} from '../src/shared/firstmate-task-context'
import { createFirstMateLifecycleCoordinator } from '../src/main/firstmate-lifecycle-coordinator'
import { firstMateRequest } from '../src/renderer/src/firstmate-request-target'
import type { FirstMateLifecycleJournal, FirstMateLifecycleRecord } from '../src/main/firstmate-lifecycle'
import type { FirstMateProjectCatalog, FirstMateProjectRegistration } from '../src/shared/firstmate'
import type { WorkspaceProject } from '../src/shared/terminal'

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

function testWslPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const match = /^([a-zA-Z]):\/(.*)$/.exec(normalized)
  assert.ok(match)
  return `/mnt/${match[1]!.toLocaleLowerCase()}/${match[2]}`
}

function externalGitCrew(label: string): { primary: string; worktree: string; primaryWsl: string; worktreeWsl: string } {
  const root = mkdtempSync(join(tmpdir(), `ade-firstmate-${label}-`))
  const primary = join(root, 'primary')
  const worktree = join(root, 'crew')
  mkdirSync(primary)
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: primary })
  execFileSync('git', ['config', 'user.name', 'ADE Test'], { cwd: primary })
  execFileSync('git', ['config', 'user.email', 'ade@example.invalid'], { cwd: primary })
  writeFileSync(join(primary, 'README.md'), `${label}\n`, 'utf8')
  execFileSync('git', ['add', 'README.md'], { cwd: primary })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: primary })
  execFileSync('git', ['worktree', 'add', '-b', `${label}-crew`, worktree], { cwd: primary })
  const gitCommonDir = (cwd: string): string => execFileSync(
    'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' }
  ).trim().toLocaleLowerCase()
  assert.equal(gitCommonDir(worktree), gitCommonDir(primary), 'crew worktree must derive from its pinned checkout')
  assert.notEqual(worktree.toLocaleLowerCase(), primary.toLocaleLowerCase(), 'crew must never edit the primary checkout')
  return { primary, worktree, primaryWsl: testWslPath(primary), worktreeWsl: testWslPath(worktree) }
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
  assert.equal(
    claudeLaunch?.agentProcess?.args.some((arg) => arg.includes('agent_path_override:')),
    false,
    'switching the conversational captain must not rewrite an underway task\'s validation agent'
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
  assert.equal(launchArgs[managedCredential + 2], 'default')
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
  assert.equal(launchArgs[managedCredential + 2], 'default')
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

test('continues validation with the task-pinned validator after the global provider changes', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'ade-firstmate-wsl-continue-'))
  const calls: string[][] = []
  const runtimeConfig = JSON.stringify({
    version: 1,
    host: { kind: 'ade-app', supervisor: 'app-native', terminalTarget: false },
    validator: {
      agent: 'claude',
      model: 'claude-opus-4-1',
      nmHome: '/home/tucaen/.local/share/ade/firstmate/home/no-mistakes',
      agentHome: '/home/tucaen/.local/share/ade/firstmate/home/claude'
    }
  })
  const context: FirstMateTaskContext = {
    version: 1,
    project: {
      adeProjectId: 'alpha',
      registryName: 'api-alpha',
      windowsPath: 'D:\\Development\\alpha\\api',
      wslPath: '/mnt/d/Development/alpha/api',
      mode: 'no-mistakes',
      autonomy: false
    },
    validator: { agent: 'codex', model: 'gpt-5.6-sol' }
  }
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
                meta: [
                  'kind=ship',
                  'mode=no-mistakes',
                  'yolo=off',
                  'project=/mnt/d/Development/alpha/api',
                  'worktree=/home/tucaen/.treehouse/alpha/resize',
                  'harness=codex',
                  'model=gpt-5.6-sol',
                  firstMateTaskContextMetadata(context)
                ].join('\n'),
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
  const result = await runtime.continueValidation('resize', 'resize.a1b2c3.1')

  assert.equal(result.ok, true)
  const continuation = calls.find((args) => args.some((arg) => arg.endsWith('/bin/fm-send.sh')))
  assert.ok(continuation)
  assert.ok(continuation.includes('resize'))
  const continuationPrompt = continuation.find((arg) => arg.startsWith('$no-mistakes')) ?? ''
  assert.match(continuationPrompt, /state\/resize\.ade-runtime\.json/)
  assert.match(continuationPrompt, /ADE validation dispatch id: resize\.a1b2c3\.1/)
  assert.match(continuationPrompt, /do not use[\s\S]*filtered doctor text, or guessed homes/i)
  assert.ok(continuation.includes('ADE_FIRSTMATE_RUNTIME_CONFIG=/home/tucaen/.local/share/ade/firstmate/home/state/resize.ade-runtime.json'))
  assert.ok(continuation.includes('ADE_FIRSTMATE_VALIDATOR_AGENT=codex'))
  assert.ok(continuation.includes('ADE_FIRSTMATE_VALIDATOR_MODEL=gpt-5.6-sol'))
  assert.ok(continuation.includes('NM_HOME=/home/tucaen/.local/share/ade/firstmate/home/no-mistakes'))
  const configWrite = calls.find((args) => args.includes('/home/tucaen/.local/share/ade/firstmate/home/state/resize.ade-runtime.json'))
  assert.ok(configWrite, 'the pinned runtime record must be durable before the continuation is sent')
  const taskConfig = JSON.parse(Buffer.from(configWrite.at(-1) ?? '', 'base64url').toString('utf8'))
  assert.deepEqual(taskConfig.validator, {
    agent: 'codex',
    model: 'gpt-5.6-sol',
    nmHome: '/home/tucaen/.local/share/ade/firstmate/home/no-mistakes',
    agentHome: '/home/tucaen/.local/share/ade/firstmate/home/codex',
    agentPath: taskConfig.validator.agentPath
  })
  assert.match(
    taskConfig.validator.agentPath,
    /^\/home\/tucaen\/\.local\/share\/ade\/firstmate\/home\/state\/validators\/[a-f0-9]{20}\/codex$/
  )
  assert.deepEqual(taskConfig.project, {
    ...context.project,
    worktree: '/home/tucaen/.treehouse/alpha/resize'
  })
  const wrapperWrite = calls.find((args) => args.includes(taskConfig.validator.agentPath))
  assert.ok(wrapperWrite)
  const wrapper = Buffer.from(wrapperWrite.at(-1) ?? '', 'base64url').toString('utf8')
  assert.match(wrapper, /exec "\$HOME\/\.local\/bin\/codex" --model gpt-5\.6-sol/)
  const pipelineWrite = calls.find((args) => args.includes('/home/tucaen/.local/share/ade/firstmate/home/no-mistakes/config.yaml'))
  assert.ok(pipelineWrite)
  assert.match(
    Buffer.from(pipelineWrite.at(-1) ?? '', 'base64url').toString('utf8'),
    new RegExp(`agent: codex[\\s\\S]*${taskConfig.validator.agentPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  )
})

test('keeps two switched external projects on their original providers through supervision and restart', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'ade-firstmate-two-projects-'))
  const alphaCrew = externalGitCrew('alpha')
  const betaCrew = externalGitCrew('beta')
  const alpha: WorkspaceProject = {
    id: 'alpha', name: 'Api', path: alphaCrew.primary, color: '#71a9ff'
  }
  const beta: WorkspaceProject = {
    id: 'beta', name: 'Api', path: betaCrew.primary, color: '#f0a'
  }
  const registration = (
    project: WorkspaceProject,
    registryName: string,
    wslPath: string
  ): FirstMateProjectRegistration => ({
    ok: true,
    project: {
      adeProjectId: project.id,
      registryName,
      displayName: project.name,
      windowsPath: project.path,
      wslPath,
      origin: `https://github.com/acme/${project.id}.git`,
      mode: 'no-mistakes',
      autonomy: false,
      initialization: 'authorized',
      registeredAt: '2026-08-15'
    }
  })
  const alphaPrompt = firstMateRequest([{
    selection: alpha,
    registration: registration(alpha, 'api-alpha', alphaCrew.primaryWsl)
  }], alpha.id, 'Ship alpha', {
    provider: 'codex',
    model: 'gpt-5.6-sol'
  })
  const betaPrompt = firstMateRequest([{
    selection: beta,
    registration: registration(beta, 'api-beta', betaCrew.primaryWsl)
  }], beta.id, 'Ship beta', {
    provider: 'claude',
    model: 'claude-sonnet-4-5'
  })
  const carrier = (prompt: string): string => {
    const json = /<ade-project-catalog>\n([^\n]+)\n<\/ade-project-catalog>/.exec(prompt)?.[1]
    assert.ok(json)
    const value = (JSON.parse(json) as FirstMateProjectCatalog).projects[0]?.taskContextMetadata
    assert.ok(value)
    return value
  }

  const fakeFirstMateShip = (
    prompt: string,
    id: string,
    worktree: string
  ): { brief: string; task: { id: string; meta: string; status: string } } => {
    const pinnedCarrier = carrier(prompt)
    const context = firstMateTaskContextFromMetadata(pinnedCarrier)
    assert.ok(context)
    const brief = [
      `Project checkout: ${context.project.wslPath}`,
      `Delivery contract: mode=${context.project.mode}`,
      'Work only in the disposable crew worktree.'
    ].join('\n')
    return {
      brief,
      task: {
        id,
        meta: [
          'kind=ship', `mode=${context.project.mode}`, `yolo=${context.project.autonomy ? 'on' : 'off'}`,
          `project=${context.project.wslPath}`, `worktree=${worktree}`,
          `harness=${context.validator.agent}`, `model=${context.validator.model}`, pinnedCarrier
        ].join('\n'),
        status: `done: committed ${context.project.adeProjectId} implementation\n`
      }
    }
  }

  assert.ok(alphaPrompt.includes(alphaCrew.primaryWsl))
  assert.ok(betaPrompt.includes(betaCrew.primaryWsl))
  assert.match(alphaPrompt, /effectiveDeliveryPosture as `--mode`/)
  assert.match(betaPrompt, /effectiveDeliveryPosture as `--mode`/)

  const alphaDispatch = fakeFirstMateShip(alphaPrompt, 'alpha-ship', alphaCrew.worktreeWsl)
  const betaDispatch = fakeFirstMateShip(betaPrompt, 'beta-ship', betaCrew.worktreeWsl)
  assert.match(alphaDispatch.brief, new RegExp(`Project checkout: ${alphaCrew.primaryWsl.replace(/\//g, '\\/')}`))
  assert.match(betaDispatch.brief, /Delivery contract: mode=no-mistakes/)
  const rawTasks = [alphaDispatch.task, betaDispatch.task]
  let journal: FirstMateLifecycleJournal = { version: 1, tasks: {} }
  let mutableGlobalConfig = JSON.stringify({
    version: 1,
    validator: { agent: 'claude', model: 'later-global-model' }
  })
  const sends: string[][] = []
  const taskConfigs = new Map<string, unknown>()

  const run = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    if (args.includes('-lc')) return { stdout: readyWslInspection(), stderr: '' }
    if (args.includes('ade-firstmate-validator')) {
      const marker = args.indexOf('ade-firstmate-validator')
      mutableGlobalConfig = JSON.stringify({
        version: 1,
        validator: { agent: args[marker + 2], model: args[marker + 3] }
      })
      return { stdout: '', stderr: '' }
    }
    const scriptIndex = args.indexOf('-e')
    const script = scriptIndex >= 0 ? args[scriptIndex + 1] ?? '' : ''
    if (script.includes("names.filter((name) => name.endsWith('.meta'))")) {
      return {
        stdout: JSON.stringify({
          runtimeConfig: mutableGlobalConfig,
          journal: JSON.stringify(journal),
          tasks: rawTasks
        }),
        stderr: ''
      }
    }
    if (script.includes('journal.tasks[taskId] = record')) {
      const taskId = args.at(-2) ?? ''
      const record = JSON.parse(Buffer.from(args.at(-1) ?? '', 'base64url').toString('utf8')) as FirstMateLifecycleRecord
      journal = { version: 1, tasks: { ...journal.tasks, [taskId]: record } }
      return { stdout: '', stderr: '' }
    }
    if (args.some((arg) => arg.endsWith('/bin/fm-send.sh'))) {
      sends.push(args)
      return { stdout: '', stderr: '' }
    }
    const configPath = args.find((arg) => /^\/.*\/state\/[^/]+\.ade-runtime\.json$/.test(arg))
    if (configPath) {
      taskConfigs.set(configPath, JSON.parse(Buffer.from(args.at(-1) ?? '', 'base64url').toString('utf8')))
      return { stdout: '', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
  const runtimeOptions = {
    rootPath,
    platform: 'win32' as const,
    resolveGit: () => 'git.exe',
    wsl: { run }
  }
  const wakes: string[] = []
  const runtime = createFirstMateRuntime(runtimeOptions)
  await runtime.status()
  await runtime.configureValidator('claude', 'global-before-alpha')
  const coordinator = createFirstMateLifecycleCoordinator({
    runtime,
    wakeCaptain: async (message) => { wakes.push(message); return { ok: true } }
  })

  await coordinator.poll()

  assert.equal(sends.length, 1, 'the shared no-mistakes gate must validate one pinned provider at a time')
  const alphaSend = sends.find((args) => args.includes('alpha-ship')) ?? []
  assert.ok(alphaSend.includes('ADE_FIRSTMATE_VALIDATOR_AGENT=codex'))
  assert.ok(alphaSend.includes('ADE_FIRSTMATE_VALIDATOR_MODEL=gpt-5.6-sol'))
  assert.match(alphaSend.at(-1) ?? '', /^\$no-mistakes/)
  assert.equal(taskConfigs.size, 1)

  const restartedRuntime = createFirstMateRuntime(runtimeOptions)
  await restartedRuntime.status()
  await restartedRuntime.configureValidator('codex', 'global-before-beta')
  const restartedCoordinator = createFirstMateLifecycleCoordinator({
    runtime: restartedRuntime,
    wakeCaptain: async (message) => { wakes.push(message); return { ok: true } }
  })
  await restartedCoordinator.poll()
  assert.equal(sends.length, 1, 'restart must supervise the acknowledged dispatch without repeating it')

  rawTasks[0]!.status += 'done: PR https://github.com/acme/alpha/pull/10 checks green\n'
  await restartedCoordinator.poll()
  assert.equal(sends.length, 2, 'the second pinned provider starts only after the shared gate is free')
  const betaSend = sends.find((args) => args.includes('beta-ship')) ?? []
  assert.ok(betaSend.includes('ADE_FIRSTMATE_VALIDATOR_AGENT=claude'))
  assert.ok(betaSend.includes('ADE_FIRSTMATE_VALIDATOR_MODEL=claude-sonnet-4-5'))
  assert.match(betaSend.at(-1) ?? '', /^\/no-mistakes/)
  assert.equal(taskConfigs.size, 2)

  rawTasks[1]!.status += 'done: PR https://github.com/acme/beta/pull/20 checks green\n'
  await restartedCoordinator.poll()
  const completed = await restartedRuntime.lifecycle()

  assert.deepEqual(completed.tasks.map((task) => [
    task.context?.project.adeProjectId,
    task.context?.validator.agent,
    task.prUrl
  ]), [
    ['alpha', 'codex', 'https://github.com/acme/alpha/pull/10'],
    ['beta', 'claude', 'https://github.com/acme/beta/pull/20']
  ])
  const completionWake = wakes.find((message) => /alpha-ship=pr-ready/.test(message)) ?? ''
  assert.match(completionWake, /project=alpha[\s\S]*validator=codex\/gpt-5\.6-sol/)
  assert.match(completionWake, /project=beta[\s\S]*validator=claude\/claude-sonnet-4-5/)
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

test('runs a Claude-only workflow when the WSL runtime has no native Codex CLI', async () => {
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

  assert.equal((await runtime.status()).state, 'ready')
  assert.equal(runtime.launch(), null)
  assert.ok(runtime.launch('claude'), 'a Claude workflow must not require Codex to be installed')
})

test('runs a Codex-only workflow when the WSL runtime has no native Claude CLI', async () => {
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

  assert.equal((await runtime.status()).state, 'ready')
  assert.equal(runtime.launch('claude'), null)
  assert.ok(runtime.launch('codex'), 'a Codex workflow must not require Claude to be installed')
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
  assert.equal(
    existsSync(join(rootPath, 'home', 'no-mistakes', 'config.yaml')),
    false,
    'captain launch selection is separate from the task-scoped validation pipeline'
  )
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
    inspectCheckout: async () => ({
      status: 'git-checkout' as const,
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
    inspectCheckout: async () => ({ status: 'git-checkout' }),
    wsl: {
      run: async (args) => {
        calls.push(args)
        if (args[3] === '/bin/sh') return { stdout: readyWslInspection(), stderr: '' }
        const script = args[5] ?? ''
        if (script.includes('statSync(project)')) {
          return { stdout: JSON.stringify({ accessible: true }), stderr: '' }
        }
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

  const homeCalls = calls.filter((args) => (
    args[3] === '/usr/bin/node' && (args[5] ?? '').includes('ade-external-projects.json')
  ))
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

test('blocks a WSL-inaccessible checkout and recovers after the same mount returns', async () => {
  const rootPath = mkdtempSync(join(tmpdir(), 'ade-firstmate-wsl-project-access-'))
  const files: { store?: string; registry?: string } = {}
  let mounted = false
  const runtime = createFirstMateRuntime({
    rootPath,
    platform: 'win32',
    resolveGit: () => 'git.exe',
    inspectCheckout: async () => ({
      status: 'git-checkout',
      origin: 'https://github.com/acme/alpha-api.git'
    }),
    wsl: {
      run: async (args) => {
        if (args[3] === '/bin/sh') return { stdout: readyWslInspection(), stderr: '' }
        const script = args[5] ?? ''
        if (script.includes('statSync(project)')) {
          return {
            stdout: JSON.stringify(mounted
              ? { accessible: true }
              : { accessible: false, message: 'ENOENT: /mnt/d is not mounted' }),
            stderr: ''
          }
        }
        if (script.includes('renameSync')) {
          files.store = Buffer.from(args.at(-1) ?? '', 'base64url').toString('utf8')
          return { stdout: '', stderr: '' }
        }
        return { stdout: JSON.stringify(files), stderr: '' }
      }
    }
  })
  const selection = { projectId: 'alpha', name: 'Api', path: 'D:\\Development\\alpha\\api' }

  const unavailable = await runtime.registerProject(selection)

  assert.equal(unavailable.ok, false)
  assert.equal(unavailable.failure?.kind, 'wsl')
  assert.match(unavailable.message ?? '', /Restore the D: drive mount in Ubuntu WSL/)
  assert.equal(files.store, undefined, 'an inaccessible WSL target must not be registered')

  mounted = true
  const recovered = await runtime.registerProject(selection)

  assert.equal(recovered.ok, true)
  assert.equal(recovered.project?.adeProjectId, 'alpha')
})
