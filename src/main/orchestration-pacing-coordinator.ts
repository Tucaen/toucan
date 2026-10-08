import type { AgentPromptResult } from '../shared/agent'
import type { AgentProvider } from '../shared/agent-provider'
import {
  clearOrchestrationPacing,
  deferOrchestration,
  type OrchestrationPacingDeferral,
  type OrchestrationRecord
} from '../shared/orchestration'
import {
  decideOrchestrationPacing,
  type OrchestrationPacingPolicy,
  type OrchestrationPacingRecommendation,
  type OrchestrationUsageFreshness
} from '../shared/orchestration-pacing'
import type { OrchestrationKey, OrchestrationStore } from './orchestration-store'
import type { ProviderUsage, ProviderUsageReadResult } from './provider-usage'

export type OrchestrationPacingAdmission =
  | { admitted: true; release(): void }
  | {
      admitted: false
      deferred: true
      provider: AgentProvider
      state: 'drain' | 'pause'
      reason: OrchestrationPacingRecommendation['reason']
      retryAt?: number
    }

export interface OrchestrationPacingCoordinatorOptions {
  records: Pick<OrchestrationStore, 'read' | 'update'>
  usage: Pick<ProviderUsage, 'readProvider'>
  /** The enforcement switch. Shadow recommendations remain available when this is false. */
  enabled: boolean
  activeTicketSessions(provider: AgentProvider): number | Promise<number>
  wake(orchestratorNodeId: string, prompt: string): Promise<AgentPromptResult>
  policy?: OrchestrationPacingPolicy
  changed?(record: OrchestrationRecord): void
  now?(): number
  schedule?(callback: () => void, ms: number): () => void
  log?(message: string): void
}

export interface OrchestrationPacingCoordinator {
  admit(request: { key: OrchestrationKey; orchestratorNodeId: string }): Promise<OrchestrationPacingAdmission>
  recommend(provider: AgentProvider, usage: ProviderUsageReadResult): Promise<OrchestrationPacingRecommendation>
  /** Re-registers a record's durable deferral after a Toucan restart. */
  restore(key: OrchestrationKey, orchestratorNodeId: string): Promise<void>
  /** A provider ticket entered or left the live provider-wide count. */
  activityChanged(provider: AgentProvider): void
  /** Retries a reopening wake that arrived before the orchestrator session was ready. */
  ready(orchestratorNodeId: string): void
  idle(): Promise<void>
  close(): void
}

interface DeferredOrchestration {
  id: string
  key: OrchestrationKey
  orchestratorNodeId: string
  recommendation: OrchestrationPacingRecommendation
  reopened: boolean
  wakeAccepted: boolean
}

const keyId = (key: OrchestrationKey): string => `${key.provider}:${key.conversationId}`
const nowIso = (now: number): string => new Date(now).toISOString()

const freshness = (result: ProviderUsageReadResult): OrchestrationUsageFreshness =>
  result.entry ? (result.entry.stale ? 'stale' : 'fresh') : 'unavailable'

const recommendationFrom = (pacing: OrchestrationPacingDeferral): OrchestrationPacingRecommendation => ({
  action: 'spawn',
  state: pacing.state,
  reason: pacing.reason,
  constrainingWindow: pacing.constrainingWindow,
  freshness: pacing.freshness,
  activeTicketSessions: pacing.activeTicketSessions,
  ...(pacing.retryAt !== undefined ? { resetsAt: pacing.retryAt } : {})
})

const reopeningPrompt = (provider: AgentProvider): string =>
  `Provider pacing reopened for ${provider}. Before retrying spawn, reread usage, status and plan show. ` +
  'Do not poll, sleep, change provider, or lower the requested model or effort.'

/**
 * Serializes enforced spawn admission per provider. A provisional admission counts as active until
 * its caller releases it, closing the gap before the new canvas session appears in the broker.
 * Deferred orchestrations are durable, while locks, provisional counts and wake coalescing are
 * deliberately process-local.
 */
