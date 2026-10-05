import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  COMMAND_GUARD_MATCHER,
  codexCommandGuardEnvironment,
  codexCommandGuardOverrides,
  codexHookTrustHash,
  commandGuardHookCommand
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
    codex: 'C:\\codex.exe',
    files,
    platform: 'win32'
  })
  assert.deepEqual(Object.keys(windows).sort(), [
    'CODEX_PATH',
    'TOUCAN_CODEX_CONFIG_OVERRIDES',
    'TOUCAN_CODEX_EXECUTABLE',
    'TOUCAN_CODEX_RUNTIME'
  ])
  assert.equal(windows.CODEX_PATH, join('/toucan', '.agents', 'command-guard', 'codex-launcher.cmd'))
  assert.equal(windows.TOUCAN_CODEX_RUNTIME, 'C:\\Toucan\\Toucan.exe')
  assert.equal(windows.TOUCAN_CODEX_EXECUTABLE, 'C:\\codex.exe')
  assert.deepEqual(
    JSON.parse(windows.TOUCAN_CODEX_CONFIG_OVERRIDES ?? ''),
    codexCommandGuardOverrides('C:\\Toucan\\Toucan.exe', files, 'win32')
  )
  const posix = codexCommandGuardEnvironment({ runtime: '/opt/toucan', codex: '/codex', files, platform: 'darwin' })
  assert.equal(posix.CODEX_PATH, join('/toucan', '.agents', 'command-guard', 'codex-launcher.sh'))
})
