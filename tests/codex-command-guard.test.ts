import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { WebContents } from 'electron'
import type { AgentCreateRequest } from '../src/shared/agent'
import type { AgentProcessLaunch } from '../src/main/agent-process'
import { createAcpSessionManager } from '../src/main/acp-session-manager'
import { stubAdapterChild } from './helpers/scripted-adapter'
import {
  COMMAND_GUARD_MATCHER,
  codexCommandGuardEnvironment,
  codexCommandGuardOverrides,
  codexHookTrustHash,
  commandGuardFiles,
  commandGuardHookCommand,
  resolveBundledCodex,
  type CommandGuardFiles
} from '../src/main/command-guard'

const launcherName = process.platform === 'win32' ? 'codex-launcher.cmd' : 'codex-launcher.sh'

const files = { script: join('/toucan', '.agents', 'command-guard', 'guard.mjs'), patterns: '/toucan/patterns.txt' }

// Both fixtures are the `currentHash` Codex 0.154.0 itself reported through `hooks/list` for these
// exact hooks (ticket 02 verification). A Codex upgrade that changes the trust identity fails here
// rather than silently leaving every Codex session unguarded.
test('the trust hash is the one Codex computes for the same hook', () => {
  assert.equal(
    codexHookTrustHash('Bash', 'node C:/Users/tobii/AppData/Local/Temp/toucan-hook-probe/probe.mjs'),
    'sha256:7b851a3b542b810ee3550c44c81a940356d5f934bb1f9180bf1cfc22a029d597'
  )
  assert.equal(
    codexHookTrustHash('Bash|PowerShell', 'node C:/x/probe.mjs; exit $LASTEXITCODE'),
    'sha256:41ce14a48b680d1ad684addae209b2ee21189099f7cde02a4193578ad8ccd6d2'
  )
})

test('the overrides register the guard command and trust exactly that hook', () => {
  const command = commandGuardHookCommand('C:\\Toucan\\Toucan.exe', files, 'win32').command
  const [hook, state] = codexCommandGuardOverrides('C:\\Toucan\\Toucan.exe', files, 'win32')
  assert.equal(
    hook,
    `hooks.PreToolUse=[{matcher=${JSON.stringify(COMMAND_GUARD_MATCHER)},hooks=[{type="command",command=${JSON.stringify(command)},timeout=10}]}]`
  )
  assert.equal(
    state,
    `hooks.state={${JSON.stringify('C:\\<session-flags>\\config.toml:pre_tool_use:0:0')}={trusted_hash=${JSON.stringify(
      codexHookTrustHash(COMMAND_GUARD_MATCHER, command)
    )}}}`
  )
  // POSIX keys the session-flags layer from the filesystem root instead of a drive.
  const [, posixState] = codexCommandGuardOverrides('/opt/toucan', files, 'linux')
  assert.ok(posixState?.startsWith('hooks.state={"/<session-flags>/config.toml:pre_tool_use:0:0"='))
})

test('a DEL in a path is escaped, since TOML forbids it raw where JSON allows it', () => {
  const [hook] = codexCommandGuardOverrides('/opt/to\u007fucan', files, 'linux')
  assert.ok(hook?.includes('to\\u007fucan'))
  assert.ok(!hook?.includes('\u007f'))
})

test('the launch environment points Codex at the launcher beside the guard script', () => {
  const windows = codexCommandGuardEnvironment({
    runtime: 'C:\\Toucan\\Toucan.exe',
    codex: { executable: 'C:\\codex.exe', packageRoot: 'C:\\codex' },
    files,
    platform: 'win32'
  })
  assert.deepEqual(Object.keys(windows).sort(), [
    'CODEX_MANAGED_BY_NPM',
    'CODEX_MANAGED_PACKAGE_ROOT',
    'CODEX_PATH',
    'TOUCAN_CODEX_CONFIG_OVERRIDES',
    'TOUCAN_CODEX_EXECUTABLE',
    'TOUCAN_CODEX_RUNTIME'
  ])
  assert.equal(windows.CODEX_PATH, join('/toucan', '.agents', 'command-guard', 'codex-launcher.cmd'))
  assert.equal(windows.TOUCAN_CODEX_RUNTIME, 'C:\\Toucan\\Toucan.exe')
  assert.equal(windows.TOUCAN_CODEX_EXECUTABLE, 'C:\\codex.exe')
  // What codex.js tells the binary it starts, so Codex behaves as it does unguarded.
  assert.equal(windows.CODEX_MANAGED_PACKAGE_ROOT, 'C:\\codex')
  assert.equal(windows.CODEX_MANAGED_BY_NPM, '1')
  assert.deepEqual(
    JSON.parse(windows.TOUCAN_CODEX_CONFIG_OVERRIDES ?? ''),
    codexCommandGuardOverrides('C:\\Toucan\\Toucan.exe', files, 'win32')
  )
  const posix = codexCommandGuardEnvironment({
    runtime: '/opt/toucan',
    codex: { executable: '/codex', packageRoot: '/pkg' },
    files,
    platform: 'darwin'
  })
  assert.equal(posix.CODEX_PATH, join('/toucan', '.agents', 'command-guard', 'codex-launcher.sh'))
})

