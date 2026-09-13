import { isAbsolute, relative } from 'node:path'
import type { AgentEvent } from '../shared/agent'
import type { AgentTranscriptState } from '../shared/agent-transcript'
import type { ConversationProvider } from '../shared/conversation'
import {
  answeredLatestAsk,
  endedSessionOutcome,
  extractSessionOutcome,
  sessionOutcomeFiles,
  sessionOutcomeKey,
  type SessionOutcomeEnding,
  type SessionOutcomeRecord,
  type SessionOutcomeSource
} from '../shared/session-outcome'
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
  /**
   * Files one tool call reported writing, absolute. Called from the same site that classifies a
   * tool call as file-writing, so reads and searches never reach here - and called *there* rather
   * than read off the session's `recentWrites` ring at the turn boundary, because that ring is
   * bounded at 100 entries for a different job (attributing a file to a session) and silently
   * drops the early writes of a long session.
   */
  recordWrites(paths: readonly string[]): void
  /**
   * The session is over: settle its record's status. Called for the two ways that happens - the
   * broker channel being retired (`stop`) and the adapter exiting on its own, which retires no
   * channel - and safe to call for both, since the second finalize of one session rewrites the
   * same record.
   */
  finalize(): void
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

/**
 * One turn boundary as the index saw it, with everything a capture needs read *at* the boundary.
 * Kept as a unit because finalizing runs from the broker's `closed` hook, which fires after the
 * channel has dropped its snapshot and after the session manager has forgotten the session: by
 * then neither the context nor the transcript can be looked up again.
 */
interface CapturedBoundary {
  context: SessionOutcomeContext
  snapshot: AgentTranscriptState
  ending: SessionOutcomeEnding
  /** Whether the latest ask got an answer, decided here because the snapshot is gone by finalize time. */
  answered: boolean
}

function turnBoundary(event: AgentEvent): SessionOutcomeEnding | null {
  if (event.type === 'turn_complete') return 'complete'
  if (event.type === 'turn_failed') return 'failed'
  if (event.type === 'turn_cancelled') return 'cancelled'
  return null
}

/**
 * A path as the reader will want to grep it: relative to the project the session runs in, with
 * forward slashes, so a record names `src/main/index.ts` the way the repo and every other document
 * does. Anything outside the project stays absolute - a temp file or a sibling checkout is only
 * identifiable in full.
 */
function displayPath(path: string, projectPath: string | undefined): string {
  if (!projectPath) return path
  const within = relative(projectPath, path)
  if (!within || within.startsWith('..') || isAbsolute(within)) return path
  return within.replace(/\\/g, '/')
}

export function createSessionOutcomeIndexer(options: SessionOutcomeIndexerOptions): SessionOutcomeIndexer {
  const now = options.now ?? ((): Date => new Date())

  const capture = async (
    sessionId: string,
    boundary: CapturedBoundary,
    filesTouched: readonly string[]
  ): Promise<void> => {
    const { context, snapshot } = boundary
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
      ...(title ? { title } : {}),
      ...(filesTouched.length ? { filesTouched } : {})
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
      /** Every file this session wrote since the process started watching, bounded by the one rule a record is. */
      let written: string[] = []
      /** The last boundary this watch saw, which is the only thing left to finalize from once the channel closes. */
      let last: CapturedBoundary | null = null

      const queue = (boundary: CapturedBoundary): void => {
        const files = written
        pending = pending.then(() =>
          capture(sessionId, boundary, files).catch((error: unknown) => {
            options.log?.(`session outcome capture failed: ${error instanceof Error ? error.message : String(error)}`)
          })
        )
      }

      /**
       * Settling the status, twice on purpose. The synchronous pass is the only one that survives
       * `before-quit`, where every session is killed and the process is gone before a promise can
       * settle; the queued pass is the only one ordered *after* a capture still on disk, which
       * would otherwise write `active` back over the status the synchronous pass just wrote. A
       * session that never reached a turn boundary has no record, and nothing to say about it.
       */
      const finalize = (): void => {
        const captured = last
        if (!captured || !captured.context.conversationId) return
        const key = sessionOutcomeKey(captured.context.provider, captured.context.conversationId)
        const settle = (record: SessionOutcomeRecord): SessionOutcomeRecord =>
          endedSessionOutcome(record, captured.ending, captured.answered, now().toISOString())
        try {
          const onDisk = options.store.readSync(key)
          if (onDisk) options.store.writeSync(settle(onDisk))
        } catch (error: unknown) {
          options.log?.(`session outcome finalize failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        pending = pending.then(async () => {
          try {
            const onDisk = await options.store.read(key)
            if (onDisk) await options.store.write(settle(onDisk))
          } catch (error: unknown) {
            options.log?.(`session outcome finalize failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        })
      }

      options.broker.subscribe(
        sessionId,
        (event) => {
          const ending = turnBoundary(event)
          if (!ending) return
          const resolved = context()
          const snapshot = options.broker.snapshot(sessionId)
          if (!resolved || !snapshot) return
          last = { context: resolved, snapshot, ending, answered: answeredLatestAsk(snapshot) }
          queue(last)
        },
        // Retiring the channel is one of the two ways a session ends; the adapter exiting on its
        // own is the other, and it reaches `finalize` through the session manager instead.
        { closed: finalize }
      )

      return {
        idle: () => pending,
        finalize,
        recordWrites(paths) {
          const projectPath = context()?.projectPath
          // Re-bounded on every report rather than at the boundary, so the set a long session
          // carries is the same size as the one a record holds - and deduping, ordering and
          // capping stay the shared rule's business rather than a second copy of it here.
          written = sessionOutcomeFiles([...written, ...paths.map((path) => displayPath(path, projectPath))])
        }
      }
    }
  }
}
