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
  /** Chats in this project that are parked on a request, which is a stronger claim than unread. */
  approvals: number
}

/**
 * Whether this chat is stalled waiting to be answered. Read off the attention model rather than
 * off the status: a parked turn still reports itself as working, and `dominantUnreadKind` already
 * ranks a pending approval above every other unread condition on the node - so a chat that badges
 * this way is one that a tap can actually unblock.
 */
export function chatNeedsApproval(chat: RemoteChatSummary): boolean {
  return chat.attention === 'approval'
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
      return {
        project,
        chats,
        unread: chats.reduce((total, chat) => total + chat.unread, 0),
        approvals: chats.filter(chatNeedsApproval).length
      }
    })
    .filter((group) => group.chats.length > 0)
}

/** Sessions doing something, for the header summary. Mirrors the desktop's own status chips. */
export function countActiveChats(snapshot: RemoteWorkspaceSnapshot): {
  working: number
  unread: number
  approvals: number
} {
  return {
    working: snapshot.chats.filter((chat) => chat.status === 'working' || chat.status === 'starting').length,
    unread: snapshot.chats.reduce((total, chat) => total + chat.unread, 0),
    approvals: snapshot.chats.filter(chatNeedsApproval).length
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
 * Whether the host has ever been handed a projection. Until it has, an empty list means "the
 * desktop has not said anything yet", which is a different thing from "nothing is running" - and
 * telling the two apart is the difference between a trustworthy remote list and a misleading one.
 *
 * The age of the projection is deliberately *not* shown. `updatedAt` marks when the canvas last
 * changed, not when the phone last heard from the host, so an idle workspace would drift into
 * looking stale while the poll was in fact succeeding every few seconds. A poll that actually
 * fails surfaces its own error instead.
 */
export function isAwaitingDesktop(snapshot: RemoteWorkspaceSnapshot): boolean {
  return snapshot.updatedAt === 0
}
