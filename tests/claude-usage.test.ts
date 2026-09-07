import { strict as assert } from 'node:assert'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { hiddenProcessOptions } from '../src/main/background-process'
import { claudeRateLimitsFromUsage, createClaudeUsageReader, resolveClaudeSdkSpecifier } from '../src/main/claude-usage'

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
