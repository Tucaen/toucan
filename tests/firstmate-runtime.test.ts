import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
import { firstMateRequest } from '../src/renderer/src/firstmate-project-catalog'
import type { FirstMateLifecycleJournal, FirstMateLifecycleRecord } from '../src/main/firstmate-lifecycle'
import type { FirstMateProjectRegistration } from '../src/shared/firstmate'
import type { WorkspaceProject } from '../src/shared/terminal'
import { firstMateCatalogFromRequest } from './firstmate-catalog-test-helpers'

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

interface WslProjectAccess {
  accessible: boolean
  message?: string
}

interface WslExternalProjectHost {
  /** The data files of ADE's private FirstMate home, as the WSL node scripts see them. */
  files: { store?: string; registry?: string }
  calls: string[][]
  run(args: string[]): Promise<{ stdout: string; stderr: string }>
}

/**
 * A ready WSL host whose private FirstMate home is backed by these two files. Only ADE's own
 * registration store is writable, so a test that registers a project also proves that nothing
 * firstmate-private was rewritten on the way through.
 */
function wslExternalProjectHost(options: {
  registry?: string
  access?(): WslProjectAccess
} = {}): WslExternalProjectHost {
  const host: WslExternalProjectHost = {
    files: { ...(options.registry === undefined ? {} : { registry: options.registry }) },
    calls: [],
    async run(args: string[]) {
      host.calls.push(args)
      if (args[3] === '/bin/sh') return { stdout: readyWslInspection(), stderr: '' }
      const script = args[5] ?? ''
      if (script.includes('statSync(project)')) {
        return { stdout: JSON.stringify(options.access?.() ?? { accessible: true }), stderr: '' }
      }
      if (script.includes('renameSync')) {
        host.files.store = Buffer.from(args.at(-1) ?? '', 'base64url').toString('utf8')
        return { stdout: '', stderr: '' }
      }
      return { stdout: JSON.stringify(host.files), stderr: '' }
    }
  }
  return host
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
  const runtime = createFirstMateRuntime({
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
    backend: 'tmux',
    supervision: 'app-native',
    distribution: 'Ubuntu',
    message: 'ADE will provision FirstMate, native Claude and Codex agents, tmux, and the managed review toolchain in Ubuntu.'
  })
  assert.equal(runtime.launch(), null)
})

