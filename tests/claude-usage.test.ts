import { strict as assert } from 'node:assert'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'
import { hiddenProcessOptions } from '../src/main/background-process'
import {
  claudeRateLimitsFromUsage,
  createClaudeUsageReader,
  requestUsageViaSdk,
  resolveClaudeExecutable,
  resolveClaudeSdkSpecifier,
  type SdkRequestDependencies
} from '../src/main/claude-usage'

test('maps both plan windows, converting the ISO reset into epoch milliseconds', () => {
  const status = claudeRateLimitsFromUsage({
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 53, resets_at: '2026-08-27T10:59:59.854372+00:00' },
      seven_day: { utilization: 27, resets_at: '2026-09-01T02:59:59.854392+00:00' }
    }
  })

  assert.deepEqual(status, {
    fiveHour: { usedPercent: 53, resetsAt: Date.parse('2026-08-27T10:59:59.854372+00:00') },
    weekly: { usedPercent: 27, resetsAt: Date.parse('2026-09-01T02:59:59.854392+00:00') }
  })
})

test('a per-model allowance such as Fable is kept under the name the server gives it', () => {
  const status = claudeRateLimitsFromUsage({
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 42, resets_at: '2026-09-07T10:00:00.455761+00:00' },
      seven_day: { utilization: 24, resets_at: '2026-09-08T03:00:00.455787+00:00' },
      model_scoped: [
        { display_name: 'Fable', utilization: 43, resets_at: '2026-09-08T03:00:00.456106+00:00' },
        // Unnamed or unmetered entries cannot be attributed to anything and are dropped.
        { display_name: '', utilization: 10, resets_at: null },
        { display_name: 'Opus', utilization: null, resets_at: null }
      ]
    }
  })

  // The weekly span travels with the window so the UI can place a reset marker on it.
  assert.deepEqual(status?.models, [
    {
      label: 'Fable',
      windowMinutes: 7 * 24 * 60,
      usedPercent: 43,
      resetsAt: Date.parse('2026-09-08T03:00:00.456106+00:00')
    }
  ])
  assert.equal(status?.fiveHour?.usedPercent, 42)
  assert.equal(status?.weekly?.usedPercent, 24)
})

test('a plan that only reports a per-model allowance still produces a status', () => {
  const status = claudeRateLimitsFromUsage({
    rate_limits_available: true,
    rate_limits: { model_scoped: [{ display_name: 'Fable', utilization: 7, resets_at: null }] }
  })

  assert.deepEqual(status, { models: [{ label: 'Fable', windowMinutes: 7 * 24 * 60, usedPercent: 7 }] })
})

test('keeps a window that reports usage without a reset time', () => {
  const status = claudeRateLimitsFromUsage({
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 12, resets_at: null }, seven_day: null }
  })

  assert.deepEqual(status, { fiveHour: { usedPercent: 12 } })
})

test('reports nothing when plan limits do not apply to the session', () => {
  const status = claudeRateLimitsFromUsage({
    rate_limits_available: false,
    rate_limits: null
  })

  assert.equal(status, null)
})

test('reports nothing rather than a zeroed window when no window is present', () => {
  assert.equal(claudeRateLimitsFromUsage({ rate_limits_available: true, rate_limits: {} }), null)
  assert.equal(claudeRateLimitsFromUsage(null), null)
})

test('an unusable reset time leaves the window without one instead of NaN', () => {
  const status = claudeRateLimitsFromUsage({
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 5, resets_at: 'not a date' } }
  })

  assert.deepEqual(status, { fiveHour: { usedPercent: 5 } })
})

test('a failing usage request leaves the header blank and says why instead of propagating', async () => {
  const warnings: string[] = []
  const reader = createClaudeUsageReader({
    cwd: 'C:\\anywhere',
    requestUsage: () => Promise.reject(new Error('claude is not installed')),
    log: (message) => warnings.push(message)
  })

  assert.equal(await reader.read(), null)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /claude is not installed/)
})

