import { isAgentProvider, type AgentProvider } from '../shared/agent-provider'
import type { AgentChatStatus } from '../shared/agent-transcript'
import type { AgentEventBroker } from './agent-event-broker'
import type { WorkspaceStore } from './workspace-store'

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

/**
 * The production counter deliberately reads the complete workspace snapshot, not the requesting
 * grant's project. The broker then decides which provenance-bearing sessions remain live.
 */
export function createProviderWideTicketSessionCounter(options: {
  workspace: Pick<WorkspaceStore, 'load'>
  broker: Pick<AgentEventBroker, 'snapshot'>
}): (provider: AgentProvider) => Promise<number> {
  return async (provider) => {
    const nodes = (await options.workspace.load()).state?.nodes ?? []
    return activeOrchestratedTicketSessionCount(nodes, provider, (nodeId) => options.broker.snapshot(nodeId)?.status)
  }
}
