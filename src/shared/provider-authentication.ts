import type { AgentAuthMethod, AgentProvider } from './agent'

/** Extracts a helper's candidate link; providerAuthorizationUrl decides whether to offer it. */
export function extractLoginUrl(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s<>"')]+/)?.[0]
}

/** Runtime-only sign-in state. Never add this to workspace summaries or persisted transcripts. */
export interface ProviderAuthenticationState {
  required: boolean
  methods: { id: string; name: string; mode: 'code' | 'device' }[]
  attempt?: {
    id: string
    methodId: string
    status: 'starting' | 'waiting' | 'verifying' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled'
    url?: string
    userCode?: string
    message?: string
    codeSubmitted?: boolean
  }
}

/** Only flows verified against the pinned adapters can be offered on a phone. */
export function mobileAuthenticationMethods(
  provider: AgentProvider,
  methods: readonly AgentAuthMethod[]
): ProviderAuthenticationState['methods'] {
  return methods.flatMap<ProviderAuthenticationState['methods'][number]>((method) => {
    if (provider === 'claude' && method.type === 'terminal' && ['claude-ai-login', 'console-login'].includes(method.id))
      return [{ id: method.id, name: method.name, mode: 'code' as const }]
    if (provider === 'codex' && method.type === 'agent' && method.id === 'chat-gpt-device-code')
      return [{ id: method.id, name: method.name, mode: 'device' as const }]
    return []
  })
}

/** An authorization link is data from a helper, never an arbitrary URL the phone tells the PC to fetch. */
export function providerAuthorizationUrl(provider: AgentProvider, raw: string): string | undefined {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined
    const allowed =
      provider === 'claude'
        ? ['claude.ai', 'console.anthropic.com', 'platform.claude.com'].includes(url.hostname) &&
          url.pathname === '/oauth/authorize'
        : url.hostname === 'auth.openai.com' && url.pathname === '/codex/device'
    return allowed ? url.href : undefined
  } catch {
    return undefined
  }
}

export const PROVIDER_AUTH_BODY_LIMIT = 36_864

export function parseProviderAuthenticationState(value: unknown): ProviderAuthenticationState | null {
  if (!value || typeof value !== 'object') return null
  const state = value as ProviderAuthenticationState
  if (typeof state.required !== 'boolean' || !Array.isArray(state.methods)) return null
  if (
    !state.methods.every(
      (method) =>
        method &&
        typeof method.id === 'string' &&
        typeof method.name === 'string' &&
        ['code', 'device'].includes(method.mode)
    )
  )
    return null
  const attempt = state.attempt
  if (
    attempt &&
    (typeof attempt.id !== 'string' ||
      typeof attempt.methodId !== 'string' ||
      !['starting', 'waiting', 'verifying', 'cancelling', 'succeeded', 'failed', 'cancelled'].includes(
        attempt.status
      ) ||
      (attempt.url !== undefined &&
        (typeof attempt.url !== 'string' ||
          !providerAuthorizationUrl(attempt.methodId === 'chat-gpt-device-code' ? 'codex' : 'claude', attempt.url))) ||
      (attempt.userCode !== undefined &&
        (typeof attempt.userCode !== 'string' || !/^[A-Z0-9-]{4,32}$/.test(attempt.userCode))) ||
      (attempt.message !== undefined && typeof attempt.message !== 'string') ||
      (attempt.codeSubmitted !== undefined && typeof attempt.codeSubmitted !== 'boolean'))
  )
    return null
  return state
}

export type ProviderAuthenticationAction =
  | { action: 'start'; methodId: string }
  | { action: 'code'; attemptId: string; code: string }
  | { action: 'cancel'; attemptId: string }

/** Strict, bounded input; callback URLs, API keys, commands and environment variables have no remote operation. */
export function parseProviderAuthenticationAction(raw: string): ProviderAuthenticationAction | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const body = value as Record<string, unknown>
    const id = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,128}$/.test(value)
    if (body.action === 'start' && id(body.methodId) && Object.keys(body).length === 2)
      return { action: 'start', methodId: body.methodId }
    if (body.action === 'cancel' && id(body.attemptId) && Object.keys(body).length === 2)
      return { action: 'cancel', attemptId: body.attemptId }
    if (
      body.action === 'code' &&
      id(body.attemptId) &&
      typeof body.code === 'string' &&
      body.code.trim().length > 0 &&
      body.code.length <= 8192 &&
      !/[\r\n]/.test(body.code) &&
      !body.code.includes(String.fromCharCode(0)) &&
      Object.keys(body).length === 3
    )
      return { action: 'code', attemptId: body.attemptId, code: body.code.trim() }
    return null
  } catch {
    return null
  }
}
