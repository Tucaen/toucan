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

export interface ProviderUsage {
  read(options?: ProviderUsageReadOptions): Promise<ProviderUsageReport>
}

export function createProviderUsage(options: ProviderUsageOptions): ProviderUsage {
  const now = options.now ?? ((): number => Date.now())
  const cache = new Map<AgentProvider, { expiresAt: number; entry: ProviderUsageEntry | null }>()
  const inFlight = new Map<AgentProvider, Promise<ProviderUsageEntry | null>>()

  const readProvider = async (
    provider: AgentProvider,
    reader: ProviderUsageReader,
    force: boolean
  ): Promise<ProviderUsageEntry | null> => {
    const cached = cache.get(provider)
    if (!force && cached && cached.expiresAt > now()) return cached.entry

    // A forced read still joins a request already on its way: that answer is no staler than one
    // started now, and joining keeps a burst of clicks from spawning a CLI process per click.
    const pending = inFlight.get(provider)
    if (pending) return pending

    // Wrapping in an async call normalizes a synchronous reader and a synchronous throw alike.
    const request = (async () => reader.read())()
      .catch(() => null)
      .then((status) => {
        // Keep the previous reading when this one came back empty, but say so: `readAt` stays at
        // the moment the kept reading was actually obtained, which is what the header dates it by.
        const kept = keptAsStale(cache.get(provider)?.entry ?? undefined)
        const entry: ProviderUsageEntry | null = status ? { status, readAt: now(), stale: false } : (kept ?? null)
        cache.set(provider, { expiresAt: now() + options.ttlMs, entry })
        return entry
      })
      .finally(() => inFlight.delete(provider))

    inFlight.set(provider, request)
    return request
  }

  return {
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
      for (const [provider, entry] of results) {
        if (entry) report[provider] = entry
      }
      return report
    }
  }
}
