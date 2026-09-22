/** Workspace-wide opt-in. Claude is the only cleanup provider currently supported. */
export interface DictationCleanupPreference {
  enabled: boolean
  claudeModelId?: 'haiku' | 'sonnet'
}

export const DICTATION_CLEANUP_MODELS = [
  { id: 'haiku', name: 'Haiku', description: 'Fast cleanup — uses your Claude subscription' },
  { id: 'sonnet', name: 'Sonnet', description: 'For difficult dictation; slower — uses your Claude subscription' }
] as const

/**
 * Polishing has to beat typing the sentence by hand or it is not worth waiting for. A thinking-free
 * Haiku turn measures ~2.2s end to end, ~1.3s of which is the CLI spawn, so this is about four
 * times the median: long enough to absorb a slow turn, short enough that a hung one hands the raw
 * dictation back while it is still the sentence the speaker has in mind.
 */
export const DICTATION_CLEANUP_TIMEOUT_MS = 10_000

export function isDictationCleanupPreference(value: unknown): value is DictationCleanupPreference {
  if (!value || typeof value !== 'object') return false
  const preference = value as Partial<DictationCleanupPreference>
  return (
    typeof preference.enabled === 'boolean' &&
    (preference.claudeModelId === undefined ||
      DICTATION_CLEANUP_MODELS.some((model) => model.id === preference.claudeModelId))
  )
}

export interface DictationCleanupResult {
  status: 'off' | 'cleaned' | 'fallback'
  text: string
  /** A CLI model selection is a request; `servedModel` is what the response says actually ran. */
  requestedModelId?: 'haiku' | 'sonnet'
  /** The model id the CLI billed the turn to, absent if the response did not report one. */
  servedModel?: string
  message?: string
}

/**
 * A served model id reads as a version, not a build stamp: `claude-haiku-4-5-20251001` is "Haiku
 * 4.5". An id that does not parse is shown verbatim rather than guessed at - the point of naming the
 * model is that it is the one that ran.
 */
export function claudeModelLabel(id: string): string {
  const parsed = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-|$)/.exec(id)
  if (!parsed) return id
  const [, name = '', major, minor] = parsed
  const family = name.slice(0, 1).toUpperCase() + name.slice(1)
  return minor ? `${family} ${major}.${minor}` : `${family} ${major}`
}

export interface DictationCleanupRequest {
  id: string
  text: string
  context: string
  preference: DictationCleanupPreference
}

export interface DictationCleanupApi {
  clean(request: DictationCleanupRequest): Promise<DictationCleanupResult>
  cancel(id: string): Promise<void>
}