/** An app with codex-acp and Codex's npm packages laid out the way npm installs them. */
function appWithCodex(platform: string, arch: string, triple: string, binary: string): string {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-codex-resolve-'))
  const modules = join(appPath, 'node_modules')
  mkdirSync(join(modules, '@agentclientprotocol', 'codex-acp', 'dist'), { recursive: true })
  writeFileSync(join(modules, '@agentclientprotocol', 'codex-acp', 'dist', 'index.js'), '')
  mkdirSync(join(modules, '@openai', 'codex'), { recursive: true })
  writeFileSync(join(modules, '@openai', 'codex', 'package.json'), '{"name":"@openai/codex"}')
  const vendor = join(modules, '@openai', `codex-${platform}-${arch}`, 'vendor', triple, 'bin')
  mkdirSync(vendor, { recursive: true })
  writeFileSync(join(modules, '@openai', `codex-${platform}-${arch}`, 'package.json'), '{}')
  writeFileSync(join(vendor, binary), '')
  return appPath
}

test('the native Codex is resolved from the adapter, as its own codex.js would', () => {
  const appPath = appWithCodex('win32', 'x64', 'x86_64-pc-windows-msvc', 'codex.exe')
  const adapter = join(appPath, 'node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js')
  const codex = resolveBundledCodex(adapter, 'win32', 'x64')
  assert.equal(
    realpathSync(codex?.executable ?? ''),
    realpathSync(join(appPath, 'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'))
  )
  assert.equal(realpathSync(codex?.packageRoot ?? ''), realpathSync(join(appPath, 'node_modules/@openai/codex')))
  // No binary for this machine is no guarded launch, not a launch that cannot start.
  assert.equal(resolveBundledCodex(adapter, 'win32', 'arm64'), null)
  assert.equal(resolveBundledCodex(adapter, 'aix', 'x64'), null)
  const linux = appWithCodex('linux', 'arm64', 'aarch64-unknown-linux-musl', 'codex')
  const linuxAdapter = join(linux, 'node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js')
  assert.ok(resolveBundledCodex(linuxAdapter, 'linux', 'arm64')?.executable.endsWith(join('bin', 'codex')))
})

// The integration seam: what a Codex session's adapter is launched with. The guard rides the launch
// (`CODEX_PATH` and the launcher's overrides), next to the per-session `CODEX_CONFIG` that carries
// delegation and instructions, which it must leave exactly as it was.
interface CodexSessionConfig {
  agents?: Record<string, unknown>
  developer_instructions?: string
}

// The launch tests need a binary the resolver finds on whichever machine runs them.
const THIS_MACHINE_TRIPLE =
  {
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc',
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-musl',
    'linux-arm64': 'aarch64-unknown-linux-musl'
  }[`${process.platform}-${process.arch}`] ?? 'unsupported'
const THIS_MACHINE_BINARY = process.platform === 'win32' ? 'codex.exe' : 'codex'

const owner = { isDestroyed: () => false, send: () => {} } as unknown as WebContents
const routineDelegation = { workerModelId: 'gpt-5.6-luna', workerEffortId: 'low' }

