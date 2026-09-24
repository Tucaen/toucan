import { relative } from 'node:path'
import { isWithin } from './workspace-containment'
import type { AgentEvent } from '../shared/agent'
import type { AgentTranscriptState } from '../shared/agent-transcript'
import type { ConversationProvider } from '../shared/conversation'
import {
  answeredLatestAsk,
  endedSessionOutcome,
  extractSessionOutcome,
  isTrivialSessionOutcome,
  prunableSessionOutcomes,
  sessionOutcomeKey,
  sessionOutcomeTurns,
  sessionOutcomeWriteSet,
  SESSION_OUTCOME_RECORD_CAP,
  type SessionOutcomeCodeState,
  type SessionOutcomeEnding,
  type SessionOutcomeIndexEntry,
  type SessionOutcomeRecord,
  type SessionOutcomeSource
} from '../shared/session-outcome'
import type { AgentEventBroker } from './agent-event-broker'
import type { SessionOutcomeStore, SessionOutcomeUpdate } from './session-outcome-store'

/**
 * Keeps the session outcome index up to date by watching the agent event fan-out. It sits at the
 * broker rather than in the renderer for two reasons: the broker already holds the per-session
 * transcript snapshot every record is extracted from, and every turn passes through it whatever
 * drove it - the canvas, the phone, or a steered follow-up.
 *
 * The turn boundary is the capture point, not the end of the session: sessions outlive processes
 * (a dormant node gets resumed), so a record written only at close would be lost to every restart.
 *
 * It is also where the index's hygiene lives, because both halves of it need something the store
 * cannot see: which conversations are still being written to (pruning must skip those) and when a
 * conversation is over (only then is "trivial" a settled verdict). The policy itself - the cap and
 * the two rules - is pure and shared; this file is what supplies it the session's knowledge.
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
  /**
   * `HEAD` of the directory a session runs in - its worktree where it has one - read at every
   * capture so the record names the code state its failures were last observed against (#17).
   * `null` outside a git checkout; like the lookups above, a failure costs the commit, never the
   * record.
   */
  codeStateFor?: (projectPath: string) => Promise<SessionOutcomeCodeState | null>
  /** How many records the index keeps before the least recently updated go; injectable so a test can fill it. */
  recordCap?: number
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
  /**
   * How many asks the conversation had reached, read here for the same reason. Finalizing needs it
   * because the record on disk may be a turn behind: a capture still queued when the session is
   * retired has not written the ask that made this conversation worth keeping, and judging
   * triviality off that stale file would delete it.
   */
  turns: number
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
  if (!within || !isWithin(projectPath, path)) return path
  return within.replace(/\\/g, '/')
}

