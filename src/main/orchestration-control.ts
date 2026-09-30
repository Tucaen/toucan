import type { AgentEvent, AgentPromptResult, AgentRateLimitStatus } from '../shared/agent'
import type { AgentProvider } from '../shared/agent-provider'
import {
  pauseOrchestration,
  resumeOrchestration,
  stopOrchestration,
  type OrchestrationRecord
} from '../shared/orchestration'
import type { OrchestrationKey, OrchestrationStore } from './orchestration-store'

/** A live canvas node's place in one orchestration. */
export interface OrchestrationSession {
  key: OrchestrationKey
  orchestratorNodeId: string
  /** Present only when the node is a ticket session. */
  ticketNodeId?: string
}

export interface OrchestrationControllerOptions {
  records: OrchestrationStore
  resolve(nodeId: string): Promise<OrchestrationSession | null | undefined>
  readUsage(provider: AgentProvider): Promise<AgentRateLimitStatus | null>
  promptWhenIdle(nodeId: string, text: string): Promise<AgentPromptResult>
  kill(nodeId: string): void
  changed?(record: OrchestrationRecord): void
  now?(): number
  schedule?(callback: () => void, ms: number): () => void
  log?(message: string): void
}

export interface OrchestrationController {
  observe(nodeId: string, event: AgentEvent): void
  state(key: OrchestrationKey, orchestratorNodeId: string): Promise<OrchestrationRecord | undefined>
  resumeNow(key: OrchestrationKey, orchestratorNodeId: string): Promise<OrchestrationRecord | undefined>
  stop(key: OrchestrationKey, orchestratorNodeId: string): Promise<OrchestrationRecord | undefined>
  mayWake(orchestratorNodeId: string): Promise<boolean>
  idle(): Promise<void>
}

const keyId = (key: OrchestrationKey): string => `${key.provider}:${key.conversationId}`
const nowIso = (now: number): string => new Date(now).toISOString()

/**
 * The reset that makes every currently saturated window usable again.
 * @internal exported for tests
 */
export function orchestrationResetAt(status: AgentRateLimitStatus | null, now: number): number | undefined {
  if (!status) return undefined
  const windows = [status.fiveHour, status.weekly, ...(status.models ?? [])].filter(
    (window): window is NonNullable<typeof window> => window !== undefined
  )
  const reported = windows.filter((window) => window.resetsAt !== undefined)
  const saturated = reported.filter((window) => window.usedPercent >= 100)
  if (saturated.length > 0) return Math.max(...saturated.map((window) => Math.max(now, window.resetsAt!)))
  const future = windows.flatMap((window) => (window.resetsAt !== undefined && window.resetsAt > now ? [window] : []))
  return future.length > 0 ? Math.min(...future.map((window) => window.resetsAt!)) : undefined
}

function isUsageLimitFailure(event: AgentEvent): boolean {
  return event.type === 'turn_failed' && (event.errorKind === 'rate_limit' || event.errorKind === 'usage_limit')
}

