import type { AgentEvent, AgentPromptResult } from '../shared/agent'
import { orchestratorWakePrompt, ticketWakeKind, type TicketWakeEvent } from '../shared/orchestration'
import { errorMessage } from '../shared/text'

/**
 * Wakes an orchestrator when its ticket sessions finish, fail or ask something (#35; plan in
 * `docs/plans/orchestrator-mode.md`, "Waking the orchestrator"). The orchestrator ends its turn
 * after spawning instead of waiting inside a tool call, and Toucan sends it a follow-up prompt, so
 * Toucan owns the turn and the node shows real working state.
 *
 * It watches every session's events at the broker and keeps only the ones that belong to a ticket
 * session. Events arriving close together are folded into one prompt, and a prompt is only
 * forgotten once the orchestrator accepted it: one it could not take yet - not open, not signed in,
 * stopped with the prompt still queued - is kept, joined by whatever arrives meanwhile, and sent
 * again at the orchestrator's next ready boundary. One it accepted is never re-sent, even when the
 * turn it started then fails: it is in the transcript already, and a failing orchestrator retried
 * on every boundary would loop. Held in memory: after a restart `status` rebuilds the picture.
 */

/** Which orchestrator a ticket session reports to, and as which ticket. */
export interface TicketBinding {
  orchestratorNodeId: string
  ticketId: string
  /** The ticket session's conversation, which its outcome record is keyed by. */
  conversationId?: string
}

export interface OrchestrationWakerOptions {
  /** Hands the prompt to the orchestrator: `promptWhenIdle`, which steers or queues a busy session. */
  deliver(orchestratorNodeId: string, text: string): Promise<AgentPromptResult>
  /**
   * Looks up a session Toucan was not told about in this process - a ticket session resumed after
   * a restart. A binding, `null` for a session that is no ticket session, or `undefined` while that
   * cannot be told yet (a ticket session whose spawn has not returned).
   */
  resolve(nodeId: string): Promise<TicketBinding | null | undefined>
  /** The ticket session's outcome record, read when the prompt is built. */
  outcome(conversationId: string): Promise<{ path: string; files: number } | undefined>
  /** How long events are gathered before they are sent together. */
  foldMs?: number
  /** Injectable for tests; answers a cancel. */
  schedule?(callback: () => void, ms: number): () => void
  log?(message: string): void
}

export interface OrchestrationWaker {
  /** Every session event, from the broker's observer. */
  observe(nodeId: string, event: AgentEvent): void
  /** A ticket session the endpoint just spawned; replays what it raised before `spawn` returned. */
  bind(nodeId: string, binding: TicketBinding): void
  /** Settles once every lookup and delivery started so far has; for tests. */
  idle(): Promise<void>
}

interface WakeItem extends TicketWakeEvent {
  conversationId?: string
}

interface OrchestratorQueue {
  items: WakeItem[]
  cancelTimer?: () => void
  /** A delivery came back undelivered: hold everything until the orchestrator's next ready boundary. */
  owed: boolean
}

/** How long a session that cannot be told apart yet keeps what it raised, and how much of it. */
const UNBOUND_TTL_MS = 5 * 60_000
const UNBOUND_LIMIT = 20

