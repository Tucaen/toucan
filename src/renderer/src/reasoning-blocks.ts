/**
 * Reasoning arrives as a stream of independent thought messages, but a reader experiences one
 * deliberation. This module is the only place that decides where one deliberation ends: it folds
 * runs of adjacent thought chunks in *transcript order* into a single block, so a tool call or a
 * piece of assistant prose between two thoughts genuinely separates them.
 *
 * Size is reported as a deterministic estimate from the merged text rather than as elapsed time.
 * Session replay re-delivers a whole conversation's thoughts in one burst, so wall-clock duration
 * would read as milliseconds for a deliberation that really took minutes; a text-derived estimate
 * reads the same live and replayed.
 */

export interface ReasoningChunk {
  id: string
  text: string
}

export interface ReasoningBlock {
  /**
   * The first chunk's id. A block keeps this identity as later chunks merge into it, which is what
   * lets the rendered card hold its React key - and therefore its expansion - while it grows.
   */
  id: string
  /** Every merged chunk, in arrival order. */
  chunkIds: string[]
  text: string
  /** Rough token count of `text`; see the module note on why this is not a duration. */
  estimatedTokens: number
  /** True only for the newest block of a turn still in progress. */
  streaming: boolean
}

export type ReasoningMergeEntry<E> = { kind: 'reasoning'; block: ReasoningBlock } | { kind: 'other'; entry: E }

/** Chars-per-token approximation; only ever shown prefixed with `~`. */
const CHARS_PER_TOKEN = 4

export function estimateReasoningTokens(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return Math.max(1, Math.round(trimmed.length / CHARS_PER_TOKEN))
}

/** Collapsed-summary size label, or `''` when there is nothing worth quantifying. */
export function formatReasoningSize(tokens: number): string {
  if (tokens <= 0) return ''
  if (tokens < 1000) return `~${tokens} ${tokens === 1 ? 'token' : 'tokens'}`
  const thousands = tokens / 1000
  // A trailing `.0` reads as spurious precision on an estimate, so `1000` is `~1k`, not `~1.0k`.
  const scaled = thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, '') : String(Math.round(thousands))
  return `~${scaled}k tokens`
}

/**
 * The newest line of reasoning, used as the collapsed block's live preview. Leading markdown
 * markers are stripped because a heading or bullet marker reads as noise on a single line.
 */
export function reasoningTailLine(text: string): string {
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (line) return line.replace(/^(?:#{1,6}\s+|[-*+]\s+|>\s+|\d+\.\s+)/, '').trim()
  }
  return ''
}

/**
 * Rewrites `entries` with every run of adjacent reasoning chunks replaced by one block.
 *
 * `chunkOf` decides which entries are reasoning, so the caller keeps its own transcript entry
 * shape. `working` is the session's live state: without it, a finished block would keep showing a
 * progress indicator forever.
 */
export function mergeReasoningEntries<E>(
  entries: readonly E[],
  chunkOf: (entry: E) => ReasoningChunk | null,
  options: { working?: boolean } = {}
): ReasoningMergeEntry<E>[] {
  const merged: ReasoningMergeEntry<E>[] = []
  let open: { id: string; chunkIds: string[]; texts: string[] } | null = null

  const close = (): void => {
    if (!open) return
    const text = open.texts.join('\n\n')
    merged.push({
      kind: 'reasoning',
      block: {
        id: open.id,
        chunkIds: open.chunkIds,
        text,
        estimatedTokens: estimateReasoningTokens(text),
        streaming: false
      }
    })
    open = null
  }

  for (const entry of entries) {
    const chunk = chunkOf(entry)
    if (!chunk) {
      close()
      merged.push({ kind: 'other', entry })
      continue
    }
    // An empty thought chunk carries nothing to read; folding it in would either widen a block's
    // identity for no reason or, on its own, render a card with an empty body.
    const text = chunk.text.trim()
    if (!text) continue
    if (open) {
      open.chunkIds.push(chunk.id)
      open.texts.push(text)
    } else {
      open = { id: chunk.id, chunkIds: [chunk.id], texts: [text] }
    }
  }
  close()

  const last = merged.at(-1)
  if (options.working && last?.kind === 'reasoning') {
    merged[merged.length - 1] = { kind: 'reasoning', block: { ...last.block, streaming: true } }
  }
  return merged
}
