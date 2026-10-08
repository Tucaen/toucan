import {
  keptAsStale,
  type AgentProvider,
  type AgentRateLimitStatus,
  type ProviderUsageEntry,
  type ProviderUsageReport
} from '../shared/agent'

/**
 * Reading Claude's usage boots a CLI process, so this sits between the renderer's polling and the
 * providers: results are cached for a TTL and concurrent reads share one in-flight request. The
 * renderer can therefore poll on whatever cadence suits the UI without that cadence deciding how
 * often a process is spawned.
 *
 * A provider that fails or reports nothing keeps its last good value rather than blanking the
 * header, since a single failed read is far more likely to be a transient hiccup than a real
 * transition to "no limits apply". That kept value is reported as stale: keeping it is right, but
 * letting it pass for a fresh reading is what makes a failed refresh indistinguishable from a
 * successful one that found the same numbers.
 */
/** Reading a local file is synchronous while reading Claude's plan usage is not, so both are allowed. */
export interface ProviderUsageReader {
  read(): AgentRateLimitStatus | null | Promise<AgentRateLimitStatus | null>
}

export interface ProviderUsageOptions {
  readers: Partial<Record<AgentProvider, ProviderUsageReader>>
  ttlMs: number
  now?(): number
}

export interface ProviderUsageReadOptions {
  /**
   * Skip the TTL and ask the providers again. This exists for a read the user asked for by
   * clicking the header chip: the point of that click is to learn something the cached value does
   * not already say, so answering it from the cache would make the click look broken.
   */
  force?: boolean
  /**
   * Read only this provider. A click refreshes the chip it landed on, and the chip stays disabled
   * until its own read returns - so a provider whose CLI is slow or missing must not be able to
   * decide how long another provider's chip is unusable.
   */
  provider?: AgentProvider
}

/**
 * The outcome for one provider. `read()` remains the header-facing view and omits unavailable
 * providers; callers that need to explain an absent chip use this richer result instead.
 */
export interface ProviderUsageReadResult {
  /** `missing` means the provider had no usage to report; `failed` means its reader threw. */
  state: 'available' | 'missing' | 'failed'
  /** A failed or missing refresh may retain the last known entry, marked stale. */
  entry?: ProviderUsageEntry
}

export interface ProviderUsage {
  read(options?: ProviderUsageReadOptions): Promise<ProviderUsageReport>
  /** Reads exactly one provider, preserving why an entry is absent for non-UI consumers. */
  readProvider(
    provider: AgentProvider,
    options?: Pick<ProviderUsageReadOptions, 'force'>
  ): Promise<ProviderUsageReadResult>
  /**
   * Returns the current cache entry without starting a provider read. Shadow pacing uses this on
   * a spawn attempt, which must never make a CLI call or wait on one.
   */
  peekProvider(provider: AgentProvider): ProviderUsageReadResult
}

export function createProviderUsage(options: ProviderUsageOptions): ProviderUsage {
  const now = options.now ?? ((): number => Date.now())
  const cache = new Map<AgentProvider, { expiresAt: number; result: ProviderUsageReadResult }>()
  const inFlight = new Map<AgentProvider, Promise<ProviderUsageReadResult>>()

  const readProvider = async (
    provider: AgentProvider,
    reader: ProviderUsageReader,
    force: boolean
  ): Promise<ProviderUsageReadResult> => {
    const cached = cache.get(provider)
    if (!force && cached && cached.expiresAt > now()) return cached.result

    // A forced read still joins a request already on its way: that answer is no staler than one
    // started now, and joining keeps a burst of clicks from spawning a CLI process per click.
    const pending = inFlight.get(provider)
    if (pending) return pending

    // Wrapping in an async call normalizes a synchronous reader and a synchronous throw alike.
    const request = (async (): Promise<{ status: AgentRateLimitStatus | null; failed: boolean }> => {
      try {
        return { status: await reader.read(), failed: false }
      } catch {
        return { status: null, failed: true }
      }
    })()
      .then(({ status, failed }) => {
        // Keep the previous reading when this one came back empty, but say so: `readAt` stays at
        // the moment the kept reading was actually obtained, which is what the header dates it by.
        const kept = keptAsStale(cache.get(provider)?.result.entry)
        const result: ProviderUsageReadResult = status
          ? { state: 'available', entry: { status, readAt: now(), stale: false } }
          : { state: failed ? 'failed' : 'missing', ...(kept ? { entry: kept } : {}) }
        cache.set(provider, { expiresAt: now() + options.ttlMs, result })
        return result
      })
      .finally(() => inFlight.delete(provider))

    inFlight.set(provider, request)
    return request
  }

  return {
    peekProvider(provider) {
      const cached = cache.get(provider)
      if (!cached) return { state: 'missing' }
      // A spawn must not refresh usage itself, but an expired cache entry is no longer fresh
      // enough for its pacing decision. Preserve its value for the conservative fallback.
      const entry = cached.result.entry
      return cached.expiresAt > now() || !entry ? cached.result : { ...cached.result, entry: keptAsStale(entry) }
    },
    async readProvider(provider, readOptions) {
      const reader = options.readers[provider]
      if (!reader) return { state: 'missing' }
      return readProvider(provider, reader, readOptions?.force ?? false)
    },
    async read(readOptions?: ProviderUsageReadOptions): Promise<ProviderUsageReport> {
      const force = readOptions?.force ?? false
      const requested = readOptions?.provider
      const entries = (Object.entries(options.readers) as Array<[AgentProvider, ProviderUsageReader]>).filter(
        ([provider]) => !requested || provider === requested
      )
      const results = await Promise.all(
        entries.map(async ([provider, reader]) => [provider, await readProvider(provider, reader, force)] as const)
      )
      const report: ProviderUsageReport = {}
      for (const [provider, result] of results) {
        if (result.entry) report[provider] = result.entry
      }
      return report
    }
  }
}
