import type { AgentPromptResult } from '../shared/agent'
import type { AgentFileWrite } from '../shared/agent-activity'
import { errorMessage } from '../shared/text'
import { reportedTicketKey, ticketConformanceSteers, type TicketConformanceSteer } from '../shared/ticket-conformance'
import type { TicketDiagnostic } from '../shared/tickets'
import { createSerialQueue } from './serial-queue'

/**
 * Tells a session when it wrote a file into a project's tickets folder that the board cannot read
 * as a ticket. The watcher notices, `shared/ticket-conformance.ts` decides who to tell, and this
 * is the part with state and effects: the per-project dedupe record, and the delivery.
 *
 * Deliberately the same generation-side schema the board reads with - `diagnosticsFor` runs the
 * ticket library's own listing - so an agent can never be corrected against a rule the board does
 * not apply, or left alone by one it does.
 */

export interface TicketSteeringOptions {
  /** This project's non-ticket files and why, from the same listing the board renders. */
  diagnosticsFor(projectPath: string): Promise<readonly TicketDiagnostic[]>
  /** Recent write locations across every live session; the only attribution evidence there is. */
  recentWrites(): readonly AgentFileWrite[]
  /**
   * Delivers one message to one session - steered into a working turn where the adapter supports
   * it, queued as the next prompt where it does not. Its promise settles at *delivery*, which for
   * a queued message is the end of the turn in flight, so it is never awaited before the next
   * check may run. A refusal is reported, never thrown.
   */
  steer(agentId: string, text: string): Promise<AgentPromptResult>
  log?(message: string): void
}

export interface TicketSteering {
  /**
   * Re-checks one project's tickets folder and hands off whatever it found. Cheap to call on every
   * watcher tick, and settles once the decision is made rather than once the agents have read it.
   */
  check(projectPath: string): Promise<void>
}

export function createTicketSteering(options: TicketSteeringOptions): TicketSteering {
  /**
   * Project path -> `reportedTicketKey` -> the error that session was already told about. Held per
   * project because a check only ever sees one project's diagnostics, and "the file was fixed" has
   * to be readable as "absent from *this* project's listing" rather than from the whole record.
   */
  const reported = new Map<string, Map<string, string>>()
  // Serialized so two changes in quick succession cannot both read the dedupe record before
  // either has written it back, and steer one session twice about one breakage.
  const queue = createSerialQueue()

  async function run(projectPath: string): Promise<void> {
    let diagnostics: readonly TicketDiagnostic[]
    try {
      diagnostics = await options.diagnosticsFor(projectPath)
    } catch (error) {
      // A folder that cannot be read is already the board's diagnostic row; it is not evidence
      // that any session wrote anything wrong.
      options.log?.(`could not list tickets in ${projectPath}: ${errorMessage(error)}`)
      return
    }
    const decision = ticketConformanceSteers({
      diagnostics,
      writes: options.recentWrites(),
      reported: reported.get(projectPath) ?? new Map(),
      now: Date.now()
    })
    const keep = decision.reported
    // Recorded before the message has landed, because "landed" can be the end of a turn that runs
    // for minutes: a session steered mid-turn would otherwise be steered again by every watcher
    // tick until it read the first one. A delivery that comes back refused undoes its own record.
    for (const steer of decision.steers) {
      for (const file of steer.files) keep.set(reportedTicketKey(steer.agentId, file.path), file.message)
    }
    if (keep.size > 0) reported.set(projectPath, keep)
    else reported.delete(projectPath)
    for (const steer of decision.steers) void deliver(projectPath, steer)
  }

  async function deliver(projectPath: string, steer: TicketConformanceSteer): Promise<void> {
    let result: AgentPromptResult
    try {
      result = await options.steer(steer.agentId, steer.text)
    } catch (error) {
      result = { ok: false, message: errorMessage(error) }
    }
    if (result.ok) return
    options.log?.(`could not steer ${steer.agentId} about a malformed ticket: ${result.message ?? 'refused'}`)
    // Forgotten, so the next change to the folder tries again: a session that could not take the
    // message (starting, signed out, already gone) must not be left thinking its file was fine.
    const held = reported.get(projectPath)
    if (!held) return
    for (const file of steer.files) {
      const key = reportedTicketKey(steer.agentId, file.path)
      if (held.get(key) === file.message) held.delete(key)
    }
    if (held.size === 0) reported.delete(projectPath)
  }

  return { check: (projectPath) => queue(() => run(projectPath)) }
}
