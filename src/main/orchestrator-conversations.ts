import { isAgentProvider } from '../shared/agent-provider'
import { ORCHESTRATOR_ROLE } from '../shared/orchestration'
import type { WorkspaceLoadResult, WorkspaceTerminalNode } from '../shared/workspace'
import { createDurableJsonStore } from './durable-json-store'
import type { OrchestrationKey, OrchestrationStore } from './orchestration-store'

/**
 * Which conversations are orchestrators' (Tucaen/toucan#1). A chat node's role lives on the node,
 * but a node is only one holder of a conversation: History opens the same conversation in a new
 * node, and a node saved without its role restores without it on every restart after. So the fact
 * is also kept with the conversation, keyed `(provider, conversationId)` like the orchestration
 * record, and every path that brings a conversation back onto the canvas asks here.
 *
 * Two sources answer, either one enough: a marker written the moment an orchestrator session
 * opens its conversation - only a session launched with the role is granted a token, so main
 * writes it on its own authority, never on the renderer's word - and the orchestration record,
 * which only an orchestrator can have written and which every conversation that planned before
 * the marker existed already has.
 */
export interface OrchestratorConversations {
  /** Never rejects: an unreadable marker file or record counts as not known. */
  has(key: OrchestrationKey): Promise<boolean>
  remember(key: OrchestrationKey): Promise<void>
}

type StoredMarkers = Record<string, true>

function markerKey(key: OrchestrationKey): string {
  return `${key.provider}:${key.conversationId}`
}

function parseMarkers(value: unknown): StoredMarkers | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, marked]) => (marked === true ? [[key, true as const]] : []))
  )
}

export function createOrchestratorConversations(options: {
  path: string
  records: Pick<OrchestrationStore, 'read'>
  log?(message: string): void
}): OrchestratorConversations {
  const store = createDurableJsonStore<StoredMarkers>({
    path: options.path,
    parse: parseMarkers,
    fallback: () => ({}),
    log: options.log
  })

  return {
    async has(key) {
      const marked = await store.load().then(
        (markers) => markers[markerKey(key)] === true,
        () => false
      )
      if (marked) return true
      return (await options.records.read(key).catch(() => undefined)) !== undefined
    },
    async remember(key) {
      await store.update((markers) =>
        markers[markerKey(key)] === true
          ? { value: markers, result: undefined }
          : { value: { ...markers, [markerKey(key)]: true }, result: undefined }
      )
    }
  }
}

/**
 * Gives a saved chat back the role its conversation has - on the canvas and in the reopen stack
 * alike. A node can only have lost it to the History reopen Tucaen/toucan#1 fixed, so this repairs
 * a snapshot that bug already wrote, once: the next save carries the role. A ticket session is
 * never an orchestrator, and a chat without a conversation has nothing to look up.
 */
export async function withOrchestratorRoles(
  loaded: WorkspaceLoadResult,
  conversations: Pick<OrchestratorConversations, 'has'>
): Promise<WorkspaceLoadResult> {
  const state = loaded.state
  if (!state) return loaded
  let repaired = false
  const repair = <Node extends WorkspaceTerminalNode>(nodes: Node[]): Promise<Node[]> =>
    Promise.all(
      nodes.map(async (node) => {
        if (node.role || node.orchestratedBy || !node.conversationId || !isAgentProvider(node.kind)) return node
        if (!(await conversations.has({ provider: node.kind, conversationId: node.conversationId }))) return node
        repaired = true
        return { ...node, role: ORCHESTRATOR_ROLE }
      })
    )
  const [nodes, recentlyClosedNodes] = await Promise.all([
    repair(state.nodes),
    state.recentlyClosedNodes ? repair(state.recentlyClosedNodes) : undefined
  ])
  return repaired
    ? { ...loaded, state: { ...state, nodes, ...(recentlyClosedNodes ? { recentlyClosedNodes } : {}) } }
    : loaded
}