test('the SDK specifier is an absolute file URL to the ESM entry beside this module', () => {
  const specifier = resolveClaudeSdkSpecifier()

  assert.ok(specifier.startsWith('file:'), specifier)
  const resolved = fileURLToPath(specifier)
  assert.ok(resolved.includes(join(sep, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', sep)), resolved)
  assert.ok(existsSync(resolved), resolved)
})

/**
 * The packaged app launches with an arbitrary cwd, and a `Function`-constructed import has no module
 * referrer, so Node resolves a bare specifier against that cwd. Loading from a foreign directory
 * reproduces the installed-app failure the resolved URL exists to prevent.
 */
function importFromForeignCwd(specifier: string): SpawnSyncReturns<string> {
  const script = `import(${JSON.stringify(specifier)}).then((m) => process.stdout.write(typeof m.query), (error) => { process.stderr.write(String(error.code ?? error)); process.exit(1) })`
  const result = spawnSync(
    process.execPath,
    ['-e', script],
    hiddenProcessOptions({ cwd: tmpdir(), encoding: 'utf8', timeout: 30_000 })
  )
  if (result.error) throw result.error
  return result
}

test('the resolved specifier imports from a cwd outside the app directory where the bare one cannot', () => {
  const bare = importFromForeignCwd('@anthropic-ai/claude-agent-sdk')
  assert.notEqual(bare.status, 0, 'the bare specifier should not resolve from a foreign cwd')
  assert.match(bare.stderr, /ERR_MODULE_NOT_FOUND/)

  const resolved = importFromForeignCwd(resolveClaudeSdkSpecifier())
  assert.equal(resolved.status, 0, resolved.stderr)
  assert.equal(resolved.stdout, 'function')
})

test('reads through the injected request without spawning a CLI', async () => {
  const seen: string[] = []
  const reader = createClaudeUsageReader({
    cwd: 'C:\\projects\\toucan',
    log: () => undefined,
    requestUsage: (cwd) => {
      seen.push(cwd)
      return Promise.resolve({
        rate_limits_available: true,
        rate_limits: { seven_day: { utilization: 80, resets_at: null } }
      })
    }
  })

  assert.deepEqual(await reader.read(), { weekly: { usedPercent: 80 } })
  assert.deepEqual(seen, ['C:\\projects\\toucan'])
})

/**
 * The SDK locates `claude.exe` relative to its own module and hands that path to `spawn`. Inside
 * the installed app that path is in `app.asar`, which Windows cannot execute and which Electron does
 * not remap for `child_process`, so the reader must hand the SDK the `app.asar.unpacked` copy (#157).
 */
test('the Claude executable is resolved from the SDK directory, mirroring the SDK lookup', () => {
  const sdkDir = 'C:\\dev\\toucan\\node_modules\\@anthropic-ai\\claude-agent-sdk'
  const seen: Array<[string, string]> = []
  const executable = resolveClaudeExecutable({
    sdkDir,
    platform: 'win32',
    arch: 'x64',
    resolve: (specifier, fromDir) => {
      seen.push([specifier, fromDir])
      return join(fromDir, 'node_modules', specifier)
    },
    exists: () => true
  })

  assert.deepEqual(seen, [['@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe', sdkDir]])
  assert.equal(executable, join(sdkDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe'))
})

test('a packed executable is handed over as its app.asar.unpacked twin', () => {
  const packed = 'C:\\app\\resources\\app.asar\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe'
  const unpacked =
    'C:\\app\\resources\\app.asar.unpacked\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe'
  const executable = resolveClaudeExecutable({
    sdkDir: 'C:\\app\\resources\\app.asar\\node_modules\\@anthropic-ai\\claude-agent-sdk',
    platform: 'win32',
    arch: 'x64',
    resolve: () => packed,
    exists: (path) => path === unpacked
  })

  assert.equal(executable, unpacked)
})

test('linux tries the glibc package before the musl one, and a missing binary leaves the SDK to its own lookup', () => {
  const tried: string[] = []
  const executable = resolveClaudeExecutable({
    sdkDir: '/opt/app/node_modules/@anthropic-ai/claude-agent-sdk',
    platform: 'linux',
    arch: 'arm64',
    resolve: (specifier) => {
      tried.push(specifier)
      throw new Error('not found')
    },
    exists: () => false
  })

  assert.equal(executable, undefined)
  assert.deepEqual(tried, [
    '@anthropic-ai/claude-agent-sdk-linux-arm64/claude',
    '@anthropic-ai/claude-agent-sdk-linux-arm64-musl/claude'
  ])
})

test('the real SDK install resolves to an existing claude executable beside the SDK', () => {
  const executable = resolveClaudeExecutable()

  assert.ok(executable, 'the platform package should be installed')
  assert.ok(existsSync(executable), executable)
  assert.ok(executable.includes(join(sep, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-')), executable)
})

/** An SDK stand-in whose `query` records the options it was handed and answers usage with `response`. */
function fakeSdk(response: object, seen: unknown[]): SdkRequestDependencies['loadSdk'] {
  const idle = (async function* (): AsyncGenerator<never, void> {})()
  const query = Object.assign(idle, {
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => Promise.resolve(response)
  })
  return () =>
    Promise.resolve({
      query: (params: { options?: unknown }) => {
        seen.push(params.options)
        return query
      }
    })
}

test('the usage request names the resolved executable so the SDK never spawns from app.asar', async () => {
  const seen: unknown[] = []
  const response = await requestUsageViaSdk('C:\\home', {
    loadSdk: fakeSdk({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 3 } } }, seen),
    locateExecutable: () => 'C:\\app\\resources\\app.asar.unpacked\\claude.exe'
  })

  assert.deepEqual(response, { rate_limits_available: true, rate_limits: { five_hour: { utilization: 3 } } })
  assert.deepEqual(seen, [
    { cwd: 'C:\\home', pathToClaudeCodeExecutable: 'C:\\app\\resources\\app.asar.unpacked\\claude.exe' }
  ])
})

test('without a resolvable executable the request leaves the SDK to its own lookup', async () => {
  const seen: unknown[] = []
  await requestUsageViaSdk('C:\\home', {
    loadSdk: fakeSdk({ rate_limits_available: false }, seen),
    locateExecutable: () => undefined
  })

  assert.deepEqual(seen, [{ cwd: 'C:\\home' }])
})
