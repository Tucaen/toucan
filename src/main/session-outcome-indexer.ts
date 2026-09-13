import type { AgentEvent } from '../shared/agent'
import type { AgentTranscriptState } from '../shared/agent-transcript'
import type { ConversationProvider } from '../shared/conversation'
import { extractSessionOutcome, sessionOutcomeKey, type SessionOutcomeSource } from '../shared/session-outcome'
import type { AgentEventBroker } from './agent-event-broker'
import type { SessionOutcomeStore } from './session-outcome-store'

/**
 * Keeps the session outcome index up to date by watching the agent event fan-out. It sits at the
 * broker rather than in the renderer for two reasons: the broker already holds the per-session
 * transcript snapshot every record is extracted from, and every turn passes through it whatever
 * drove it - the canvas, the phone, or a steered follow-up.
 *
 * The turn boundary is the capture point, not the end of the session: sessions outlive processes
 * (a dormant node gets resumed), so a record written only at close would be lost to every restart.
 */

/** What the session manager knows about a watched session; read lazily, since the provider's conversation id arrives after launch. */
export interface SessionOutcomeContext {
  provider: ConversationProvider
  /** `null` until the provider has reported a session id; nothing is recorded before then. */
  conversationId: string | null
  projectPath: string
}

export interface SessionOutcomeWatch {
  /**
   * Resolves once every capture queued so far has settled. A turn boundary is observed
   * synchronously but written asynchronously, so this is the only way to know the index has caught
   * up with the stream - and the only way a test can assert on the file rather than on a delay.
   */
  idle(): Promise<void>
}

export interface SessionOutcomeIndexer {
  /**
   * Watches one session's stream until `broker.close` retires it with the session, exactly as the
   * owning renderer's subscription is retired. Sessions the manager never hands here are simply
   * not indexed, which is what keeps this off the terminal path.
   */
  watch(sessionId: string, context: () => SessionOutcomeContext | null): SessionOutcomeWatch
}

export interface SessionOutcomeIndexerOptions {
  broker: AgentEventBroker
  store: SessionOutcomeStore
  /**
   * The worktree a node is attached to. Injected because that association lives in the persisted
   * workspace snapshot rather than anywhere the session manager can see it, and a lookup that
   * fails must cost the attribute rather than the record.
   */
  worktreeIdForNode?: (nodeId: string) => Promise<string | undefined>
  /**
   * The durable conversation title (`conversation-title-store.ts`), keyed identically. Consulted
   * rather than re-derived so a record cannot contradict the name the user sees - a manual rename
   * outranks generation there, and a generated title is first-write-wins, while re-deriving each
   * turn would let the record's title drift with the latest prompt.
   */
  titleFor?: (provider: ConversationProvider, conversationId: string) => Promise<string | undefined>
  now?: () => Date
  log?: (message: string) => void
}

function isTurnBoundary(event: AgentEvent): boolean {
  return event.type === 'turn_complete' || event.type === 'turn_failed' || event.type === 'turn_cancelled'
}

export function createSessionOutcomeIndexer(options: SessionOutcomeIndexerOptions): SessionOutcomeIndexer {
  const now = options.now ?? ((): Date => new Date())

  const capture = async (
    sessionId: string,
    context: SessionOutcomeContext,
    snapshot: AgentTranscriptState
  ): Promise<void> => {
    if (!context.conversationId) return
    let worktreeId: string | undefined
    let title: string | undefined
    try {
      worktreeId = await options.worktreeIdForNode?.(sessionId)
    } catch {
      // An unreadable workspace snapshot costs the worktree attribute, never the record.
    }
    try {
      title = await options.titleFor?.(context.provider, context.conversationId)
    } catch {
      // Same rule: an unreadable title store falls back to the transcript's own derivation.
    }
    const source: SessionOutcomeSource = {
      provider: context.provider,
      conversationId: context.conversationId,
      projectPath: context.projectPath,
      ...(worktreeId ? { worktreeId } : {}),
      ...(title ? { title } : {})
    }
    const previous = await options.store.read(sessionOutcomeKey(source.provider, source.conversationId))
    const record = extractSessionOutcome(snapshot, source, previous, now().toISOString())
    if (record) await options.store.write(record)
  }

  return {
    watch(sessionId, context) {
      // Captures are serialized per session so two boundaries settling back to back cannot read
      // the same record and write each other's `startedAt` back over it. Both the snapshot and the
      // context are read *here*, at the boundary, and carried into the queued write: a capture
      // still waiting on disk when the session is stopped would otherwise find the channel closed
      // and its snapshot gone - losing the final turn, which is the record most worth keeping.
      let pending: Promise<void> = Promise.resolve()
      options.broker.subscribe(sessionId, (event) => {
        if (!isTurnBoundary(event)) return
        const resolved = context()
        const snapshot = options.broker.snapshot(sessionId)
        if (!resolved || !snapshot) return
        pending = pending.then(() =>
          capture(sessionId, resolved, snapshot).catch((error: unknown) => {
            options.log?.(`session outcome capture failed: ${error instanceof Error ? error.message : String(error)}`)
          })
        )
      })
      return { idle: () => pending }
    }
  }
}
