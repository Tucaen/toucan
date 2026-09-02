import { vi } from 'vitest'
import type { AgentApi } from '../../src/preload/index.d'
import type { AgentEvent } from '../../src/shared/agent'

export interface MockAgentApi {
  api: AgentApi
  emit(id: string, event: AgentEvent): void
}

/**
 * Stands in for the preload-exposed `window.agentApi` bridge so `useAgentConversation` can be
 * driven from a jsdom test without an Electron main process. `overrides` replaces individual
 * methods (e.g. to make `prompt` reject) while keeping the rest of the default happy-path mock.
 */
export function createMockAgentApi(overrides: Partial<AgentApi> = {}): MockAgentApi {
  const listeners = new Map<string, (event: AgentEvent) => void>()

  const api: AgentApi = {
    create: vi.fn(async () => ({ ok: true, status: 'ready' as const })),
    prompt: vi.fn(async () => ({ ok: true })),
    promptWhenIdle: vi.fn(async () => ({ ok: true })),
    setMode: vi.fn(async () => ({ ok: true })),
    setModel: vi.fn(async () => ({ ok: true })),
    setEffort: vi.fn(async () => ({ ok: true })),
    authenticate: vi.fn(async () => ({ ok: true, status: 'ready' as const })),
    submitAuthCode: vi.fn(async () => ({ ok: true })),
    openAuthLink: vi.fn(async () => undefined),
    resolveApproval: vi.fn(),
    resolveElicitation: vi.fn(),
    cancel: vi.fn(),
    kill: vi.fn(),
    onEvent: vi.fn((id: string, callback: (event: AgentEvent) => void) => {
      listeners.set(id, callback)
      return () => listeners.delete(id)
    }),
    ...overrides
  }

  return {
    api,
    emit: (id, event) => listeners.get(id)?.(event)
  }
}
