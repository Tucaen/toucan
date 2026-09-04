import type { AgentActivity } from '../../shared/agent'
import type { AgentTranscriptEntry } from '../../shared/agent-transcript'
import type { TerminalKind } from '../../shared/terminal'
import { TICKET_FILES_SOURCE_ID, ticketCardKey } from '../../shared/ticket-source'
import { isAbsolutePath, isTicketSlug, ticketsDirectoryOrDefault } from '../../shared/tickets'
import { fileOperationFor, shortenFilePath } from './file-operation'

/**
 * Which session is working on which ticket, decided from what the sessions actually did rather
 * than from what a ticket's status claims. A card's chip is evidence: this chat wrote this file.
 * A ticket left in `in-progress` by a session that has since moved on gets nothing extra, because
 * guessing would cost the board the one live signal it has.
 *
 * Pure, and deliberately in two halves. A chat node knows its transcript but not where its
 * project keeps tickets, so it reports the files it wrote (`recentlyWrittenPaths`); the workspace
 * turns those reports into chips (`ticketSessionsFromNodes`). Path matching is separator- and
 * case-insensitive identity under the tickets folder - never raw string equality - because the
 * same checkout reaches an agent under either slash and either drive-letter case.
 */

/** What one chat node reports upward about the files it has been writing. */
export interface TicketActivityReport {
  /** Paths as the tools reported them, from `recentlyWrittenPaths`. */
  paths: readonly string[]
  /** True while the session is mid-turn, which is what makes its chip a *live* one. */
  working: boolean
}

/** The chip a card shows: which node, what to call it, and whether it is still going. */
export interface TicketSessionChip {
  nodeId: string
  label: string
  kind: TerminalKind
  working: boolean
}

/** As much of a canvas chat node as the chips need; the node type itself lives above this. */
export interface TicketSessionNode {
  id: string
  data: {
    label: string
    kind: TerminalKind
    /** A worktree keeps its own copy of the project's tickets folder, and both count. */
    workingDirectory: string
    projectId: string
  }
}

/** Where this session's turn began in the transcript, and whether that turn is still running. */
export interface TicketActivityTurn {
  working: boolean
  /**
   * Index in `transcript` at which the most recent turn started, as the node observed the status
   * change. Optional: a replayed transcript has no observed turn, and the captain's messages are
   * then the only boundaries there are.
   */
  startedAt?: number
}

/**
 * The files this session wrote during the current turn and the last completed one, in the order
 * the transcript first saw them and each path once. Reads are excluded: an agent reading a ticket
 * to decide what to do next is not working on it, and a card that said otherwise would light up
 * for every listing.
 *
 * Two boundaries decide the window, because neither alone is enough. The captain's messages are
 * the only boundaries a *replayed* transcript has, but they over-count: a steer sent mid-turn is
 * another message from the captain, and counting it would slide the window forward and hide what
 * the turn had already written. So the observed turn start wins whenever it reaches further back.
 */
export function recentlyWrittenPaths(
  transcript: readonly AgentTranscriptEntry[],
  activities: readonly AgentActivity[],
  turn: TicketActivityTurn
): string[] {
  const byId = new Map(activities.map((activity) => [activity.id, activity]))
  const prompts = transcript.flatMap((entry, index) =>
    entry.type === 'message' && entry.role === 'user' ? [index] : []
  )
  // Mid-turn the window is the running turn plus the one before it; between turns, the turn that
  // just finished is itself the last completed one, so a single boundary is the whole window.
  const boundary = prompts[prompts.length - (turn.working ? 2 : 1)] ?? 0
  const from = Math.min(boundary, turn.startedAt ?? boundary)
  const paths: string[] = []
  for (const entry of transcript.slice(from)) {
    if (entry.type !== 'activity') continue
    const activity = byId.get(entry.id)
    if (!activity) continue
    const operation = fileOperationFor(activity)
    if (!operation || operation.kind === 'read') continue
    if (!paths.includes(operation.path)) paths.push(operation.path)
  }
  return paths
}

/** Forward slashes, no trailing separator: the shape every comparison here is made in. */
function normalizeDirectory(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Where a checkout keeps its tickets, as a renderer can know it. The rule itself is shared with
 * main's `ticketsDirectoryFor`; the joining is string work rather than `node:path`, which the
 * renderer has no access to.
 */
export function ticketsRootFor(checkout: string, ticketsDirectory?: string): string {
  const relative = normalizeDirectory(ticketsDirectoryOrDefault(ticketsDirectory)).replace(/^\/+/, '')
  return `${normalizeDirectory(checkout)}/${relative}`
}

/** One session's view of where tickets are: the folders that count, and what a path is relative to. */
export interface TicketPathScope {
  /** Every tickets folder this session's writes may land in - the checkout's and its worktree's. */
  roots: readonly string[]
  /** What a path the tools reported relative rather than absolute is relative to. */
  workingDirectory: string
}

/**
 * The ticket a written path names, or `undefined` for every other file. A ticket is a flat
 * `.md` file directly inside one of the scope's roots whose name is a slug, so a file in a
 * subfolder, a plan next door, or a folder whose name merely starts the same way are all not
 * tickets.
 */
export function ticketSlugFor(path: string, scope: TicketPathScope): string | undefined {
  const absolute = isAbsolutePath(path)
    ? path
    : `${normalizeDirectory(scope.workingDirectory)}/${path.replace(/\\/g, '/')}`
  const relative = shortenFilePath(absolute, scope.roots)
  // Under no root, `shortenFilePath` hands back the whole path - which always still has a slash.
  if (relative.includes('/') || !relative.endsWith('.md')) return undefined
  const slug = relative.slice(0, -'.md'.length)
  return isTicketSlug(slug) ? slug : undefined
}

/**
 * The board's chips, keyed by `ticketCardKey` for the files source: a slug only identifies a
 * ticket among files, so a GitHub issue that happens to share the id never inherits a chip.
 *
 * Only the active project's own sessions are considered, because the board is one project's
 * tickets. When several of them touched one ticket, a session still working wins over one that
 * has finished, and otherwise the first keeps the card - nodes arrive in canvas order, so the
 * chip does not swap about between two identical renders.
 */
export function ticketSessionsFromNodes(
  nodes: readonly TicketSessionNode[],
  reports: Readonly<Record<string, TicketActivityReport>>,
  project: { id: string; path: string; ticketsDirectory?: string }
): Map<string, TicketSessionChip> {
  const chips = new Map<string, TicketSessionChip>()
  const projectRoot = ticketsRootFor(project.path, project.ticketsDirectory)
  for (const node of nodes) {
    const report = reports[node.id]
    if (!report?.paths.length || node.data.projectId !== project.id) continue
    const scope: TicketPathScope = {
      roots: [projectRoot, ticketsRootFor(node.data.workingDirectory, project.ticketsDirectory)],
      workingDirectory: node.data.workingDirectory
    }
    for (const path of report.paths) {
      const slug = ticketSlugFor(path, scope)
      if (!slug) continue
      const key = ticketCardKey({ sourceId: TICKET_FILES_SOURCE_ID, id: slug })
      const held = chips.get(key)
      if (held && (held.working || !report.working)) continue
      chips.set(key, {
        nodeId: node.id,
        label: node.data.label,
        kind: node.data.kind,
        working: report.working
      })
    }
  }
  return chips
}
