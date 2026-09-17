import type { TerminalLiveness } from '../shared/terminal'
import { normalizeTerminalOutput } from '../shared/terminal-output'
import { boundedUtf8Suffix, TERMINAL_SCROLLBACK_MAX_BYTES } from './terminal-scrollback-store'

/**
 * The output an agent may read through a terminal-context edge, and how far each agent has already
 * read (design in `docs/plans/terminal-context-edge.md`, slice 2).
 *
 * This is deliberately *not* the scrollback store. That store is display-only per AGENTS.md: its
 * file is write-debounced and unfsynced, so an agent reading it mid-build would get the previous
 * build's output and act on it. This keeps its own copy in memory, fed from the same `onData` the
 * renderer is fed from, so what a read returns is what the process has emitted by then.
 *
 * Output is stored raw and stripped only when it is served: the renderer still wants the escape
 * sequences, and the byte offsets a cursor is expressed in have to mean the same thing on every
 * read - which they would not if the stored form depended on how it was once normalized.
 *
 * Nothing here carries operational meaning. Whether the process is alive is the manager's verdict,
 * never something inferred from what the tail happens to contain.
 */

export interface TerminalOutputTailsOptions {
  /** Total retained per terminal; a read's own size override is capped at this (decision 3). */
  maxRetainedBytes?: number
}

/** A read's own bounds. Both optional, so the bare call returns a sensible recent tail. */
export interface TerminalReadOptions {
  /** Capped at what is retained (512 KiB): one tool result must never be the whole buffer. */
  maxBytes?: number
  maxLines?: number
}

export const TERMINAL_READ_DEFAULT_MAX_BYTES = 16 * 1024
export const TERMINAL_READ_DEFAULT_MAX_LINES = 200

export interface TerminalTailRead {
  /** The incarnation this output came from - the read is about one process, never two. */
  incarnationId: string
  /** ANSI-stripped. Empty means "nothing since your last read", which is a real answer. */
  text: string
  /** True when this continues an earlier read of the same incarnation rather than starting over. */
  delta: boolean
  /**
   * Output this read did not return: dropped by the per-read cap, or evicted from retention while
   * the reader's cursor was standing in it. It is a count, not an offer - the cursor advances past
   * it either way, because a reader that kept re-asking for the same skipped middle would never
   * reach the newest output, which is the whole point of the loop this exists for.
   */
  skippedBytes: number
}

/**
 * What one read returns to a caller outside the manager. Adds the two things the tail itself is
 * not allowed to know: which terminal this was, and whether its process is still running.
 */
export interface TerminalOutputRead extends TerminalTailRead {
  terminalSessionId: string
  /** The manager's own verdict on the process, never inferred from what the output contains. */
  liveness: TerminalLiveness
}

export interface TerminalOutputTails {
  /** Starts a fresh tail for a new incarnation; the previous process's output is gone with it. */
  begin(sessionId: string, incarnationId: string): void
  append(sessionId: string, incarnationId: string, data: string): void
  /** Undefined means there is no tail for this terminal at all, which is not the same as empty. */
  read(agentId: string, sessionId: string, options?: TerminalReadOptions): TerminalTailRead | undefined
  /** Drops a retired session's tail and every cursor into it. */
  forget(sessionId: string): void
}

interface Tail {
  incarnationId: string
  /** Raw; the oldest output falls off the front once there is a trim's worth of it to drop. */
  raw: string
  /** `raw`'s size, tracked as it grows so appending never has to measure the whole buffer. */
  rawBytes: number
  /** Bytes this incarnation has emitted in total, so a cursor survives the front falling off. */
  totalBytes: number
}

interface Cursor {
  incarnationId: string
  /** An absolute offset into the incarnation's stream, not into what is currently retained. */
  offset: number
}

/** NUL-separated so no id content can make two different pairs share a key. */
const cursorKey = (agentId: string, sessionId: string): string => `${agentId}\u0000${sessionId}`

/**
 * The last `maxLines` newline-delimited lines, measured on the raw text so byte counts stay exact.
 * A trailing newline terminates the last line rather than starting an empty one - counting it as a
 * line would silently return one line fewer than asked for, and `maxLines: 1` on output ending in
 * a newline would return nothing at all.
 */
function lastLines(text: string, maxLines: number): string {
  const terminated = text.endsWith('\n')
  const lines = (terminated ? text.slice(0, -1) : text).split('\n')
  if (lines.length <= maxLines) return text
  return lines.slice(lines.length - maxLines).join('\n') + (terminated ? '\n' : '')
}

export function createTerminalOutputTails(options: TerminalOutputTailsOptions = {}): TerminalOutputTails {
  const maxRetainedBytes = Math.max(0, options.maxRetainedBytes ?? TERMINAL_SCROLLBACK_MAX_BYTES)
  const tails = new Map<string, Tail>()
  const cursors = new Map<string, Cursor>()

  return {
    begin(sessionId, incarnationId): void {
      tails.set(sessionId, { incarnationId, raw: '', rawBytes: 0, totalBytes: 0 })
    },
    append(sessionId, incarnationId, data): void {
      const tail = tails.get(sessionId)
      // A process that has already been replaced must not write into its successor's tail.
      if (!tail || tail.incarnationId !== incarnationId) return
      const added = Buffer.byteLength(data, 'utf8')
      tail.totalBytes += added
      tail.raw += data
      tail.rawBytes += added
      // This runs on the same hot path that feeds the renderer, and trimming means measuring the
      // whole buffer - so it happens once per retention's worth of output rather than once per
      // chunk. The tail therefore holds between one and two caps, and a read is bounded separately.
      if (tail.rawBytes > maxRetainedBytes * 2) {
        tail.raw = boundedUtf8Suffix(tail.raw, maxRetainedBytes)
        tail.rawBytes = Buffer.byteLength(tail.raw, 'utf8')
      }
    },
    read(agentId, sessionId, readOptions): TerminalTailRead | undefined {
      const tail = tails.get(sessionId)
      if (!tail) return undefined
      const cursor = cursors.get(cursorKey(agentId, sessionId))
      const delta = cursor?.incarnationId === tail.incarnationId
      const retainedFrom = tail.totalBytes - tail.rawBytes
      // A cursor older than what is still retained cannot be honoured; the gap is reported rather
      // than papered over, because the agent would otherwise read a delta with a hole in it.
      const from = delta ? Math.max(cursor.offset, retainedFrom) : retainedFrom
      const lost = delta ? from - cursor.offset : 0

      const unread = boundedUtf8Suffix(tail.raw, Math.max(0, tail.totalBytes - from))
      const maxBytes = Math.min(Math.max(0, readOptions?.maxBytes ?? TERMINAL_READ_DEFAULT_MAX_BYTES), maxRetainedBytes)
      const maxLines = Math.max(1, readOptions?.maxLines ?? TERMINAL_READ_DEFAULT_MAX_LINES)
      const served = boundedUtf8Suffix(lastLines(unread, maxLines), maxBytes)

      cursors.set(cursorKey(agentId, sessionId), { incarnationId: tail.incarnationId, offset: tail.totalBytes })
      return {
        incarnationId: tail.incarnationId,
        text: normalizeTerminalOutput(served),
        delta,
        skippedBytes: lost + (Buffer.byteLength(unread, 'utf8') - Buffer.byteLength(served, 'utf8'))
      }
    },
    forget(sessionId): void {
      tails.delete(sessionId)
      const suffix = `\u0000${sessionId}`
      for (const key of [...cursors.keys()]) if (key.endsWith(suffix)) cursors.delete(key)
    }
  }
}
