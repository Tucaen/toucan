import type { RemoteChatSummary, RemoteProjectSummary, RemoteWorkspaceSnapshot } from '../../src/shared/remote-access'
import type { AttentionKind } from '../../src/shared/attention'
import type { TerminalNodeStatus } from '../../src/shared/terminal'

/**
 * Everything the chat list decides, without a DOM. The view renders these results; nothing here
 * knows about React, so the grouping, the labels and the staleness rule can be tested directly.
 */

/** The chats of one ticket worktree, listed under the orchestrator that owns it. */
export interface TicketWorktreeGroup {
  /** The worktree's branch, which is the row the desktop shows between an orchestrator and its sessions. */
  branch: string
  chats: ChatRow[]
  unread: number
}

/**
 * One top-level row of a project: a chat, and when it is an orchestrator, the ticket worktrees it
 * owns. Mirrors the desktop sidebar, where those are nested beneath the orchestrator's row.
 */
export interface ChatRow {
  chat: RemoteChatSummary
  ticketWorktrees: TicketWorktreeGroup[]
}

export interface ChatGroup {
  project: RemoteProjectSummary
  /** Every chat of the project, nested ones included; counts and lookups read this. */
  chats: RemoteChatSummary[]
  /** What the list renders: the chats no orchestrator owns, each carrying its own ticket sessions. */
  rows: ChatRow[]
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
 * screen is small, and a project heading with nothing under it is pure noise - spawning offers
 * every project in its own picker, so the list does not have to double as one. A chat whose
 * project the snapshot does not name is dropped for the same reason it would be unusable - there
 * is nowhere to file it.
 */
export function groupChatsByProject(snapshot: RemoteWorkspaceSnapshot): ChatGroup[] {
  return snapshot.projects
    .map((project) => {
      const chats = snapshot.chats.filter((chat) => chat.projectId === project.id)
      return {
        project,
        chats,
        rows: nestTicketSessions(chats),
        unread: chats.reduce((total, chat) => total + chat.unread, 0),
        approvals: chats.filter(chatNeedsApproval).length
      }
    })
    .filter((group) => group.chats.length > 0)
}

/**
 * Top-level rows with ticket sessions folded under their orchestrator, as the desktop sidebar
 * does, and recursively: an orchestrator that is itself a ticket session carries its own tickets.
 * A chat only nests when the orchestrator it names is in the list, so a stale link leaves it
 * top-level and nothing is ever hidden. Order is the snapshot's (canvas order) throughout;
 * worktrees appear in the order their first chat does.
 */
export function nestTicketSessions(chats: readonly RemoteChatSummary[]): ChatRow[] {
  const ids = new Set(chats.map((chat) => chat.id))
  const ownerOf = (chat: RemoteChatSummary): string | undefined =>
    chat.orchestratorId !== undefined && chat.orchestratorId !== chat.id && ids.has(chat.orchestratorId)
      ? chat.orchestratorId
      : undefined
  const ticketsOf = new Map<string, RemoteChatSummary[]>()
  for (const chat of chats) {
    const owner = ownerOf(chat)
    if (owner !== undefined) ticketsOf.set(owner, [...(ticketsOf.get(owner) ?? []), chat])
  }
  // `path` guards against a link cycle the host should never send; a chat on its own path is cut.
  const build = (chat: RemoteChatSummary, path: ReadonlySet<string>): ChatRow => {
    const inner = new Set(path).add(chat.id)
    const ticketWorktrees: TicketWorktreeGroup[] = []
    for (const ticket of ticketsOf.get(chat.id) ?? []) {
      if (inner.has(ticket.id)) continue
      const branch = ticket.worktree ?? ''
      let group = ticketWorktrees.find((candidate) => candidate.branch === branch)
      if (!group) {
        group = { branch, chats: [], unread: 0 }
        ticketWorktrees.push(group)
      }
      group.chats.push(build(ticket, inner))
      group.unread += ticket.unread
    }
    return { chat, ticketWorktrees }
  }
  return chats.filter((chat) => ownerOf(chat) === undefined).map((chat) => build(chat, new Set()))
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
  background: 'Background',
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