async function launchCodex(
  requests: Array<Omit<AgentCreateRequest, 'provider' | 'cwd'>>,
  options: { commandGuard?: { launch(): Promise<CommandGuardFiles | null> } } = {},
  binary = THIS_MACHINE_BINARY
): Promise<{ appPath: string; launches: AgentProcessLaunch[] }> {
  const appPath = appWithCodex(process.platform, process.arch, THIS_MACHINE_TRIPLE, binary)
  const launches: AgentProcessLaunch[] = []
  const manager = createAcpSessionManager({
    appPath,
    environment: { PATH: '/usr/bin' },
    ...options,
    spawnAgent: (launch) => {
      launches.push(launch)
      return stubAdapterChild()
    }
  })
  for (const request of requests) void manager.create({ ...request, provider: 'codex', cwd: appPath }, owner)
  // Past the awaits an orchestrator grant and the guard preferences put before the spawn.
  await new Promise((resolve) => setTimeout(resolve, 0))
  manager.killAll()
  return { appPath, launches }
}

const resolvesOnThisMachine = resolveBundledCodex(
  join(process.cwd(), 'node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js')
)

test('chats and orchestrators on Codex launch guarded, beside their own CODEX_CONFIG', async () => {
  const { appPath, launches } = await launchCodex([
    { id: 'chat', routineDelegation },
    { id: 'orchestrator', role: 'orchestrator', routineDelegation }
  ])
  assert.equal(launches.length, 2)
  const files = commandGuardFiles(appPath)
  for (const launch of launches) {
    const env = launch.options.env ?? {}
    assert.equal(env.CODEX_PATH, join(appPath, '.agents', 'command-guard', launcherName))
    assert.deepEqual(
      JSON.parse(env.TOUCAN_CODEX_CONFIG_OVERRIDES ?? ''),
      codexCommandGuardOverrides(process.execPath, files, process.platform)
    )
    // The overrides only ever set `hooks.*`, so nothing the session config carries is shadowed.
    for (const override of JSON.parse(env.TOUCAN_CODEX_CONFIG_OVERRIDES ?? '') as string[])
      assert.match(override, /^hooks\./)
    const config = JSON.parse(env.CODEX_CONFIG ?? '{}') as CodexSessionConfig
    assert.equal(config.agents?.default_subagent_model, 'gpt-5.6-luna')
    assert.match(config.developer_instructions ?? '', /Delegate routine work cheaply/)
    assert.equal(Object.hasOwn(config, 'hooks'), false)
  }
  const orchestrator = JSON.parse(launches[1]?.options.env?.CODEX_CONFIG ?? '{}') as CodexSessionConfig
  assert.match(orchestrator.developer_instructions ?? '', /orchestrate/i)
})

test('an opted-out node, a guard switched off and no Codex binary each launch plain codex-acp', async () => {
  const off = await launchCodex([{ id: 'open', commandGuard: false }, { id: 'guarded' }])
  assert.equal(off.launches[0]?.options.env?.CODEX_PATH, undefined)
  assert.ok(off.launches[1]?.options.env?.CODEX_PATH)
  const globallyOff = await launchCodex([{ id: 'chat' }], { commandGuard: { launch: async () => null } })
  assert.equal(globallyOff.launches[0]?.options.env?.CODEX_PATH, undefined)
  assert.equal(globallyOff.launches[0]?.options.env?.TOUCAN_CODEX_CONFIG_OVERRIDES, undefined)
  const missing = await launchCodex([{ id: 'chat' }], {}, 'not-codex')
  assert.equal(missing.launches.length, 1)
  assert.equal(missing.launches[0]?.options.env?.CODEX_PATH, undefined)
})

test("an edited pattern list reaches the Codex hook, read through the guard's launch seam", async () => {
  const custom = { script: join('/shipped', 'guard.mjs'), patterns: join('/user-data', 'mine.txt') }
  const { launches } = await launchCodex([{ id: 'chat' }], { commandGuard: { launch: async () => custom } })
  const env = launches[0]?.options.env ?? {}
  assert.equal(env.CODEX_PATH, join('/shipped', launcherName))
  assert.deepEqual(
    JSON.parse(env.TOUCAN_CODEX_CONFIG_OVERRIDES ?? ''),
    codexCommandGuardOverrides(process.execPath, custom, process.platform)
  )
})

test.runIf(resolvesOnThisMachine)('the Codex Toucan bundles resolves for this machine', () => {
  assert.ok(resolvesOnThisMachine?.executable)
})
