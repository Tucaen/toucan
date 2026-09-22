import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import {
  codexRateLimitsFromAppServer,
  createCodexRateLimitReader,
  parseCodexRateLimits,
  resolveBundledCodexAppServerLaunch,
  resolveCodexAppServerLaunch
} from '../src/main/codex-rate-limits'

function tokenCount(rateLimits: unknown): string {
  return JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: rateLimits } })
}

/** Before every `resets_at` the fixtures use, so a test only opts in to expiry when it says so. */
const BEFORE_ANY_RESET = 1_700_000_000_000

test('reads the weekly window from a Codex plan that meters only one', () => {
  const status = parseCodexRateLimits(
    [
      tokenCount({
        limit_id: 'codex',
        primary: { used_percent: 64, window_minutes: 10080, resets_at: 1788169581 },
        secondary: null
      })
    ],
    BEFORE_ANY_RESET
  )

  assert.deepEqual(status, { weekly: { usedPercent: 64, resetsAt: 1788169581000 } })
})

test('buckets a short window as five-hour and a long one as weekly', () => {
  const status = parseCodexRateLimits(
    [
      tokenCount({
        primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1788000000 },
        secondary: { used_percent: 80, window_minutes: 10080, resets_at: 1788169581 }
      })
    ],
    BEFORE_ANY_RESET
  )

  assert.deepEqual(status, {
    fiveHour: { usedPercent: 12.5, resetsAt: 1788000000000 },
    weekly: { usedPercent: 80, resetsAt: 1788169581000 }
  })
})

test('the newest report wins over earlier ones', () => {
  const status = parseCodexRateLimits([
    tokenCount({ primary: { used_percent: 10, window_minutes: 10080 } }),
    tokenCount({ primary: { used_percent: 42, window_minutes: 10080 } })
  ])

  assert.deepEqual(status, { weekly: { usedPercent: 42 } })
})

test('a reached limit is reported as rejected', () => {
  const status = parseCodexRateLimits([
    tokenCount({
      primary: { used_percent: 100, window_minutes: 10080 },
      rate_limit_reached_type: 'primary'
    })
  ])

  assert.equal(status?.rejected, true)
})

test('records without usable rate limits are skipped in favour of older ones that have them', () => {
  const status = parseCodexRateLimits([
    tokenCount({ primary: { used_percent: 33, window_minutes: 10080 } }),
    tokenCount(null),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } }),
    'not json at all'
  ])

  assert.deepEqual(status, { weekly: { usedPercent: 33 } })
})

test('a transcript with no rate limits at all reports nothing rather than a zeroed window', () => {
  assert.equal(parseCodexRateLimits([tokenCount(null), 'partial line {']), null)
})

test('reads live Codex account limits instead of showing a stale transcript value', async () => {
  const reader = createCodexRateLimitReader({
    homeDirectory: 'missing-home',
    environment: {},
    requestRateLimits: async () => ({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1787943590 },
        secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1788505836 }
      }
    }),
    log: () => {}
  })

  assert.deepEqual(await reader.read(), {
    fiveHour: { usedPercent: 7, resetsAt: 1787943590000 },
    weekly: { usedPercent: 1, resetsAt: 1788505836000 }
  })
})

test('an allowance keyed by another limit id is surfaced by name beside the account-wide windows', () => {
  const status = codexRateLimitsFromAppServer({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 29, windowDurationMins: 300, resetsAt: 1788782448 },
      secondary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1789369248 }
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        primary: { usedPercent: 29, windowDurationMins: 300, resetsAt: 1788782448 },
        secondary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1789369248 }
      },
      astra: {
        limitId: 'astra',
        limitName: 'Astra',
        primary: { usedPercent: 12, windowDurationMins: 300 },
        secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 1789369248 }
      },
      unnamed: { limitId: 'unnamed', limitName: null, primary: { usedPercent: 3, windowDurationMins: 300 } },
      empty: { limitId: 'empty', primary: null, secondary: null }
    }
  })

  assert.deepEqual(status, {
    fiveHour: { usedPercent: 29, resetsAt: 1788782448000 },
    weekly: { usedPercent: 4, resetsAt: 1789369248000 },
    // Each allowance carries the length of the window it surfaced, so the UI can mark its reset.
    models: [
      { label: 'Astra', windowMinutes: 10080, usedPercent: 61, resetsAt: 1789369248000 },
      { label: 'unnamed', windowMinutes: 300, usedPercent: 3 }
    ]
  })
})

