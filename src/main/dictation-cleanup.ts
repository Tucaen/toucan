import type { DictationCleanupPreference, DictationCleanupResult } from '../shared/dictation-cleanup'
import { errorMessage } from '../shared/text'
import { DICTATION_CLEANUP_TIMEOUT_MS, isDictationCleanupPreference } from '../shared/dictation-cleanup'
import { withStallGuard } from '../shared/stall-guard'
import { runClaudeCleanup } from './claude-dictation-cleanup'

/**
 * The preamble a refusing or chatty response opens with. It is only evidence of a preamble when
 * the dictation did not open the same way itself (#221): "Here's what I want you to change..." is
 * an ordinary thing to say out loud, and rejecting its polished form told the speaker nothing.
 */
const PREAMBLE = /^(?:here(?: is|’s|'s)|sure[,!]|corrected transcript:)/i

function modelName(id: string, usage: unknown): string {
  const canonical = (usage as { canonicalModel?: unknown } | undefined)?.canonicalModel
  return typeof canonical === 'string' && canonical ? canonical : id
}

function outputTokens(usage: unknown): number {
  const tokens = (usage as { outputTokens?: unknown } | undefined)?.outputTokens
  return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : 0
}

/**
 * `modelUsage` is keyed by the model ids the turn was billed to, so it names what actually ran
 * rather than what `--model` asked for - but a single `-p` turn bills more than one model, so key
 * order is not an answer (#221). The transcript came from whichever entry emitted the tokens; when
 * that is tied or unreported, the requested family breaks the tie, and when even that leaves two
 * candidates the model goes unreported so the UI can say "requested" instead of guessing.
 */
function servedModel(modelUsage: unknown, requestedModelId: 'haiku' | 'sonnet'): string | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined
  const entries = Object.entries(modelUsage as Record<string, unknown>).filter(([id]) => id)
  if (entries.length === 0) return undefined
  const most = Math.max(...entries.map(([, usage]) => outputTokens(usage)))
  const busiest = entries.filter(([, usage]) => outputTokens(usage) === most)
  if (busiest.length === 1) return modelName(...busiest[0])
  // Matched against the reported name, not the raw key: a turn billed to an alias names its family
  // only in `canonicalModel`, which is also the name the label would show.
  const requested = busiest.filter(([id, usage]) => modelName(id, usage).toLowerCase().includes(requestedModelId))
  return requested.length === 1 ? modelName(...requested[0]) : undefined
}

/** The CLI envelope must represent a successful, nonempty, transcript-only response. */
function correctedTranscript(
  stdout: string,
  raw: string,
  requestedModelId: 'haiku' | 'sonnet'
): { text: string; servedModel?: string } {
  let output: { type?: unknown; subtype?: unknown; is_error?: unknown; result?: unknown; modelUsage?: unknown }
  try {
    output = JSON.parse(stdout) as typeof output
  } catch {
    throw new Error('Claude returned an unreadable cleanup response.')
  }
  if (
    !output ||
    output.type !== 'result' ||
    output.subtype !== 'success' ||
    output.is_error !== false ||
    typeof output.result !== 'string'
  ) {
    throw new Error('Claude did not return a successful cleanup response. Check your Claude sign-in and allowance.')
  }
  const text = output.result.trim()
  if (
    !text ||
    text.length > Math.max(raw.length * 3, raw.length + 200) ||
    text.startsWith('```') ||
    (PREAMBLE.test(text) && !PREAMBLE.test(raw.trim()))
  ) {
    throw new Error('Claude returned an empty or unexpected transcript.')
  }
  return { text, servedModel: servedModel(output.modelUsage, requestedModelId) }
}

interface CleanupOptions {
  run?(input: string, model: 'haiku' | 'sonnet', signal: AbortSignal): Promise<string>
  timeoutMs?: number
}

export function createDictationCleaner(options: CleanupOptions = {}): {
  clean(
    text: string,
    context: string,
    preference?: DictationCleanupPreference,
    signal?: AbortSignal
  ): Promise<DictationCleanupResult>
} {
  return {
    async clean(text, context, preference, signal) {
      if (!preference?.enabled || !text.trim()) return { status: 'off', text }
      if (!isDictationCleanupPreference(preference))
        return { status: 'fallback', text, message: 'Invalid cleanup preference.' }
      const requestedModelId = preference.claudeModelId ?? 'haiku'
      const controller = new AbortController()
      const cancel = (): void => controller.abort()
      signal?.addEventListener('abort', cancel, { once: true })
      let onAbort = (): void => {}
      try {
        if (signal?.aborted) throw new Error('Cleanup cancelled.')
        const cancelled = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error('Cleanup cancelled.'))
          controller.signal.addEventListener('abort', onAbort, { once: true })
        })
        const output = await withStallGuard(
          Promise.race([
            (options.run ?? runClaudeCleanup)(
              JSON.stringify({ transcript: text, context: context.slice(-1_000) }),
              requestedModelId,
              controller.signal
            ),
            cancelled
          ]),
          options.timeoutMs ?? DICTATION_CLEANUP_TIMEOUT_MS,
          'Cleanup timed out.'
        )
        return { status: 'cleaned', ...correctedTranscript(output, text, requestedModelId), requestedModelId }
      } catch (cause) {
        return { status: 'fallback', text, requestedModelId, message: errorMessage(cause) }
      } finally {
        signal?.removeEventListener('abort', cancel)
        controller.signal.removeEventListener('abort', onAbort)
        controller.abort()
      }
    }
  }
}
