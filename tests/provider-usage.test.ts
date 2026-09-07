import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { AgentRateLimitStatus } from '../src/shared/agent'
import { createProviderUsage } from '../src/main/provider-usage'

function reader(statuses: Array<AgentRateLimitStatus | null>, calls: { count: number }) {
  return {
    read(): Promise<AgentRateLimitStatus | null> {
      const status = statuses[Math.min(calls.count, statuses.length - 1)]
      calls.count += 1
      return Promise.resolve(status)
    }
  }
}

test('reports each provider that has usage to report', async () => {
  const usage = createProviderUsage({
    readers: {
      claude: reader([{ fiveHour: { usedPercent: 53 } }], { count: 0 }),
      codex: reader([{ weekly: { usedPercent: 64 } }], { count: 0 })
    },
    ttlMs: 1000
  })

  assert.deepEqual(await usage.read(), {
    claude: { fiveHour: { usedPercent: 53 } },
    codex: { weekly: { usedPercent: 64 } }
  })
})

test('omits a provider that reports nothing rather than showing an empty chip', async () => {
  const usage = createProviderUsage({
    readers: { claude: reader([null], { count: 0 }), codex: reader([{ weekly: { usedPercent: 1 } }], { count: 0 }) },
    ttlMs: 1000
  })

  assert.deepEqual(await usage.read(), { codex: { weekly: { usedPercent: 1 } } })
})

test('a cached read does not spawn a second request inside the TTL', async () => {
  const calls = { count: 0 }
  let clock = 0
  const usage = createProviderUsage({
    readers: { claude: reader([{ fiveHour: { usedPercent: 10 } }], calls) },
    ttlMs: 1000,
    now: () => clock
  })

  await usage.read()
  await usage.read()
  assert.equal(calls.count, 1)

  clock = 1001
  await usage.read()
  assert.equal(calls.count, 2)
})

test('concurrent reads share one in-flight request', async () => {
  const calls = { count: 0 }
  const usage = createProviderUsage({
    readers: { claude: reader([{ weekly: { usedPercent: 7 } }], calls) },
    ttlMs: 1000
  })

  await Promise.all([usage.read(), usage.read(), usage.read()])
  assert.equal(calls.count, 1)
})

test('a failed refresh keeps the last known figure instead of blanking it', async () => {
  const calls = { count: 0 }
  let clock = 0
  const usage = createProviderUsage({
    readers: { claude: reader([{ fiveHour: { usedPercent: 42 } }, null], calls) },
    ttlMs: 100,
    now: () => clock
  })

  assert.deepEqual(await usage.read(), { claude: { fiveHour: { usedPercent: 42 } } })

  clock = 200
  assert.deepEqual(await usage.read(), { claude: { fiveHour: { usedPercent: 42 } } })
  assert.equal(calls.count, 2)
})

test('a reader that throws is treated as a failed refresh, not a crash', async () => {
  const usage = createProviderUsage({
    readers: { claude: { read: () => Promise.reject(new Error('boom')) } },
    ttlMs: 100
  })

  assert.deepEqual(await usage.read(), {})
})

test('a synchronous reader is supported alongside an asynchronous one', async () => {
  const usage = createProviderUsage({
    readers: {
      // The Codex reader reads a local file and returns a plain value, not a promise.
      codex: { read: () => ({ weekly: { usedPercent: 64 } }) },
      claude: { read: () => Promise.resolve({ fiveHour: { usedPercent: 53 } }) }
    },
    ttlMs: 1000
  })

  assert.deepEqual(await usage.read(), {
    codex: { weekly: { usedPercent: 64 } },
    claude: { fiveHour: { usedPercent: 53 } }
  })
})

test('a synchronous reader that throws is caught like an async failure', async () => {
  const usage = createProviderUsage({
    readers: {
      codex: {
        read: () => {
          throw new Error('unreadable transcript')
        }
      }
    },
    ttlMs: 100
  })

  assert.deepEqual(await usage.read(), {})
})

test('a forced read bypasses the cache the poll is served from', async () => {
  let reads = 0
  const usage = createProviderUsage({
    readers: { claude: { read: () => Promise.resolve({ fiveHour: { usedPercent: reads++ } }) } },
    ttlMs: 60_000
  })

  assert.deepEqual(await usage.read(), { claude: { fiveHour: { usedPercent: 0 } } })
  // Still inside the TTL, so the poll sees the cached reading and a forced read does not.
  assert.deepEqual(await usage.read(), { claude: { fiveHour: { usedPercent: 0 } } })
  assert.deepEqual(await usage.read({ force: true }), { claude: { fiveHour: { usedPercent: 1 } } })
  assert.equal(reads, 2)
})

test('a forced read that fails keeps the last good reading', async () => {
  let attempt = 0
  const usage = createProviderUsage({
    readers: {
      claude: {
        read: () => {
          attempt += 1
          return attempt === 1
            ? Promise.resolve({ fiveHour: { usedPercent: 41 } })
            : Promise.reject(new Error('offline'))
        }
      }
    },
    ttlMs: 60_000
  })

  await usage.read()
  assert.deepEqual(await usage.read({ force: true }), { claude: { fiveHour: { usedPercent: 41 } } })
})
