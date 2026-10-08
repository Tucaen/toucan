import type { AgentProvider } from '../shared/agent-provider'
import type { AgentChatStatus } from '../shared/agent-transcript'
import { isAgentProvider } from '../shared/agent-provider'

/** The persisted provenance and live state needed to count one possible ticket session. */
export interface OrchestratedTicketSessionCandidate {
  id: string
  kind: string
  orchestratedBy?: unknown
}

/**
 * Counts live ticket sessions for a provider from all workspace nodes. A ticket is identified by
 * its persisted orchestration provenance, while the broker remains the owner of whether it is
 * live; a dormant canvas node or an exited session therefore consumes no pacing capacity.
 */
export function activeOrchestratedTicketSessionCount(
  nodes: Iterable<OrchestratedTicketSessionCandidate>,
  provider: AgentProvider,
  statusFor: (nodeId: string) => AgentChatStatus | undefined
): number {
  let count = 0
  for (const node of nodes) {
    if (node.orchestratedBy === undefined || !isAgentProvider(node.kind) || node.kind !== provider) continue
    const status = statusFor(node.id)
    if (status !== undefined && status !== 'exited') count += 1
  }
  return count
}
