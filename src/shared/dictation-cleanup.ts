/** Workspace-wide opt-in. Claude is the only cleanup provider currently supported. */
export interface DictationCleanupPreference {
  enabled: boolean
  claudeModelId?: 'haiku' | 'sonnet'
}

export const DICTATION_CLEANUP_MODELS = [
  { id: 'haiku', name: 'Haiku', description: 'Fast cleanup — uses your Claude subscription' },
  { id: 'sonnet', name: 'Sonnet', description: 'For difficult dictation; slower — uses your Claude subscription' }
] as const

export const DICTATION_CLEANUP_TIMEOUT_MS = 30_000

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
  /** A CLI model selection is a request, not proof of which model served it. */
  requestedModelId?: 'haiku' | 'sonnet'
  message?: string
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