export function createOrchestrationPacingCoordinator(
  options: OrchestrationPacingCoordinatorOptions
): OrchestrationPacingCoordinator {
  const now = options.now ?? Date.now
  const schedule =
    options.schedule ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms)
      return () => clearTimeout(timer)
    })
  const chains = new Map<AgentProvider, Promise<void>>()
  const pendingAdmissions = new Map<AgentProvider, number>()
  const deferred = new Map<AgentProvider, Map<string, DeferredOrchestration>>()
  const timers = new Map<AgentProvider, () => void>()
  const rechecks = new Map<AgentProvider, Promise<void>>()
  const inFlight = new Set<Promise<unknown>>()
  let closed = false

  const track = <T>(promise: Promise<T>): Promise<T> => {
    inFlight.add(promise)
    void promise.finally(() => inFlight.delete(promise)).catch(() => undefined)
    return promise
  }

  const serial = <T>(provider: AgentProvider, operation: () => T | Promise<T>): Promise<T> => {
    const previous = chains.get(provider) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    const tail = current.then(
      () => undefined,
      () => undefined
    )
    chains.set(provider, tail)
    void tail.finally(() => {
      if (chains.get(provider) === tail) chains.delete(provider)
    })
    return current
  }

  const activeCount = async (provider: AgentProvider): Promise<number> => {
    const live = await Promise.resolve(options.activeTicketSessions(provider)).catch(() => 0)
    return Math.max(0, live) + (pendingAdmissions.get(provider) ?? 0)
  }

  const decide = async (
    provider: AgentProvider,
    result: ProviderUsageReadResult
  ): Promise<OrchestrationPacingRecommendation> =>
    decideOrchestrationPacing(
      {
        action: 'spawn',
        usage: result.entry ?? null,
        freshness: freshness(result),
        now: now(),
        activeTicketSessions: await activeCount(provider)
      },
      options.policy
    )

  const updateRecord = async (
    key: OrchestrationKey,
    transform: (record: OrchestrationRecord) => OrchestrationRecord
  ): Promise<OrchestrationRecord | undefined> =>
    options.records.update(key, (current) => {
      if (!current) return { value: current, result: current }
      const next = transform(current)
      return { value: next, result: next }
    })

  const clearRecord = async (waiter: DeferredOrchestration): Promise<void> => {
    const record = await updateRecord(waiter.key, (current) => clearOrchestrationPacing(current, nowIso(now())))
    if (record) options.changed?.(record)
  }

  const remember = async (
    key: OrchestrationKey,
    orchestratorNodeId: string,
    recommendation: OrchestrationPacingRecommendation
  ): Promise<DeferredOrchestration> => {
    const waiter: DeferredOrchestration = {
      id: keyId(key),
      key,
      orchestratorNodeId,
      recommendation,
      reopened: false,
      wakeAccepted: false
    }
    const record = await updateRecord(key, (current) => deferOrchestration(current, recommendation, nowIso(now())))
    if (record) options.changed?.(record)
    if (!record?.pacing) return waiter
    let providerWaiters = deferred.get(key.provider)
    if (!providerWaiters) {
      providerWaiters = new Map()
      deferred.set(key.provider, providerWaiters)
    }
    providerWaiters.set(waiter.id, waiter)
    return waiter
  }

  const forget = (waiter: DeferredOrchestration): void => {
    const providerWaiters = deferred.get(waiter.key.provider)
    if (providerWaiters?.get(waiter.id) !== waiter) return
    providerWaiters.delete(waiter.id)
    if (providerWaiters.size === 0) deferred.delete(waiter.key.provider)
  }

  const arm = (provider: AgentProvider): void => {
    timers.get(provider)?.()
    timers.delete(provider)
    if (closed) return
    const retryAt = [...(deferred.get(provider)?.values() ?? [])]
      .filter((waiter) => !waiter.reopened)
      .flatMap((waiter) =>
        waiter.recommendation.resetsAt !== undefined && waiter.recommendation.resetsAt > now()
          ? [waiter.recommendation.resetsAt]
          : []
      )
      .sort((left, right) => left - right)[0]
    if (retryAt === undefined) return
    const cancel = schedule(
      () => {
        if (timers.get(provider) !== cancel) return
        timers.delete(provider)
        requestRecheck(provider)
      },
      Math.max(0, retryAt - now())
    )
    timers.set(provider, cancel)
  }

  const finishWake = async (waiter: DeferredOrchestration): Promise<void> => {
    if (deferred.get(waiter.key.provider)?.get(waiter.id) !== waiter || !waiter.reopened) return
    if (!waiter.wakeAccepted) {
      let result: AgentPromptResult
      try {
        result = await options.wake(waiter.orchestratorNodeId, reopeningPrompt(waiter.key.provider))
      } catch (error) {
        options.log?.(`provider pacing wake could not be delivered: ${String(error)}`)
        return
      }
      if (result.undelivered) return
      waiter.wakeAccepted = true
      if (!result.ok) options.log?.(`provider pacing wake failed: ${result.message ?? 'unknown'}`)
    }
    await clearRecord(waiter)
    forget(waiter)
    arm(waiter.key.provider)
  }

  const recheck = async (provider: AgentProvider): Promise<void> => {
    const reading = options.usage
      .readProvider(provider, { force: true })
      .catch((): ProviderUsageReadResult => ({ state: 'failed' }))
    const reopening = await serial(provider, async () => {
      const result = await reading
      const recommendation = await decide(provider, result)
      const ready: DeferredOrchestration[] = []
      for (const waiter of [...(deferred.get(provider)?.values() ?? [])]) {
        const record = await options.records.read(waiter.key)
        if (!record || record.lifecycle !== undefined) {
          forget(waiter)
          continue
        }
        if (recommendation.state === 'unrestricted') {
          waiter.reopened = true
          ready.push(waiter)
          continue
        }
        waiter.recommendation = recommendation
        waiter.reopened = false
        waiter.wakeAccepted = false
        await remember(waiter.key, waiter.orchestratorNodeId, recommendation)
      }
      arm(provider)
      return ready
    })
    await Promise.all(reopening.map((waiter) => finishWake(waiter)))
  }

  function requestRecheck(provider: AgentProvider): void {
    if (closed || deferred.get(provider)?.size === undefined || rechecks.has(provider)) return
    const request = track(
      recheck(provider).catch((error: unknown) => {
        options.log?.(`provider pacing recheck failed: ${String(error)}`)
      })
    ).finally(() => {
      if (rechecks.get(provider) === request) rechecks.delete(provider)
    })
    rechecks.set(provider, request)
  }

  return {
    async recommend(provider, result) {
      return serial(provider, () => decide(provider, result))
    },

    async admit({ key, orchestratorNodeId }) {
      if (!options.enabled) {
        await serial(key.provider, async () => {
          const waiter = deferred.get(key.provider)?.get(keyId(key))
          if (waiter) forget(waiter)
          const record = await updateRecord(key, (current) => clearOrchestrationPacing(current, nowIso(now())))
          if (record) options.changed?.(record)
        })
        return { admitted: true, release: () => undefined }
      }

      // Start the provider read before entering the provider queue. Concurrent calls therefore join
      // ProviderUsage's in-flight request, while the decisions that consume it remain serialized.
      const reading = options.usage
        .readProvider(key.provider, { force: true })
        .catch((): ProviderUsageReadResult => ({ state: 'failed' }))
      return serial(key.provider, async (): Promise<OrchestrationPacingAdmission> => {
        const recommendation = await decide(key.provider, await reading)
        options.log?.(
          `enforced pacing spawn provider=${key.provider} state=${recommendation.state} freshness=${recommendation.freshness} ` +
            `active=${recommendation.activeTicketSessions} reason=${recommendation.reason} window=${recommendation.constrainingWindow}`
        )
        if (recommendation.state !== 'unrestricted') {
          await remember(key, orchestratorNodeId, recommendation)
          arm(key.provider)
          return {
            admitted: false,
            deferred: true,
            provider: key.provider,
            state: recommendation.state,
            reason: recommendation.reason,
            ...(recommendation.resetsAt !== undefined ? { retryAt: recommendation.resetsAt } : {})
          }
        }

        const waiter = deferred.get(key.provider)?.get(keyId(key))
        if (waiter) {
          forget(waiter)
          await clearRecord(waiter)
          arm(key.provider)
        }
        pendingAdmissions.set(key.provider, (pendingAdmissions.get(key.provider) ?? 0) + 1)
        let released = false
        return {
          admitted: true,
          release: () => {
            if (released) return
            released = true
            const remaining = Math.max(0, (pendingAdmissions.get(key.provider) ?? 1) - 1)
            if (remaining === 0) pendingAdmissions.delete(key.provider)
            else pendingAdmissions.set(key.provider, remaining)
            requestRecheck(key.provider)
          }
        }
      })
    },

    async restore(key, orchestratorNodeId) {
      if (closed) return
      if (!options.enabled) {
        await serial(key.provider, async () => {
          let cleared = false
          const record = await updateRecord(key, (current) => {
            if (!current.pacing) return current
            cleared = true
            return clearOrchestrationPacing(current, nowIso(now()))
          })
          if (cleared && record) options.changed?.(record)
        })
        return
      }
      const record = await options.records.read(key)
      const pacing = record?.pacing
      if (!pacing || record.lifecycle !== undefined) return
      await serial(key.provider, () => {
        let providerWaiters = deferred.get(key.provider)
        if (!providerWaiters) {
          providerWaiters = new Map()
          deferred.set(key.provider, providerWaiters)
        }
        providerWaiters.set(keyId(key), {
          id: keyId(key),
          key,
          orchestratorNodeId,
          recommendation: recommendationFrom(pacing),
          reopened: false,
          wakeAccepted: false
        })
        arm(key.provider)
      })
      requestRecheck(key.provider)
    },

    activityChanged(provider) {
      requestRecheck(provider)
    },

    ready(orchestratorNodeId) {
      for (const providerWaiters of deferred.values()) {
        for (const waiter of providerWaiters.values()) {
          if (waiter.orchestratorNodeId === orchestratorNodeId && waiter.reopened) void track(finishWake(waiter))
        }
      }
    },

    async idle() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight])
    },

    close() {
      closed = true
      for (const cancel of timers.values()) cancel()
      timers.clear()
      deferred.clear()
      pendingAdmissions.clear()
    }
  }
}
