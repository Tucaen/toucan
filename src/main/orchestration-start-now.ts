import type { AgentPromptResult } from '../shared/agent'
import { startableTickets } from '../shared/orchestration'
import type { OrchestrationForceStartResult } from '../shared/ticket-session-spawn'
import type { OrchestrationKey, OrchestrationStore } from './orchestration-store'

/** An orchestrator node as main resolves it: the record it drives, or nothing when it is not one. */
export interface StartNowOrchestrator {
  key: OrchestrationKey
  orchestratorNodeId: string
}

export interface OrchestrationStartNowOptions {
  records: Pick<OrchestrationStore, 'read'>
  /** The orchestration a node drives as its orchestrator; undefined for any other node. */
  orchestratorFor(nodeId: string): Promise<StartNowOrchestrator | undefined>
  /** Hands the orchestrator its instruction, queued behind a running turn. */
  wake(orchestratorNodeId: string, prompt: string): Promise<AgentPromptResult>
  log?(message: string): void
}

/**
 * Start now on the orchestrator node. It only asks the orchestrator to run `spawn --force`: the
 * spawn itself, its routing and every check that still applies stay the orchestrator's.
 */
export type OrchestrationStartNow = (request: {
  key: OrchestrationKey
  nodeId: string
  ticketId: string
}) => Promise<OrchestrationForceStartResult>

const startNowPrompt = (ticketId: string): string =>
  `The user pressed Start now for ticket ${ticketId}. Spawn it now, routed as you otherwise would, with ` +
  `\`spawn --ticket ${ticketId} --force --reason "user pressed Start now"\`. Report a refusal instead of retrying.`

const sameKey = (left: OrchestrationKey, right: OrchestrationKey): boolean =>
  left.provider === right.provider && left.conversationId === right.conversationId

export function createOrchestrationStartNow(options: OrchestrationStartNowOptions): OrchestrationStartNow {
  return async ({ key, nodeId, ticketId }) => {
    const orchestrator = await options.orchestratorFor(nodeId)
    if (!orchestrator || !sameKey(orchestrator.key, key)) {
      return { ok: false, message: 'Only the orchestrator node can start its own tickets.' }
    }
    const record = await options.records.read(key)
    if (!record) return { ok: false, message: 'This orchestration has no plan yet.' }
    if (!startableTickets(record).some((ticket) => ticket.id === ticketId)) {
      return { ok: false, message: `Ticket ${ticketId} cannot be started now.` }
    }
    // Not awaited: a working orchestrator takes the prompt only at its turn's end, and the button
    // must not wait that long.
    void options
      .wake(orchestrator.orchestratorNodeId, startNowPrompt(ticketId))
      .then((result) => {
        if (!result.ok) options.log?.(`start now prompt failed: ${result.message ?? 'unknown'}`)
      })
      .catch((error: unknown) => options.log?.(`start now prompt could not be delivered: ${String(error)}`))
    return { ok: true }
  }
}
