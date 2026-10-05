import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  COMMAND_GUARD_MATCHER,
  codexCommandGuardEnvironment,
  codexCommandGuardOverrides,
  codexHookTrustHash,
  commandGuardHookCommand,
  resolveBundledCodex
} from '../src/main/command-guard'

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
