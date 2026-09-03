import type { RemoteChatSummary, RemoteProjectSummary, RemoteWorkspaceSnapshot } from '../../src/shared/remote-access'
import type { AttentionKind } from '../../src/shared/attention'
import type { TerminalNodeStatus } from '../../src/shared/terminal'

/**
 * Everything the chat list decides, without a DOM. The view renders these results; nothing here
 * knows about React, so the grouping, the labels and the staleness rule can be tested directly.
 */

export interface ChatGroup {
  project: RemoteProjectSummary
  chats: RemoteChatSummary[]
  /** Unread across the group, so a collapsed project still shows that something wants attention. */
  unread: number
}

/**
 * Projects in the host's order, each with its own chats. Empty projects are dropped: a phone
 * screen is small, and a project heading with nothing under it is pure noise until spawning a
 * chat remotely exists. A chat whose project the snapshot does not name is dropped for the same
 * reason it would be unusable - there is nowhere to file it.
 */
export function groupChatsByProject(snapshot: RemoteWorkspaceSnapshot): ChatGroup[] {
  return snapshot.projects
    .map((project) => {
      const chats = snapshot.chats.filter((chat) => chat.projectId === project.id)
      return { project, chats, unread: chats.reduce((total, chat) => total + chat.unread, 0) }
    })
    .filter((group) => group.chats.length > 0)
}

/** Sessions doing something, for the header summary. Mirrors the desktop's own status chips. */
export function countActiveChats(snapshot: RemoteWorkspaceSnapshot): { working: number; unread: number } {
  return {
    working: snapshot.chats.filter((chat) => chat.status === 'working' || chat.status === 'starting').length,
    unread: snapshot.chats.reduce((total, chat) => total + chat.unread, 0)
  }
}

const STATUS_LABELS: Record<TerminalNodeStatus, string> = {
  dormant: 'Dormant',
  starting: 'Starting',
  idle: 'Idle',
  working: 'Working',
  result: 'Finished',
  attention: 'Needs you',
  stalled: 'May be stuck',
  exited: 'Exited'
}

export function chatStatusLabel(status: TerminalNodeStatus): string {
  return STATUS_LABELS[status] ?? status
}

const ATTENTION_LABELS: Record<AttentionKind, string> = {
  approval: 'Approval',
  auth: 'Sign-in',
  result: 'Result',
  failure: 'Failed',
  output: 'Output'
}

export function attentionLabel(kind: AttentionKind): string {
  return ATTENTION_LABELS[kind] ?? kind
}

/**
 * How stale the list is. The phone polls, so a snapshot is always a little old and pretending
 * otherwise is what makes a remote list untrustworthy; only a genuinely stale one is called out.
 */
export const STALE_SNAPSHOT_MS = 15_000

export function snapshotAgeLabel(snapshot: RemoteWorkspaceSnapshot, now: number): string | null {
  if (snapshot.updatedAt === 0) return 'Waiting for the desktop'
  const age = now - snapshot.updatedAt
  if (age < STALE_SNAPSHOT_MS) return null
  const minutes = Math.floor(age / 60_000)
  return minutes < 1 ? `Updated ${Math.floor(age / 1000)}s ago` : `Updated ${minutes}m ago`
}