test('builds the Linux ACP launch only after the complete WSL runtime is ready', async () => {
  const calls: string[][] = []
  const runtime = createFirstMateRuntime({
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
  assert.equal(status.homePath, '/home/tucaen/.local/share/ade/firstmate/home')
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
  const runtime = createFirstMateRuntime({
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
  const runtime = createFirstMateRuntime({
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
  const runtime = createFirstMateRuntime({
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
    const value = firstMateCatalogFromRequest(prompt).projects[0]?.taskContextMetadata
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
  assert.match(alphaPrompt, /resolve the concrete task delivery mode[\s\S]*?pass the resolved `--mode`/)
  assert.match(betaPrompt, /resolve the concrete task delivery mode[\s\S]*?pass the resolved `--mode`/)

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
  const calls: string[][] = []
  let trusted = false
  const runtime = createFirstMateRuntime({
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
  let terminal: { title: string; executable: string; args: string[] } | undefined
  const runtime = createFirstMateRuntime({
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

test('resolves the sign-in host from its own inspection rather than a failed poll', async () => {
  let inspections = 0
  let terminal: { title: string; executable: string; args: string[] } | undefined
  const runtime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: {
      run: async (args) => {
        if (args[3] !== '/bin/sh') return { stdout: '', stderr: '' }
        inspections += 1
        // The dock polls status continuously; one transient failure must not disable the sign-in.
        if (inspections === 1) throw new Error('Ubuntu WSL is unavailable')
        return { stdout: readyWslInspection(), stderr: '' }
      },
      openTerminal: async (title, executable, args) => { terminal = { title, executable, args } }
    }
  })

  assert.equal((await runtime.status()).state, 'error', 'a failed poll must invalidate the cached host')
  const result = await runtime.authenticateGitHub()

  assert.equal(result.ok, true, 'the sign-in must use the host its own inspection resolved')
  assert.ok(
    terminal?.args.includes('PATH=/home/tucaen/.local/bin:/usr/local/bin:/usr/bin:/bin'),
    'the sign-in PATH must come from the WSL user home that same inspection reported'
  )
})

test('provisions Ubuntu packages and the managed FirstMate toolchain', async () => {
  const calls: string[][] = []
  const runtime = createFirstMateRuntime({
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
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: { run: async () => ({ stdout: inspectionWithoutClaude, stderr: '' }) }
  })

  assert.equal((await runtime.status()).state, 'ready')
  assert.equal(runtime.launch('claude'), null)
  assert.ok(runtime.launch('codex'), 'a Codex workflow must not require Claude to be installed')
})

test('reports FirstMate as unsupported off Windows and offers no install or launch path', async () => {
  const runtime = createFirstMateRuntime({
    platform: 'linux',
    resolveGit: () => '/usr/bin/git'
  })

  const status = await runtime.status()
  const installed = await runtime.install()

  assert.equal(status.state, 'unsupported')
  assert.match(status.message ?? '', /FirstMate is unavailable on this platform/)
  assert.equal(status.distroPath, undefined, 'an unsupported platform has no managed distro to name')
  assert.equal(status.homePath, undefined, 'an unsupported platform has no private operational home')
  assert.equal(installed.ok, false, 'an unsupported platform must offer no install path')
  assert.equal(installed.status.state, 'unsupported')
  assert.equal(runtime.launch(), null, 'an unsupported platform must offer no launch path')
  assert.equal(runtime.launch('claude'), null)
  assert.deepEqual(await runtime.lifecycle(), {
    supervision: 'app-native',
    message: status.message,
    tasks: []
  })
  assert.equal(await runtime.recordedProject('alpha'), null)
  for (const refusal of await Promise.all([
    runtime.authenticateGitHub(),
    runtime.trustCodexProject(),
    runtime.configureValidator('codex', 'gpt-5.6-sol'),
    runtime.continueValidation('alpha-ship', 'alpha-ship.hash.1'),
    runtime.registerProject({ projectId: 'alpha', name: 'Api', path: '/home/tucaen/alpha/api' }),
    runtime.authorizeProjectInitialization('alpha'),
    runtime.retireProject('alpha')
  ])) {
    assert.equal(refusal.ok, false)
    assert.equal(refusal.message, status.message)
  }
  await assert.rejects(
    runtime.recordLifecycle('alpha-ship', {
      stage: 'implemented',
      detail: 'unreachable',
      statusHash: 'hash',
      updatedAt: '2026-08-15T00:00:00.000Z'
    }),
    /FirstMate is unavailable on this platform/,
    'an unsupported platform must never accumulate durable lifecycle state'
  )
})

test('registers an ADE checkout as a durable external project inside the private home', async () => {
  const fleetRegistry = '# Projects\n\n- firstmate [no-mistakes] - the managed distro (added 2026-01-01)\n'
  const host = wslExternalProjectHost({ registry: fleetRegistry })
  const options = {
    platform: 'win32' as const,
    resolveGit: (): string => 'git.exe',
    inspectCheckout: async () => ({
      status: 'git-checkout' as const,
      origin: 'git@github.com:acme/alpha-api.git'
    }),
    wsl: { run: host.run }
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
  assert.deepEqual(afterRestart, registered.project, 'a restart must read back the same registration')

  const store = JSON.parse(host.files.store ?? '{}')
  assert.equal(store.version, 1)
  assert.equal(store.projects.alpha.windowsPath, 'D:\\Development\\alpha\\api')
  assert.equal(
    host.files.registry,
    fleetRegistry,
    'the firstmate-private fleet registry belongs to the captain and is only read'
  )
  assert.equal(
    host.calls.some((args) => args.some((argument) => /\bgit clone\b|ln -s|\/home\/projects\//.test(argument))),
    false,
    'an external project must never be cloned or linked into the managed projects directory'
  )
})

test('keeps the external-project mapping inside the WSL FirstMate home', async () => {
  const { files, calls, run } = wslExternalProjectHost()
  const runtime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    inspectCheckout: async () => ({ status: 'git-checkout' }),
    wsl: { run }
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
  let mounted = false
  const { files, run } = wslExternalProjectHost({
    access: () => mounted
      ? { accessible: true }
      : { accessible: false, message: 'ENOENT: /mnt/d is not mounted' }
  })
  const runtime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    inspectCheckout: async () => ({
      status: 'git-checkout',
      origin: 'https://github.com/acme/alpha-api.git'
    }),
    wsl: { run }
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
