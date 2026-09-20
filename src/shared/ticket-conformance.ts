import type { AgentFileWrite } from './agent-activity'
import { pathIdentity } from './paths'
import { TICKET_FIELD_SENTENCE } from './ticket-format'
import type { TicketDiagnostic } from './tickets'

/**
 * Toucan's ticket board shows a file in the tickets folder as a diagnostic row the agent who
 * wrote it never sees, rather than as a card. This module decides who to tell.
 *
 * It is deliberately quiet, because reading is lenient: a file missing every field is a card, so
 * what reaches here is only what could not be shown at all - a filename that is not an id, a file
 * that would not open. A session is never corrected over a shape the board is happy to render.
 *
 * Enforcement is deliberately post-hoc and Toucan-side rather than a provider hook: any skill in
 * any provider can write into the tickets folder (including through a shell redirect), so the one
 * place that covers all of them is Toucan noticing the file afterwards. Pure: the watcher, the
 * library and the session manager supply the inputs and `main/ticket-steering.ts` delivers.
 */

/** What one session is about to be told, and about which of its files. */
export interface TicketConformanceSteer {
  agentId: string
  files: TicketDiagnostic[]
  /** The message as the agent reads it; the caller delivers it verbatim. */
  text: string
}

/**
 * How long a write stays evidence of authorship. A watcher tick follows the write that caused it
 * within a debounce, so this is generous by design - what it rules out is a session being blamed
 * for a file it wrote an hour ago and has long since moved on from, which is exactly the hand-edit
 * case that must steer nobody. A session that really is still working on the file rewrites it, and
 * that write is fresh again.
 */
export const RECENT_WRITE_WINDOW_MS = 10 * 60_000

export interface TicketConformanceInput {
  /** This project's malformed ticket files, as the library reported them a moment ago. */
  diagnostics: readonly TicketDiagnostic[]
  /** Recent write locations across every live session, in no particular order. */
  writes: readonly AgentFileWrite[]
  /** `reportedTicketKey` -> the error that session has already been told about for that file. */
  reported: ReadonlyMap<string, string>
  /** Now, on the same clock the writes were stamped with. */
  now: number
}

export interface TicketConformanceDecision {
  steers: TicketConformanceSteer[]
  /**
   * The dedupe state to keep *before* delivery: entries carried over because the file is still
   * broken in the same way the same session was already told about. A steer's own files join it
   * only once the caller has handed them off, so a message that was refused is sent again.
   */
  reported: Map<string, string>
}

/**
 * What a session has been told about which file. Keyed by session and not by file alone, because
 * a second session rewriting a file the first was corrected about is a second agent producing the
 * same broken output, and it has to hear about it too.
 */
export function reportedTicketKey(agentId: string, path: string): string {
  return `${agentId}\n${pathIdentity(path)}`
}

/**
 * What to do about it, in the words an agent has to act on. It carries the whole shape and names
 * no skill, because Toucan ships no tickets skill: a project has one only if it wrote or
 * scaffolded its own, so a message pointing at "the tickets skill" would as often as not send the
 * steered agent looking for a file that is not there.
 * Leads with the filename, because that is the only thing the board insists on and so very
 * nearly the only thing a message that fires at all can be about; the field list behind it is
 * `TICKET_FIELD_SENTENCE` from `shared/ticket-format.ts`, which is also what the board's
 * empty-state primer lays out, so an agent and a human are never told two different shapes -
 * `shared/tickets.ts` decides how a file is read and the skill `shared/ticket-skill.ts` generates
 * teaches the convention at length; all of them move together.
 */
const TICKET_SHAPE =
  'A ticket is a Markdown file named `<lowercase-kebab-case>.md` directly in the tickets folder: ' +
  'the filename is the ticket’s id, so a file the board cannot address is a file it cannot show. ' +
  'Rename it to a slug, or move it out of the tickets folder if it is not a ticket. A ticket ' +
  `should also open with frontmatter that has ${TICKET_FIELD_SENTENCE}, dates as YYYY-MM-DD - ` +
  'though the board renders a file that has none of it, so do not rewrite anyone else’s notes ' +
  'to add them.'

function steerText(files: readonly TicketDiagnostic[]): string {
  const lead =
    files.length === 1
      ? 'A file you just wrote into the tickets folder cannot be shown on Toucan’s ticket board:'
      : 'Files you just wrote into the tickets folder cannot be shown on Toucan’s ticket board:'
  return [lead, ...files.map((file) => `- \`${file.path}\`: ${file.message}`), '', TICKET_SHAPE].join('\n')
}

/** The session that most recently wrote this file, ignoring writes too old to be evidence. */
function lastWriterOf(identity: string, writes: readonly AgentFileWrite[], now: number): string | undefined {
  let latest: AgentFileWrite | undefined
  for (const write of writes) {
    if (now - write.at > RECENT_WRITE_WINDOW_MS) continue
    if (pathIdentity(write.path) !== identity) continue
    if (!latest || write.at > latest.at) latest = write
  }
  return latest?.agentId
}

/**
 * The steers this tick warrants, and the dedupe state to carry forward. Attribution is decided
 * first: a file no session is recorded as having written recently tells nobody at all (a hand
 * edit or an outside process - the board's diagnostic row is the only surface there), and a file
 * several sessions wrote goes to the most recent writer, because that is the one whose next turn
 * can still fix it. Only then does the dedupe apply, so the same breakage is reported once per
 * session that produced it rather than once ever.
 *
 * Diagnostics are grouped per session so an agent that broke three files gets one message rather
 * than three prompts, and the grouping keeps the caller's diagnostic order (the library sorts by
 * path) so two identical ticks produce identical text.
 */
export function ticketConformanceSteers(input: TicketConformanceInput): TicketConformanceDecision {
  const reported = new Map<string, string>()
  const byAgent = new Map<string, TicketDiagnostic[]>()
  for (const diagnostic of input.diagnostics) {
    const agentId = lastWriterOf(pathIdentity(diagnostic.path), input.writes, input.now)
    if (!agentId) continue
    const key = reportedTicketKey(agentId, diagnostic.path)
    if (input.reported.get(key) === diagnostic.message) {
      reported.set(key, diagnostic.message)
      continue
    }
    const held = byAgent.get(agentId)
    if (held) held.push(diagnostic)
    else byAgent.set(agentId, [diagnostic])
  }
  return {
    steers: [...byAgent].map(([agentId, files]) => ({ agentId, files, text: steerText(files) })),
    reported
  }
}