test('a Windows npm command shim resolves directly to the native Codex executable', () => {
  const command = 'C:\\app\\node_modules\\.bin\\codex.cmd'
  const executable = 'C:\\app\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe'

  assert.deepEqual(
    resolveCodexAppServerLaunch(command, 'x64', (path) => path === executable),
    {
      executable,
      args: ['app-server', '--listen', 'stdio://']
    }
  )
})

test('a transcript window whose reset has passed reports empty rather than its cached fill', () => {
  const status = parseCodexRateLimits(
    [
      tokenCount({
        primary: { used_percent: 94, window_minutes: 300, resets_at: 1789379860 },
        secondary: { used_percent: 84, window_minutes: 10080, resets_at: 1789817499 }
      })
    ],
    // A day after the five-hour window reset, while the weekly one still stands.
    1789455503000
  )

  assert.deepEqual(status, {
    fiveHour: { usedPercent: 0 },
    weekly: { usedPercent: 84, resetsAt: 1789817499000 }
  })
})

test('a cached limit-reached flag does not survive the window resetting', () => {
  const status = parseCodexRateLimits(
    [
      tokenCount({
        primary: { used_percent: 100, window_minutes: 300, resets_at: 1789379860 },
        rate_limit_reached_type: 'primary'
      })
    ],
    1789455503000
  )

  assert.deepEqual(status, { fiveHour: { usedPercent: 0 } })
})

test('the bundled Codex answers when no CLI is installed on PATH', () => {
  const appPath = 'C:\\app\\resources\\app.asar'
  const executable =
    'C:\\app\\resources\\app.asar.unpacked\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe'

  assert.deepEqual(
    resolveBundledCodexAppServerLaunch(appPath, 'x64', (path) => path === executable),
    {
      executable,
      args: ['app-server', '--listen', 'stdio://']
    }
  )
})

test('an unpackaged application root resolves the bundled Codex in place', () => {
  const executable =
    'C:\\Development\\ade\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe'

  assert.deepEqual(
    resolveBundledCodexAppServerLaunch('C:\\Development\\ade', 'x64', (path) => path === executable),
    { executable, args: ['app-server', '--listen', 'stdio://'] }
  )
})

test('a platform Codex does not bundle has no launch to fall back to', () => {
  assert.equal(
    resolveBundledCodexAppServerLaunch('C:\\app', 'ia32', () => true),
    null
  )
})

test('a failed live read is reported through the log rather than silently cached', async () => {
  const messages: string[] = []
  const reader = createCodexRateLimitReader({
    homeDirectory: 'C:\\Users\\nobody',
    environment: { CODEX_HOME: 'C:\\Users\\nobody\\.codex-missing' },
    requestRateLimits: () => Promise.reject(new Error('not authenticated')),
    log: (message) => messages.push(message)
  })

  assert.equal(await reader.read(), null)
  assert.deepEqual(messages, ['injected rate-limit read failed: not authenticated'])
})

test('a reader with no Codex to launch says so instead of falling through in silence', async () => {
  const messages: string[] = []
  const reader = createCodexRateLimitReader({
    homeDirectory: 'C:\\Users\\nobody',
    environment: { CODEX_HOME: 'C:\\Users\\nobody\\.codex-missing' },
    log: (message) => messages.push(message)
  })

  assert.equal(await reader.read(), null)
  assert.deepEqual(messages, ['no Codex app-server could be resolved from PATH or the bundled copy'])
})