export function createOrchestrationWaker(options: OrchestrationWakerOptions): OrchestrationWaker {
  const foldMs = options.foldMs ?? 2_000
  const schedule =
    options.schedule ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms)
      return () => clearTimeout(timer)
    })
  const bindings = new Map<string, TicketBinding | null>()
  const unbound = new Map<string, { at: number; items: Array<Omit<WakeItem, 'ticketId'>> }>()
  const queues = new Map<string, OrchestratorQueue>()
  /** Per session, so a lookup cannot reorder that session's events. */
  const chains = new Map<string, Promise<void>>()
  const inFlight = new Set<Promise<unknown>>()

  const track = <T>(promise: Promise<T>): Promise<T> => {
    inFlight.add(promise)
    void promise.finally(() => inFlight.delete(promise)).catch(() => undefined)
    return promise
  }

  const queueFor = (orchestratorNodeId: string): OrchestratorQueue => {
    let queue = queues.get(orchestratorNodeId)
    if (!queue) {
      queue = { items: [], owed: false }
      queues.set(orchestratorNodeId, queue)
    }
    return queue
  }

  const arm = (orchestratorNodeId: string, queue: OrchestratorQueue): void => {
    if (queue.owed || queue.cancelTimer || queue.items.length === 0) return
    queue.cancelTimer = schedule(() => {
      queue.cancelTimer = undefined
      void track(flush(orchestratorNodeId, queue))
    }, foldMs)
  }

  const flush = async (orchestratorNodeId: string, queue: OrchestratorQueue): Promise<void> => {
    const items = queue.items.splice(0)
    if (items.length === 0) return
    const events: TicketWakeEvent[] = []
    for (const { conversationId, ...event } of items) {
      const ended = event.kind === 'completed' || event.kind === 'failed' || event.kind === 'cancelled'
      const outcome = ended && conversationId ? await options.outcome(conversationId).catch(() => undefined) : undefined
      events.push(outcome ? { ...event, outcome } : event)
    }
    let result: AgentPromptResult
    try {
      result = await options.deliver(orchestratorNodeId, orchestratorWakePrompt(events))
    } catch (error) {
      result = { ok: false, message: errorMessage(error), undelivered: true }
    }
    if (result.undelivered) {
      queue.items.unshift(...items)
      queue.owed = true
      return
    }
    if (!result.ok) options.log?.(`the orchestrator's woken turn failed: ${result.message ?? 'no reason given'}`)
  }

  const enqueue = (binding: TicketBinding, item: Omit<WakeItem, 'ticketId'>): void => {
    const queue = queueFor(binding.orchestratorNodeId)
    queue.items.push({
      ...item,
      ticketId: binding.ticketId,
      ...(binding.conversationId ? { conversationId: binding.conversationId } : {})
    })
    arm(binding.orchestratorNodeId, queue)
  }

  const holdUnbound = (nodeId: string, item: Omit<WakeItem, 'ticketId'>): void => {
    const now = Date.now()
    for (const [id, held] of unbound) if (now - held.at > UNBOUND_TTL_MS) unbound.delete(id)
    const held = unbound.get(nodeId) ?? { at: now, items: [] }
    if (held.items.length < UNBOUND_LIMIT) held.items.push(item)
    unbound.set(nodeId, held)
  }

  const route = async (nodeId: string, item: Omit<WakeItem, 'ticketId'>): Promise<void> => {
    let binding = bindings.get(nodeId)
    if (binding === undefined) {
      const resolved = await options.resolve(nodeId).catch(() => undefined)
      // `bind` may have answered while the lookup was out; it outranks a lookup.
      binding = bindings.get(nodeId) ?? resolved
      if (binding !== undefined) bindings.set(nodeId, binding)
    }
    if (binding === null) return
    if (binding === undefined) holdUnbound(nodeId, item)
    else enqueue(binding, item)
  }

  return {
    observe(nodeId, event) {
      const queue = queues.get(nodeId)
      if (queue?.owed && (event.type === 'session' || (event.type === 'status' && event.status === 'ready'))) {
        queue.owed = false
        arm(nodeId, queue)
      }
      const kind = ticketWakeKind(event)
      if (!kind) return
      const item: Omit<WakeItem, 'ticketId'> =
        event.type === 'turn_failed' || event.type === 'turn_cancelled' ? { kind, reason: event.message } : { kind }
      const next = (chains.get(nodeId) ?? Promise.resolve()).then(() => route(nodeId, item))
      chains.set(nodeId, next)
      void track(next).finally(() => {
        if (chains.get(nodeId) === next) chains.delete(nodeId)
      })
    },

    bind(nodeId, binding) {
      bindings.set(nodeId, binding)
      const held = unbound.get(nodeId)
      unbound.delete(nodeId)
      for (const item of held?.items ?? []) enqueue(binding, item)
    },

    async idle() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight])
    }
  }
}
