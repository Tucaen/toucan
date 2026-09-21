import { useEffect, useRef, useState } from 'react'
import { DICTATION_CLEANUP_TIMEOUT_MS, type DictationCleanupResult } from '../../shared/dictation-cleanup'
import { withStallGuard } from '../../shared/stall-guard'
import { errorMessage } from '../../shared/text'
import { useDictationCleanupPreference } from './dictation-cleanup-context'

/** The original text stays in the renderer until cleanup settles, even if IPC stops replying. */
export function useDictationCleanup(): {
  enabled: boolean
  clean(text: string, context: string): Promise<DictationCleanupResult | null>
  cancel(): void
  report: string | null
  clearReport(): void
} {
  const { preference } = useDictationCleanupPreference()
  const [report, setReport] = useState<string | null>(null)
  const pending = useRef<{ cancel(): void } | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      pending.current?.cancel()
    }
  }, [])

  const clean = async (text: string, context: string): Promise<DictationCleanupResult | null> => {
    if (!mounted.current) return null
    if (!preference.enabled) return { status: 'off', text }
    const id = crypto.randomUUID()
    const requestedModelId = preference.claudeModelId ?? 'haiku'
    const fallback = (message: string): DictationCleanupResult => ({
      status: 'fallback',
      text,
      requestedModelId,
      message
    })
    const cancelRemote = (): void => {
      void Promise.resolve()
        .then(() => window.dictationCleanupApi.cancel(id))
        .catch(() => {})
    }
    let cancel!: () => void
    const cancelled = new Promise<DictationCleanupResult>((resolve) => {
      cancel = () => {
        cancelRemote()
        resolve(fallback('Cleanup cancelled.'))
      }
    })
    pending.current = { cancel }
    let result: DictationCleanupResult
    try {
      result = await withStallGuard(
        Promise.race([
          window.dictationCleanupApi.clean({ id, text, context: context.slice(-1_000), preference }),
          cancelled
        ]),
        DICTATION_CLEANUP_TIMEOUT_MS + 1_000,
        'Cleanup timed out.'
      )
    } catch (cause) {
      cancelRemote()
      result = fallback(errorMessage(cause))
    }
    pending.current = null
    if (!mounted.current) return null
    const model = requestedModelId === 'haiku' ? 'Haiku' : 'Sonnet'
    setReport(
      result.status === 'cleaned'
        ? `Polished with Claude (${model} requested, model unverified).`
        : `Original dictation inserted. ${result.message ?? 'Cleanup did not run.'} Claude ${model} requested, model unverified.`
    )
    return result.status === 'cleaned' ? result : { ...result, text }
  }

  return {
    enabled: preference.enabled,
    clean,
    cancel: () => pending.current?.cancel(),
    report,
    clearReport: () => setReport(null)
  }
}
