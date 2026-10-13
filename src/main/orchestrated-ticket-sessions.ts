import { isAgentProvider, type AgentProvider } from '../shared/agent-provider'
import type { AgentChatStatus } from '../shared/agent-transcript'
import { ORCHESTRATOR_ROLE } from '../shared/orchestration'
import type { WorkingSessions } from '../shared/orchestration-pacing'
import type { AgentEventBroker } from './agent-event-broker'
import type { WorkspaceStore } from './workspace-store'

/** The persisted provenance and live state needed to count one possible ticket session. */
export interface OrchestratedTicketSessionCandidate {
  id: string
  kind: string
  orchestratedBy?: unknown
  role?: string
}

/** @internal exported for tests
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

/**
 * @internal exported for tests
 * Sessions of one provider that are mid-turn right now, by what they are: orchestrated tickets,
 * orchestrators, and every other chat. Idle sessions use nothing and are not counted.
 */
export function workingSessionCounts(
  nodes: Iterable<OrchestratedTicketSessionCandidate>,
  provider: AgentProvider,
  statusFor: (nodeId: string) => AgentChatStatus | undefined
): WorkingSessions {
  const working: WorkingSessions = { tickets: 0, orchestrators: 0, chats: 0 }
  for (const node of nodes) {
    if (!isAgentProvider(node.kind) || node.kind !== provider || statusFor(node.id) !== 'working') continue
    if (node.orchestratedBy !== undefined) working.tickets += 1
    else if (node.role === ORCHESTRATOR_ROLE) working.orchestrators += 1
    else working.chats += 1
  }
  return working
}

/** Provider-wide working sessions from the whole workspace, like the ticket counter above. */
export function createWorkingSessionCounter(options: {
  workspace: Pick<WorkspaceStore, 'load'>
  broker: Pick<AgentEventBroker, 'snapshot'>
}): (provider: AgentProvider) => Promise<WorkingSessions> {
  return async (provider) => {
    const nodes = (await options.workspace.load()).state?.nodes ?? []
    return workingSessionCounts(nodes, provider, (nodeId) => options.broker.snapshot(nodeId)?.status)
  }
}
