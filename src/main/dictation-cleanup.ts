import type { DictationCleanupPreference, DictationCleanupResult } from '../shared/dictation-cleanup'
import { errorMessage } from '../shared/text'
import { DICTATION_CLEANUP_TIMEOUT_MS, isDictationCleanupPreference } from '../shared/dictation-cleanup'
import { withStallGuard } from '../shared/stall-guard'
import { runClaudeCleanup } from './claude-dictation-cleanup'

/**
 * `modelUsage` is keyed by the model ids the turn was billed to, so it names what actually ran
 * rather than what `--model` asked for. A response without it leaves the model unreported.
 */
function servedModel(modelUsage: unknown): string | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined
  const [id, usage] = Object.entries(modelUsage as Record<string, unknown>)[0] ?? []
  if (typeof id !== 'string' || !id) return undefined
  const canonical = (usage as { canonicalModel?: unknown } | undefined)?.canonicalModel
  return typeof canonical === 'string' && canonical ? canonical : id
}

/** The CLI envelope must represent a successful, nonempty, transcript-only response. */
function correctedTranscript(stdout: string, raw: string): { text: string; servedModel?: string } {
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
    /^```|^(?:here(?: is|’s|'s)|sure[,!]|corrected transcript:)/i.test(text)
  ) {
    throw new Error('Claude returned an empty or unexpected transcript.')
  }
  return { text, servedModel: servedModel(output.modelUsage) }
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
        return { status: 'cleaned', ...correctedTranscript(output, text), requestedModelId }
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
