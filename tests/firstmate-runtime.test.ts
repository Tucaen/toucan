import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFirstMateRuntime, WSL_INSPECT_SCRIPT, WSL_WRAPPER_SCRIPT } from '../src/main/firstmate-runtime'
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
import { createGitCrew, gitIdentity } from './firstmate-git-crew'
import { parseFirstMateRuntimeRecord } from '../src/shared/firstmate-runtime-record'

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
    'gate=1',
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
  const { primary, worktree } = createGitCrew(label)
  assert.equal(
    gitIdentity(worktree).commonDir.toLocaleLowerCase(),
    gitIdentity(primary).commonDir.toLocaleLowerCase(),
    'crew worktree must derive from its pinned checkout'
  )
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

test('writes the global runtime record through the authoritative serializer on launch and reconfigure', async () => {
  const home = '/home/tucaen/.local/share/ade/firstmate/home'
  const calls: string[][] = []
  const runtime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: {
      run: async (args) => {
        calls.push(args)
        return { stdout: readyWslInspection(), stderr: '' }
      }
    }
  })

  await runtime.status()
  const launch = runtime.launch('codex', 'gpt-5.6-sol')

  // Writer A: the WSL launch script now receives an already-serialized record, not schema to rebuild.
  const launchArgs = launch?.agentProcess?.args ?? []
  const launchRecordArg = launchArgs[launchArgs.indexOf(home) + 1] ?? ''
  const launchRecordText = Buffer.from(launchRecordArg, 'base64url').toString('utf8')
  assert.deepEqual(parseFirstMateRuntimeRecord(launchRecordText), {
    version: 1,
    validator: { agent: 'codex', model: 'gpt-5.6-sol' }
  })
  const launchRecord = JSON.parse(launchRecordText)
  assert.deepEqual(launchRecord.host, { kind: 'ade-app', supervisor: 'app-native', terminalTarget: false })
  assert.equal(launchRecord.validator.nmHome, `${home}/no-mistakes`)
  assert.equal(launchRecord.validator.agentHome, `${home}/codex`)
  assert.ok(launchRecordText.endsWith('\n'), 'the serialized record keeps its trailing newline')

  // Writer B: the validator-configuration path serializes the same record shape.
  await runtime.configureValidator('claude', 'claude-opus-4-1')
  const configure = calls.find((args) => args.includes('ade-firstmate-validator'))
  assert.ok(configure, 'reconfiguring the validator must rewrite the global runtime record')
  const configureRecord = Buffer.from(configure.at(-1) ?? '', 'base64url').toString('utf8')
  assert.deepEqual(parseFirstMateRuntimeRecord(configureRecord), {
    version: 1,
    validator: { agent: 'claude', model: 'claude-opus-4-1' }
  })
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
  const result = await runtime.continueValidation('resize', 'resize.a1b2c3')

  assert.deepEqual(result, { outcome: 'acknowledged' })
  const sendIndex = calls.findIndex((args) => args.some((arg) => arg.endsWith('/bin/fm-send.sh')))
  const continuation = calls[sendIndex]
  assert.ok(continuation)
  assert.ok(continuation.includes('resize'))
  const ledgerIndex = calls.findIndex((args) => (
    args.some((arg) => arg.includes('.ade-validation-dispatches.json')) && args.includes('resize.a1b2c3')
  ))
  assert.ok(ledgerIndex >= 0, 'the dispatch identity is durably recorded so a repeat is recognisable')
  assert.ok(
    ledgerIndex < sendIndex,
    'the durable dispatch evidence must exist before the external send, not after it'
  )
  const continuationPrompt = continuation.find((arg) => arg.startsWith('$no-mistakes')) ?? ''
  assert.match(continuationPrompt, /state\/resize\.ade-runtime\.json/)
  assert.match(continuationPrompt, /ADE validation dispatch id: resize\.a1b2c3/)
  assert.match(
    continuationPrompt,
    /\.ade-validation-dispatches\.json/,
    'the continuation points the receiver at the durable ledger, not the prompt alone'
  )
  assert.match(continuationPrompt, /do not use[\s\S]*filtered doctor text, or guessed homes/i)
  assert.ok(continuation.includes('ADE_FIRSTMATE_RUNTIME_CONFIG=/home/tucaen/.local/share/ade/firstmate/home/state/resize.ade-runtime.json'))
  assert.ok(continuation.includes('ADE_FIRSTMATE_VALIDATOR_AGENT=codex'))
  assert.ok(continuation.includes('ADE_FIRSTMATE_VALIDATOR_MODEL=gpt-5.6-sol'))
  const nmHomeArg = continuation.find((arg) => arg.startsWith('NM_HOME='))
  assert.ok(nmHomeArg)
  assert.match(
    nmHomeArg,
    /^NM_HOME=\/home\/tucaen\/\.local\/share\/ade\/firstmate\/home\/state\/validators\/[a-f0-9]{20}\/no-mistakes$/,
    'each task must get its own no-mistakes home so concurrent validations cannot clobber each other'
  )
  const configWrite = calls.find((args) => args.includes('/home/tucaen/.local/share/ade/firstmate/home/state/resize.ade-runtime.json'))
  assert.ok(configWrite, 'the pinned runtime record must be durable before the continuation is sent')
  const taskConfig = JSON.parse(Buffer.from(configWrite.at(-1) ?? '', 'base64url').toString('utf8'))
  assert.match(
    taskConfig.validator.nmHome,
    /^\/home\/tucaen\/\.local\/share\/ade\/firstmate\/home\/state\/validators\/[a-f0-9]{20}\/no-mistakes$/,
    'the runtime record must carry the task-scoped no-mistakes home'
  )
  assert.deepEqual(taskConfig.validator, {
    agent: 'codex',
    model: 'gpt-5.6-sol',
    nmHome: taskConfig.validator.nmHome,
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
  const pipelineWrite = calls.find((args) => args.some((arg) => /\/state\/validators\/[a-f0-9]{20}\/no-mistakes\/config\.yaml$/.test(arg)))
  assert.ok(pipelineWrite, 'the pipeline config must be written to the task-scoped no-mistakes home')
  assert.match(
    Buffer.from(pipelineWrite.at(-1) ?? '', 'base64url').toString('utf8'),
    new RegExp(`agent: codex[\\s\\S]*${taskConfig.validator.agentPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  )
})

test('recognises an already-acknowledged dispatch identity from the durable ledger and never sends it again', async () => {
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
  const sends: string[][] = []
  const runtime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: {
      run: async (args) => {
        const scriptIndex = args.indexOf('-e')
        const script = scriptIndex >= 0 ? args[scriptIndex + 1] ?? '' : ''
        if (script.includes("endsWith('.meta')")) {
          return {
            stdout: JSON.stringify({
              tasks: [{
                id: 'resize',
                meta: [
                  'kind=ship', 'mode=no-mistakes', 'yolo=off',
                  'project=/mnt/d/Development/alpha/api',
                  'worktree=/home/tucaen/.treehouse/alpha/resize',
                  'harness=codex', 'model=gpt-5.6-sol',
                  firstMateTaskContextMetadata(context)
                ].join('\n'),
                status: 'done: committed implementation\n'
              }],
              dispatchLedger: JSON.stringify({
                version: 1,
                dispatches: {
                  'resize.ackhash': {
                    taskId: 'resize', status: 'acknowledged', recordedAt: '2026-08-15T00:00:00.000Z', deliveries: 1
                  }
                }
              })
            }),
            stderr: ''
          }
        }
        if (args.some((arg) => arg.endsWith('/bin/fm-send.sh'))) {
          sends.push(args)
          return { stdout: '', stderr: '' }
        }
        return { stdout: readyWslInspection(), stderr: '' }
      }
    }
  })

  await runtime.status()
  const result = await runtime.continueValidation('resize', 'resize.ackhash')

  assert.deepEqual(result, { outcome: 'acknowledged' })
  assert.deepEqual(sends, [], 'a provably delivered identity is recognised from disk, not sent a second time')
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
      originClassification: 'remote-backed',
      mode: 'no-mistakes',
      autonomy: false,
      autonomyCeiling: false,
      postureSource: 'default',
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

  assert.equal(sends.length, 2, 'both pinned providers must dispatch concurrently in a single poll')
  const alphaSend = sends.find((args) => args.includes('alpha-ship')) ?? []
  assert.ok(alphaSend.includes('ADE_FIRSTMATE_VALIDATOR_AGENT=codex'))
  assert.ok(alphaSend.includes('ADE_FIRSTMATE_VALIDATOR_MODEL=gpt-5.6-sol'))
  assert.match(alphaSend.at(-1) ?? '', /^\$no-mistakes/)
  const betaSend = sends.find((args) => args.includes('beta-ship')) ?? []
  assert.ok(betaSend.includes('ADE_FIRSTMATE_VALIDATOR_AGENT=claude'))
  assert.ok(betaSend.includes('ADE_FIRSTMATE_VALIDATOR_MODEL=claude-sonnet-4-5'))
  assert.match(betaSend.at(-1) ?? '', /^\/no-mistakes/)
  assert.equal(taskConfigs.size, 2, 'each task writes its own runtime config')

  const restartedRuntime = createFirstMateRuntime(runtimeOptions)
  await restartedRuntime.status()
  await restartedRuntime.configureValidator('codex', 'global-after-dispatch')
  const restartedCoordinator = createFirstMateLifecycleCoordinator({
    runtime: restartedRuntime,
    wakeCaptain: async (message) => { wakes.push(message); return { ok: true } }
  })
  await restartedCoordinator.poll()
  assert.equal(sends.length, 2, 'restart must supervise both acknowledged dispatches without repeating them')

  rawTasks[0]!.status += 'done: PR https://github.com/acme/alpha/pull/10 checks green\n'
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

test('validates two differently-pinned tasks concurrently with isolated no-mistakes scopes', async () => {
  const alphaCrew = externalGitCrew('alpha')
  const betaCrew = externalGitCrew('beta')
  const alphaContext: FirstMateTaskContext = {
    version: 1,
    project: {
      adeProjectId: 'alpha',
      registryName: 'api-alpha',
      windowsPath: alphaCrew.primary,
      wslPath: alphaCrew.primaryWsl,
      mode: 'no-mistakes',
      autonomy: false
    },
    validator: { agent: 'codex', model: 'gpt-5.6-sol' }
  }
  const betaContext: FirstMateTaskContext = {
    version: 1,
    project: {
      adeProjectId: 'beta',
      registryName: 'api-beta',
      windowsPath: betaCrew.primary,
      wslPath: betaCrew.primaryWsl,
      mode: 'no-mistakes',
      autonomy: false
    },
    validator: { agent: 'claude', model: 'claude-sonnet-4-5' }
  }
  const rawTasks = [{
    id: 'alpha-ship',
    meta: [
      'kind=ship', 'mode=no-mistakes', 'yolo=off',
      `project=${alphaContext.project.wslPath}`, `worktree=${alphaCrew.worktreeWsl}`,
      'harness=codex', 'model=gpt-5.6-sol',
      firstMateTaskContextMetadata(alphaContext)
    ].join('\n'),
    status: 'done: committed alpha implementation\n'
  }, {
    id: 'beta-ship',
    meta: [
      'kind=ship', 'mode=no-mistakes', 'yolo=off',
      `project=${betaContext.project.wslPath}`, `worktree=${betaCrew.worktreeWsl}`,
      'harness=claude', 'model=claude-sonnet-4-5',
      firstMateTaskContextMetadata(betaContext)
    ].join('\n'),
    status: 'done: committed beta implementation\n'
  }]
  let journal: FirstMateLifecycleJournal = { version: 1, tasks: {} }
  const sends: string[][] = []
  const pipelineWrites = new Map<string, string>()

  const run = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    if (args.includes('-lc')) return { stdout: readyWslInspection(), stderr: '' }
    const scriptIndex = args.indexOf('-e')
    const script = scriptIndex >= 0 ? args[scriptIndex + 1] ?? '' : ''
    if (script.includes("names.filter((name) => name.endsWith('.meta'))")) {
      return {
        stdout: JSON.stringify({
          runtimeConfig: JSON.stringify({ version: 1, validator: { agent: 'codex', model: 'global' } }),
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
    const nmConfigPath = args.find((arg) => /\/no-mistakes\/config\.yaml$/.test(arg))
    if (nmConfigPath) {
      pipelineWrites.set(nmConfigPath, Buffer.from(args.at(-1) ?? '', 'base64url').toString('utf8'))
      return { stdout: '', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
  const runtime = createFirstMateRuntime({ platform: 'win32', resolveGit: () => 'git.exe', wsl: { run } })
  await runtime.status()
  const coordinator = createFirstMateLifecycleCoordinator({
    runtime,
    wakeCaptain: async () => ({ ok: true })
  })

  await coordinator.poll()

  assert.equal(sends.length, 2, 'both tasks must dispatch in a single poll, not serialized behind a gate')
  const alphaSend = sends.find((args) => args.includes('alpha-ship'))
  const betaSend = sends.find((args) => args.includes('beta-ship'))
  assert.ok(alphaSend, 'alpha must dispatch')
  assert.ok(betaSend, 'beta must dispatch')
  assert.ok(alphaSend.includes('ADE_FIRSTMATE_VALIDATOR_AGENT=codex'))
  assert.ok(alphaSend.includes('ADE_FIRSTMATE_VALIDATOR_MODEL=gpt-5.6-sol'))
  assert.ok(betaSend.includes('ADE_FIRSTMATE_VALIDATOR_AGENT=claude'))
  assert.ok(betaSend.includes('ADE_FIRSTMATE_VALIDATOR_MODEL=claude-sonnet-4-5'))
  assert.match(alphaSend.at(-1) ?? '', /^\$no-mistakes/, 'codex tasks invoke $no-mistakes')
  assert.match(betaSend.at(-1) ?? '', /^\/no-mistakes/, 'claude tasks invoke /no-mistakes')

  const alphaNmHome = alphaSend.find((arg) => arg.startsWith('NM_HOME='))
  const betaNmHome = betaSend.find((arg) => arg.startsWith('NM_HOME='))
  assert.ok(alphaNmHome)
  assert.ok(betaNmHome)
  assert.notEqual(
    alphaNmHome,
    betaNmHome,
    'each task must get its own NM_HOME so concurrent validations cannot clobber each other'
  )
  assert.match(alphaNmHome, /\/state\/validators\/[a-f0-9]{20}\/no-mistakes$/)
  assert.match(betaNmHome, /\/state\/validators\/[a-f0-9]{20}\/no-mistakes$/)

  assert.equal(pipelineWrites.size, 2, 'each task must write its own pipeline config')
  const pipelinePaths = [...pipelineWrites.keys()]
  assert.notEqual(
    pipelinePaths[0],
    pipelinePaths[1],
    'pipeline configs must be written to distinct paths'
  )
  for (const [path, content] of pipelineWrites) {
    assert.match(path, /\/state\/validators\/[a-f0-9]{20}\/no-mistakes\/config\.yaml$/)
    assert.match(content, /agent_path_override:/)
  }
  const alphaConfig = [...pipelineWrites.values()].find((config) => config.includes('agent: codex'))
  const betaConfig = [...pipelineWrites.values()].find((config) => config.includes('agent: claude'))
  assert.ok(alphaConfig, 'alpha pipeline config must select codex')
  assert.ok(betaConfig, 'beta pipeline config must select claude')
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

/** A minimal .meta blob for one task, optionally carrying a recorded live worker window. */
function windowedTaskMeta(window?: string): string {
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
  return [
    'kind=ship', 'mode=no-mistakes', 'yolo=off',
    'project=/mnt/d/Development/alpha/api',
    'worktree=/home/tucaen/.treehouse/alpha/resize',
    ...(window ? [`window=${window}`] : []),
    'harness=codex', 'model=gpt-5.6-sol',
    firstMateTaskContextMetadata(context)
  ].join('\n')
}

/**
 * A WSL host whose only jobs are answering ADE's inspection, its durable lifecycle read (with one
 * task carrying the given meta), and a probe of `run` calls beyond those two - a stand-in for
 * whatever `openWorkerTerminal` does after resolving the task's window, such as a tmux liveness
 * check.
 */
function windowedTaskHost(meta: string, probe: (args: string[]) => { stdout: string; stderr: string } | undefined) {
  return async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    const scriptIndex = args.indexOf('-e')
    const script = scriptIndex >= 0 ? args[scriptIndex + 1] ?? '' : ''
    if (script.includes("endsWith('.meta')")) {
      return {
        stdout: JSON.stringify({
          tasks: [{ id: 'resize', meta, status: 'done: committed implementation\n' }]
        }),
        stderr: ''
      }
    }
    const probed = probe(args)
    if (probed) return probed
    return { stdout: readyWslInspection(), stderr: '' }
  }
}

test('opens a terminal attached to a task\'s live worker tmux window', async () => {
  let terminal: { title: string; executable: string; args: string[] } | undefined
  const runtime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: {
      executable: 'wsl.exe',
      run: windowedTaskHost(windowedTaskMeta('firstmate:fm-resize'), (args) => (
        args.includes('has-session') ? { stdout: '', stderr: '' } : undefined
      )),
      openTerminal: async (title, executable, args) => { terminal = { title, executable, args } }
    }
  })
  await runtime.status()

  const result = await runtime.openWorkerTerminal('resize')

  assert.equal(result.ok, true)
  assert.equal(terminal?.executable, 'wsl.exe')
  assert.ok(terminal?.args.includes('attach-session'))
  assert.ok(terminal?.args.includes('firstmate:fm-resize'))
})

test('refuses to open a terminal for a task with no recorded live worker window', async () => {
  let terminalOpened = false
  const runtime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: {
      run: windowedTaskHost(windowedTaskMeta(undefined), () => undefined),
      openTerminal: async () => { terminalOpened = true }
    }
  })
  await runtime.status()

  const result = await runtime.openWorkerTerminal('resize')

  assert.equal(result.ok, false)
  assert.match(result.message ?? '', /no recorded live worker window/)
  assert.equal(terminalOpened, false, 'a missing window binding must never open a broken terminal')
})

test('refuses to open a terminal when the task id is unknown to the durable lifecycle', async () => {
  let terminalOpened = false
  const runtime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: {
      run: windowedTaskHost(windowedTaskMeta('firstmate:fm-resize'), () => undefined),
      openTerminal: async () => { terminalOpened = true }
    }
  })
  await runtime.status()

  const result = await runtime.openWorkerTerminal('no-such-task')

  assert.equal(result.ok, false)
  assert.match(result.message ?? '', /no recorded live worker window/)
  assert.equal(terminalOpened, false)
})

test('refuses to open a terminal when the worker tmux session is no longer running', async () => {
  let terminalOpened = false
  const runtime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: {
      run: windowedTaskHost(windowedTaskMeta('firstmate:fm-resize'), (args) => {
        if (args.includes('has-session')) throw new Error("can't find session: firstmate")
        return undefined
      }),
      openTerminal: async () => { terminalOpened = true }
    }
  })
  await runtime.status()

  const result = await runtime.openWorkerTerminal('resize')

  assert.equal(result.ok, false)
  assert.match(result.message ?? '', /not running/)
  assert.match(result.message ?? '', /can't find session/)
  assert.equal(terminalOpened, false, 'a dead session must never open a broken terminal')
})

test('refuses to open a worker terminal while FirstMate itself is not ready', async () => {
  let terminalOpened = false
  const runtime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: {
      run: async () => { throw new Error('Ubuntu WSL is unavailable') },
      openTerminal: async () => { terminalOpened = true }
    }
  })

  const result = await runtime.openWorkerTerminal('resize')

  assert.equal(result.ok, false)
  assert.equal(terminalOpened, false)
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
    runtime.registerProject({ projectId: 'alpha', name: 'Api', path: '/home/tucaen/alpha/api' }),
    runtime.authorizeProjectInitialization('alpha'),
    runtime.retireProject('alpha')
  ])) {
    assert.equal(refusal.ok, false)
    assert.equal(refusal.message, status.message)
  }
  const delivery = await runtime.continueValidation('alpha-ship', 'alpha-ship.hash')
  assert.deepEqual(
    delivery,
    { outcome: 'rejected-before-send', message: status.message },
    'an unsupported platform never begins an external send'
  )
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

// --- Managed spawn gate repair ---

function preGateInspection(): string {
  return readyWslInspection().split('\n').filter((line) => !line.startsWith('gate=')).join('\n')
}

test('detects an existing pre-gate home as needing repair, not ready', async () => {
  const runtime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: { run: async () => ({ stdout: preGateInspection(), stderr: '' }) }
  })

  const status = await runtime.status()

  assert.equal(status.state, 'repair', 'an existing home missing the spawn gate must need repair, not report ready')
  assert.match(status.message ?? '', /repair/i, 'the message must mention repair')
  assert.equal(runtime.launch(), null, 'a repairable runtime must not offer a launch')
})

test('repair creates an executable spawn gate and preserves existing state', async () => {
  const calls: string[][] = []
  let repaired = false
  const runtime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: {
      run: async (args) => {
        calls.push(args)
        if (args.includes('/bin/bash') && args.includes('-lc')) {
          repaired = true
          return { stdout: '', stderr: '' }
        }
        const inspection = repaired ? readyWslInspection() : readyWslInspection()
          .split('\n')
          .filter((line) => line !== 'gate=1')
          .join('\n')
        return { stdout: inspection, stderr: '' }
      }
    }
  })

  assert.equal((await runtime.status()).state, 'repair')
  const result = await runtime.repair()

  assert.equal(result.ok, true)
  assert.equal(result.status.state, 'ready')
  const prepare = calls.find((args) => args.includes('/bin/bash') && args.includes('-lc'))
  assert.ok(prepare, 'repair must run the managed provisioning script')
  assert.match(prepare.at(-1) ?? '', /ade-spawn-gate/, 'the provisioning script must create the spawn gate')
  assert.equal(
    calls.some((args) => args.includes('apt-get')),
    false,
    'repair must not re-run system package installation'
  )
})

test('restart after repair remains ready and idempotent', async () => {
  const run = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    if (args[3] === '/bin/sh') return { stdout: readyWslInspection(), stderr: '' }
    return { stdout: '', stderr: '' }
  }
  const runtime1 = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: { run }
  })
  const runtime2 = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    wsl: { run }
  })

  assert.equal((await runtime1.status()).state, 'ready')
  assert.equal((await runtime2.status()).state, 'ready', 'a second runtime against the same ready host must also be ready')
})

test('project authorization alone cannot falsely imply dispatch readiness when the gate is missing', async () => {
  const inspection = preGateInspection()
  const host = wslExternalProjectHost()
  const originalRun = host.run
  host.run = async (args) => {
    if (args[3] === '/bin/sh') return { stdout: inspection, stderr: '' }
    return originalRun(args)
  }
  const runtime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    inspectCheckout: async () => ({
      status: 'git-checkout' as const,
      origin: 'https://github.com/acme/alpha.git'
    }),
    wsl: { run: host.run }
  })

  const status = await runtime.status()
  assert.equal(status.state, 'repair', 'the runtime must not be ready without a spawn gate')
  assert.equal(runtime.launch(), null, 'no launch path should be available in repair state')
})

test('a valid catalog carrier passes after repair; stale project or validator metadata still fails closed', async () => {
  let repaired = false
  const calls: string[][] = []
  const host = wslExternalProjectHost()
  const originalHostRun = host.run
  const runtime = createFirstMateRuntime({
    platform: 'win32',
    resolveGit: () => 'git.exe',
    inspectCheckout: async () => ({
      status: 'git-checkout' as const,
      origin: 'https://github.com/acme/alpha.git'
    }),
    wsl: {
      run: async (args) => {
        calls.push(args)
        if (args.includes('/bin/bash') && args.includes('-lc')) {
          repaired = true
          return { stdout: '', stderr: '' }
        }
        if (args[3] === '/bin/sh') {
          const inspection = repaired ? readyWslInspection() : readyWslInspection()
            .split('\n')
            .filter((line) => line !== 'gate=1')
            .join('\n')
          return { stdout: inspection, stderr: '' }
        }
        return originalHostRun(args)
      }
    }
  })

  assert.equal((await runtime.status()).state, 'repair')
  await runtime.repair()
  assert.equal((await runtime.status()).state, 'ready')

  const registered = await runtime.registerProject({
    projectId: 'alpha',
    name: 'Api',
    path: 'D:\\Development\\alpha\\api'
  })
  assert.equal(registered.ok, true)
  assert.ok(registered.project)

  const { firstMateSpawnContextProblem } = await import('../src/main/firstmate-spawn-gate')
  const { firstMateProjectCatalog, firstMateRequest } = await import('../src/renderer/src/firstmate-project-catalog')
  const { firstMateTaskContextFromMetadata } = await import('../src/shared/firstmate-task-context')
  const { firstMateCanonicalWindowsPath, firstMateWslPath } = await import('../src/main/firstmate-paths')

  const project = registered.project
  const gateProject = {
    adeProjectId: project.adeProjectId,
    registryName: project.registryName,
    windowsPath: project.windowsPath,
    wslPath: project.wslPath,
    mode: project.mode,
    autonomy: project.autonomy
  }
  const validator = { agent: 'codex' as const, model: 'gpt-5.6-sol' }

  const catalog = firstMateProjectCatalog(
    [{ selection: { id: 'alpha', name: 'Api', path: 'D:\\Development\\alpha\\api', color: '#71a9ff' }, registration: registered }],
    'alpha',
    { provider: 'codex', model: 'gpt-5.6-sol' }
  )
  const entry = catalog.projects.find((p) => p.adeProjectId === 'alpha')
  assert.ok(entry)
  const context = firstMateTaskContextFromMetadata(entry.taskContextMetadata)
  assert.ok(context)
  assert.equal(
    firstMateSpawnContextProblem(context, gateProject, validator),
    undefined,
    'a matching context must pass after repair'
  )

  const staleProject = { ...gateProject, mode: 'direct-PR' as const }
  assert.ok(
    firstMateSpawnContextProblem(context, staleProject, validator),
    'stale project metadata must still fail closed after repair'
  )

  const staleValidator = { agent: 'claude' as const, model: 'claude-sonnet-4-5' }
  assert.ok(
    firstMateSpawnContextProblem(context, gateProject, staleValidator),
    'stale validator metadata must still fail closed after repair'
  )
})

// --- Stale wrapper detection (home/bin/claude, home/bin/codex) ---

function runManagedShell(script: string, home: string): string {
  return execFileSync('/bin/sh', ['-c', script], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
}

function managedWrapperFixture(): { home: string; base: string } {
  const home = mkdtempSync(join(tmpdir(), 'firstmate-wrapper-'))
  const base = join(home, '.local/share/ade/firstmate')
  mkdirSync(join(home, '.local/bin'), { recursive: true })
  mkdirSync(join(base, 'home/bin'), { recursive: true })
  for (const tool of ['claude', 'codex']) {
    writeFileSync(join(home, '.local/bin', tool), '#!/bin/sh\nexit 0\n')
    chmodSync(join(home, '.local/bin', tool), 0o755)
  }
  return { home, base }
}

test('the managed wrapper script forwards real arguments to the underlying agent binary', () => {
  const { home, base } = managedWrapperFixture()
  try {
    writeFileSync(
      join(home, '.local/bin/claude'),
      '#!/bin/sh\nprintf \'argc=%d\\n\' "$#"\nfor a in "$@"; do printf \'arg=[%s]\\n\' "$a"; done\n'
    )
    chmodSync(join(home, '.local/bin/claude'), 0o755)
    runManagedShell(`base="${base}"\n${WSL_WRAPPER_SCRIPT}chmod +x "$base/home/bin/claude" "$base/home/bin/codex"`, home)

    const output = execFileSync(join(base, 'home/bin/claude'), ['review', '--agent', 'foo'], { encoding: 'utf8' })

    assert.equal(
      output,
      'argc=3\narg=[review]\narg=[--agent]\narg=[foo]\n',
      'a freshly generated wrapper must forward its real arguments to the underlying binary'
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the inspect script reports a wrapper fact only when the wrapper actually forwards arguments', () => {
  const { home, base } = managedWrapperFixture()
  try {
    runManagedShell(`base="${base}"\n${WSL_WRAPPER_SCRIPT}chmod +x "$base/home/bin/claude" "$base/home/bin/codex"`, home)
    // Overwrite codex with the historically-broken wrapper: present, executable, but hardcoding an
    // empty argument instead of forwarding "$@".
    writeFileSync(
      join(base, 'home/bin/codex'),
      `#!/bin/sh\nexport CODEX_HOME="${base}/home/codex"\nexec "${home}/.local/bin/codex" ""\n`
    )
    chmodSync(join(base, 'home/bin/codex'), 0o755)

    const output = runManagedShell(WSL_INSPECT_SCRIPT, home)

    assert.match(
      output,
      /^wrapper\.claude=1$/m,
      'a correctly generated wrapper must still be reported healthy'
    )
    assert.doesNotMatch(
      output,
      /^wrapper\.codex=1$/m,
      'a present, executable, but stale/broken wrapper must not be misreported as healthy'
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
