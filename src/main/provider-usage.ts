import type { AgentProvider, AgentRateLimitStatus, ProviderRateLimits } from '../shared/agent'

/**
 * Reading Claude's usage boots a CLI process, so this sits between the renderer's polling and the
 * providers: results are cached for a TTL and concurrent reads share one in-flight request. The
 * renderer can therefore poll on whatever cadence suits the UI without that cadence deciding how
 * often a process is spawned.
 *
 * A provider that fails or reports nothing keeps its last good value rather than blanking the
 * header, since a single failed read is far more likely to be a transient hiccup than a real
 * transition to "no limits apply".
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
}

export interface ProviderUsage {
  read(options?: ProviderUsageReadOptions): Promise<ProviderRateLimits>
}

export function createProviderUsage(options: ProviderUsageOptions): ProviderUsage {
  const now = options.now ?? ((): number => Date.now())
  const cache = new Map<AgentProvider, { expiresAt: number; status: AgentRateLimitStatus | null }>()
  const inFlight = new Map<AgentProvider, Promise<AgentRateLimitStatus | null>>()

  const readProvider = async (
    provider: AgentProvider,
    reader: ProviderUsageReader,
    force: boolean
  ): Promise<AgentRateLimitStatus | null> => {
    const cached = cache.get(provider)
    if (!force && cached && cached.expiresAt > now()) return cached.status

    // A forced read still joins a request already on its way: that answer is no staler than one
    // started now, and joining keeps a burst of clicks from spawning a CLI process per click.
    const pending = inFlight.get(provider)
    if (pending) return pending

    // Wrapping in an async call normalizes a synchronous reader and a synchronous throw alike.
    const request = (async () => reader.read())()
      .catch(() => null)
      .then((status) => {
        // Keep the previous reading when this one came back empty; only a real report replaces it.
        const resolved = status ?? cache.get(provider)?.status ?? null
        cache.set(provider, { expiresAt: now() + options.ttlMs, status: resolved })
        return resolved
      })
      .finally(() => inFlight.delete(provider))

    inFlight.set(provider, request)
    return request
  }

  return {
    async read(readOptions?: ProviderUsageReadOptions): Promise<ProviderRateLimits> {
      const force = readOptions?.force ?? false
      const entries = Object.entries(options.readers) as Array<[AgentProvider, ProviderUsageReader]>
      const results = await Promise.all(
        entries.map(async ([provider, reader]) => [provider, await readProvider(provider, reader, force)] as const)
      )
      const limits: ProviderRateLimits = {}
      for (const [provider, status] of results) {
        if (status) limits[provider] = status
      }
      return limits
    }
  }
}