export function createOrchestrationController(options: OrchestrationControllerOptions): OrchestrationController {
  const now = options.now ?? Date.now
  const schedule =
    options.schedule ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms)
      return () => clearTimeout(timer)
    })
  const timers = new Map<string, () => void>()
  const knownOrchestrations = new Map<string, OrchestrationKey>()
  const pendingPrompts = new Map<string, string>()
  const inFlight = new Set<Promise<unknown>>()

  const track = <T>(promise: Promise<T>): Promise<T> => {
    inFlight.add(promise)
    void promise.finally(() => inFlight.delete(promise)).catch(() => undefined)
    return promise
  }

  const deliver = async (nodeId: string, text: string): Promise<void> => {
    try {
      const result = await options.promptWhenIdle(nodeId, text)
      if (result.undelivered) pendingPrompts.set(nodeId, text)
      else pendingPrompts.delete(nodeId)
      if (!result.ok && !result.undelivered)
        options.log?.(`orchestration resume prompt failed: ${result.message ?? 'unknown'}`)
    } catch (error) {
      pendingPrompts.set(nodeId, text)
      options.log?.(`orchestration resume prompt could not be delivered: ${String(error)}`)
    }
  }

  const arm = (key: OrchestrationKey, record: OrchestrationRecord, orchestratorNodeId: string): void => {
    const id = keyId(key)
    knownOrchestrations.set(orchestratorNodeId, key)
    timers.get(id)?.()
    timers.delete(id)
    if (record.lifecycle?.status !== 'paused' || record.lifecycle.resetsAt === undefined) return
    const cancel = schedule(
      () => {
        timers.delete(id)
        void track(resume(key, orchestratorNodeId))
      },
      Math.max(0, record.lifecycle.resetsAt - now())
    )
    timers.set(id, cancel)
  }

  const resume = async (
    key: OrchestrationKey,
    orchestratorNodeId: string
  ): Promise<OrchestrationRecord | undefined> => {
    const result = await options.records.update(key, (current) => {
      if (!current || current.lifecycle?.status !== 'paused') {
        return { value: current, result: { record: current, affected: [] as string[], resumed: false } }
      }
      const affected = current.lifecycle.affectedNodeIds
      const record = resumeOrchestration(current, nowIso(now()))
      return { value: record, result: { record, affected, resumed: true } }
    })
    if (!result.record || !result.resumed) return result.record
    timers.get(keyId(key))?.()
    timers.delete(keyId(key))
    options.changed?.(result.record)
    await Promise.all([
      ...result.affected.map((nodeId) => deliver(nodeId, 'Usage limit reset. Continue the interrupted ticket work.')),
      deliver(orchestratorNodeId, 'Usage limit reset. Review ticket status and continue the orchestration.')
    ])
    return result.record
  }

  const pause = async (nodeId: string): Promise<void> => {
    const session = await options.resolve(nodeId)
    if (!session) return
    knownOrchestrations.set(session.orchestratorNodeId, session.key)
    const paused = await options.records.update(session.key, (current) => {
      if (!current) return { value: current, result: current }
      const next = pauseOrchestration(current, session.ticketNodeId, undefined, nowIso(now()))
      return { value: next, result: next }
    })
    if (!paused || paused.lifecycle?.status !== 'paused') return
    options.changed?.(paused)

    const reset = orchestrationResetAt(await options.readUsage(session.key.provider), now())
    if (reset === undefined) {
      arm(session.key, paused, session.orchestratorNodeId)
      return
    }
    const record = await options.records.update(session.key, (current) => {
      if (!current || current.lifecycle?.status !== 'paused') return { value: current, result: current }
      const next = pauseOrchestration(current, session.ticketNodeId, reset, nowIso(now()))
      return { value: next, result: next }
    })
    if (!record || record.lifecycle?.status !== 'paused') return
    options.changed?.(record)
    arm(session.key, record, session.orchestratorNodeId)
  }

  return {
    observe(nodeId, event) {
      if (isUsageLimitFailure(event)) void track(pause(nodeId))
      if (event.type === 'status' && event.status === 'ready') {
        const text = pendingPrompts.get(nodeId)
        if (text) void track(deliver(nodeId, text))
      }
    },

    async state(key, orchestratorNodeId) {
      const record = await options.records.read(key)
      if (record) arm(key, record, orchestratorNodeId)
      return record
    },

    resumeNow(key, orchestratorNodeId) {
      return track(resume(key, orchestratorNodeId))
    },

    async stop(key, orchestratorNodeId) {
      knownOrchestrations.set(orchestratorNodeId, key)
      const record = await options.records.update(key, (current) => {
        const next = current ? stopOrchestration(current, nowIso(now())) : undefined
        return { value: next, result: next }
      })
      if (!record) return undefined
      timers.get(keyId(key))?.()
      timers.delete(keyId(key))
      pendingPrompts.delete(orchestratorNodeId)
      for (const ticket of record.tickets) {
        if (!ticket.session?.nodeId) continue
        pendingPrompts.delete(ticket.session.nodeId)
        options.kill(ticket.session.nodeId)
      }
      options.changed?.(record)
      return record
    },

    async mayWake(orchestratorNodeId) {
      const known = knownOrchestrations.get(orchestratorNodeId)
      const session = known ? undefined : await options.resolve(orchestratorNodeId)
      const key = known ?? session?.key
      if (!key) return true
      knownOrchestrations.set(orchestratorNodeId, key)
      const record = await options.records.read(key)
      return record?.lifecycle === undefined
    },

    async idle() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight])
    }
  }
}
