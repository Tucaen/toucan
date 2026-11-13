import type { AgentProvider } from './agent-provider'
import type { ConversationSummary } from './conversation'

/** Desktop IPC only. Never accepted from, or listed to, the phone. */
export interface HistoryRestoreRequest {
  projectId: string
  entry: ConversationSummary
}

/** Opaque host-issued handles; transcript paths and bodies never enter this list. */
export interface RemoteHistoryEntry {
  key: string
  provider: AgentProvider
  title: string
  updatedAt: string
  messageCount: number
  directoryLabel: string
}

export interface RemoteHistoryPage {
  entries: RemoteHistoryEntry[]
  total: number
  hasMore: boolean
  nextOffset: number
}

export interface RemoteHistoryOpenRequest {
  projectId: string
  key: string
}

export function isRemoteHistoryIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
}

export function parseRemoteHistoryOpen(body: string): RemoteHistoryOpenRequest | null {
  try {
    const value = JSON.parse(body) as RemoteHistoryOpenRequest
    if (!value || Object.keys(value).some((key) => key !== 'projectId' && key !== 'key')) return null
    return isRemoteHistoryIdentifier(value.projectId) && isRemoteHistoryIdentifier(value.key) ? value : null
  } catch {
    return null
  }
}