export function createSessionOutcomeIndexer(options: SessionOutcomeIndexerOptions): SessionOutcomeIndexer {
  const now = options.now ?? ((): Date => new Date())
  const cap = options.recordCap ?? SESSION_OUTCOME_RECORD_CAP
  /**
   * The records of conversations this process is still watching, which pruning must leave alone.
   * Membership is the honest reading of "currently active", and a stricter one than the record's
   * own `status`: `active` only says no end was observed, so a dormant node parked since last week
   * reads the same as a session mid-turn. A key joins at the conversation's first turn boundary -
   * before that there is no record to protect - and leaves once its finalize has settled.
   *
   * Counted rather than a set, because a conversation can be held by two watches at once: retiring
   * a node and resuming it are one gesture apart, and the resumed session is already writing while
   * the retired one's finalize is still queued. A plain set would have the first release drop the
   * protection the second session is relying on.
   */
  const live = new Map<string, number>()

  const holdLive = (key: string): void => {
    live.set(key, (live.get(key) ?? 0) + 1)
  }

  const releaseLive = (key: string): void => {
    const held = (live.get(key) ?? 0) - 1
    if (held > 0) live.set(key, held)
    else live.delete(key)
  }

  /**
   * Drops the least recently updated records once the index is over its cap. Run after a record is
   * *created* rather than after every write, because that is the only moment the count can grow;
   * turn after turn on an existing conversation rewrites one file and changes nothing to prune.
   */
  const prune = async (): Promise<void> => {
    const keys = await options.store.keys()
    if (keys.length <= cap) return
    // An unreadable record contributes an empty timestamp, so it sorts oldest and is the first
    // thing dropped: a file the parser cannot make a record of is not one worth keeping over one
    // it can. Reading the whole directory is only reached in the over-cap case, once per new
    // conversation, which is what the cheap key listing above buys.
    const entries: SessionOutcomeIndexEntry[] = await Promise.all(
      keys.map(async (key) => ({ key, updatedAt: (await options.store.read(key))?.updatedAt ?? '' }))
    )
    for (const key of prunableSessionOutcomes(entries, (candidate) => live.has(candidate), cap)) {
      await options.store.delete(key)
    }
  }

  const capture = async (
    sessionId: string,
    boundary: CapturedBoundary,
    filesTouched: readonly string[]
  ): Promise<void> => {
    const { context, snapshot } = boundary
    if (!context.conversationId) return
    let worktreeId: string | undefined
    let title: string | undefined
    let codeState: SessionOutcomeCodeState | null | undefined
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
    try {
      codeState = await options.codeStateFor?.(context.projectPath)
    } catch {
      // And again: a git that will not answer leaves the code state unknown, which the record says
      // by omitting it.
    }
    const source: SessionOutcomeSource = {
      provider: context.provider,
      conversationId: context.conversationId,
      projectPath: context.projectPath,
      ...(worktreeId ? { worktreeId } : {}),
      ...(title ? { title } : {}),
      ...(codeState ? { commit: codeState.commit } : {}),
      ...(codeState?.branch ? { branch: codeState.branch } : {}),
      ...(filesTouched.length ? { filesTouched } : {})
    }
    let created = false
    await options.store.update(sessionOutcomeKey(source.provider, source.conversationId), (previous) => {
      // A record is written whether or not the conversation is trivial so far, and the thin ones
      // are dropped when the session ends instead: it is the record that carries `startedAt` and
      // the write set from turn to turn, so suppressing it would cost a conversation that turns
      // out to matter the very history no transcript can reconstruct.
      const record = extractSessionOutcome(snapshot, source, previous, now().toISOString())
      created = Boolean(record) && !previous
      return record ?? 'keep'
    })
    // Only a record that did not exist can have taken the index over its cap.
    if (created) await prune()
  }

  return {
    watch(sessionId, context) {
      // Captures are serialized per session so two boundaries settling back to back cannot read
      // the same record and write each other's `startedAt` back over it. Both the snapshot and the
      // context are read *here*, at the boundary, and carried into the queued write: a capture
      // still waiting on disk when the session is stopped would otherwise find the channel closed
      // and its snapshot gone - losing the final turn, which is the record most worth keeping.
      let pending: Promise<void> = Promise.resolve()
      /**
       * Every distinct file this session has written since the process started watching, newest
       * last. Deliberately *not* capped here, only deduped: the cap exists to bound what a reader
       * pays for, and applying it twice would throw away the very paths the record's omitted count
       * is derived from - a session's list would then look complete at sixteen however many
       * hundred it wrote. Ordering, clipping and deduping stay the shared rule's business.
       */
      let written: string[] = []
      /** The last boundary this watch saw, which is the only thing left to finalize from once the channel closes. */
      let last: CapturedBoundary | null = null
      /** The key this watch is holding against pruning, held once however many boundaries it sees. */
      let held: string | null = null

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
       *
       * It is also where a trivial conversation is dropped rather than settled. The end of the
       * session is the only point at which "no writes and one ask" is final - a conversation is
       * one ask right up until its second - so this is the one place that can tell a Q&A that left
       * nothing behind from the first turn of real work.
       */
      const finalize = (): void => {
        const captured = last
        if (!captured || !captured.context.conversationId) return
        const key = sessionOutcomeKey(captured.context.provider, captured.context.conversationId)
        // The one verdict both passes reach, so they can only ever differ in the record they were
        // handed - which is the whole reason the queued pass exists.
        const verdict = (onDisk: SessionOutcomeRecord | null): SessionOutcomeUpdate => {
          if (!onDisk) return 'keep'
          // Trivial only if *neither* view of the conversation has anything to show for it. The
          // record carries what earlier processes wrote and this session cannot see; the boundary
          // and the write set carry what this session has seen and the record may not have caught
          // up with - a capture still queued at `before-quit` never will, and dropping a record on
          // the strength of that stale file would erase the conversation it belongs to.
          const seen = { turns: captured.turns, filesTouched: written }
          if (isTrivialSessionOutcome(onDisk) && isTrivialSessionOutcome(seen)) return 'delete'
          return endedSessionOutcome(onDisk, captured.ending, captured.answered, now().toISOString())
        }
        try {
          const settled = verdict(options.store.readSync(key))
          if (settled === 'delete') options.store.deleteSync(key)
          else if (settled !== 'keep') options.store.writeSync(settled)
        } catch (error: unknown) {
          options.log?.(`session outcome finalize failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        pending = pending.then(async () => {
          try {
            // Re-read rather than trusting the synchronous pass's verdict: a capture queued behind
            // it may have landed the turn that made this conversation worth a record, and the
            // deletion above would then have taken a record that is no longer trivial.
            await options.store.update(key, verdict)
          } catch (error: unknown) {
            options.log?.(`session outcome finalize failed: ${error instanceof Error ? error.message : String(error)}`)
          }
          // Released only now, after the last write this session will ever make: a key dropped at
          // the synchronous pass could be pruned out from under the queued one. Finalizing twice -
          // an adapter exiting and its channel then being retired - releases once.
          if (held) {
            releaseLive(held)
            held = null
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
          if (resolved.conversationId && !held) {
            held = sessionOutcomeKey(resolved.provider, resolved.conversationId)
            holdLive(held)
          }
          last = {
            context: resolved,
            snapshot,
            ending,
            answered: answeredLatestAsk(snapshot),
            turns: sessionOutcomeTurns(snapshot)
          }
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
          // Re-deduped on every report rather than at the boundary, so ordering, clipping and
          // deduping stay the shared rule's business rather than a second copy of it here. The cap
          // is deliberately not among them - see `written`.
          written = sessionOutcomeWriteSet([...written, ...paths.map((path) => displayPath(path, projectPath))])
        }
      }
    }
  }
}
