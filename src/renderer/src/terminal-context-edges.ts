import type { Edge } from '@xyflow/react'
import type { TerminalContextEdge } from '../../shared/terminal-context'
import {
  isChatCanvasNode,
  isTerminalCanvasNode,
  sessionNodeStatus,
  type CanvasNode,
  type TerminalCanvasNode,
  type TerminalNodeStatus
} from './canvas-workspace'

/**
 * The renderer-side decisions behind the terminal-context edge (design in
 * `docs/plans/terminal-context-edge.md`): which connections the canvas admits, what closing a node
 * does to the edge set, and how that set is mirrored into main's registry. Edge state itself is
 * React state in `App.tsx` beside `nodes` - deliberately runtime-only, never `WorkspaceState` -
 * and these functions are pure so the rules are testable without a canvas.
 */

/**
 * The one edge the canvas has: terminal → chat, granting that chat's agent a read of the
 * terminal's output. Nothing else is connectable - there are no generic untyped edges - so this is
 * the whole of `isValidConnection`. Dormancy deliberately does not matter on either end: the
 * terminal's retained tail outlives its incarnation, and the grant should survive the same way the
 * edge does. A connection is directional; React Flow's strict mode already guarantees `source` is
 * a source handle, so a chat → terminal drag never reaches this with the roles flipped.
 */
export function isValidTerminalContextConnection(
  nodes: readonly CanvasNode[],
  connection: { source: string | null; target: string | null }
): boolean {
  if (!connection.source || !connection.target || connection.source === connection.target) return false
  const source = nodes.find((node) => node.id === connection.source)
  const target = nodes.find((node) => node.id === connection.target)
  return Boolean(source && target && isTerminalContextPair(source, target))
}

/** The one reading of "a terminal feeding a chat", shared by the admit rule and the mirror. */
function isTerminalContextPair(source: CanvasNode, target: CanvasNode): source is TerminalCanvasNode {
  return isTerminalCanvasNode(source) && source.data.kind === 'terminal' && isChatCanvasNode(target)
}

/**
 * Deterministic per pair, so drawing the same connection twice collapses onto one edge instead of
 * stacking a second identical grant the reader cannot see.
 */
export function terminalContextEdgeId(source: string, target: string): string {
  return `terminal-context:${source}->${target}`
}

/**
 * Appends a validated connection as an edge; an invalid or duplicate one returns the set as it
 * came, same reference, so a no-op never re-renders or re-publishes the mirror.
 */
export function withTerminalContextEdge(
  edges: Edge[],
  nodes: readonly CanvasNode[],
  connection: { source: string | null; target: string | null }
): Edge[] {
  if (!isValidTerminalContextConnection(nodes, connection)) return edges
  const id = terminalContextEdgeId(connection.source!, connection.target!)
  if (edges.some((edge) => edge.id === id)) return edges
  return [...edges, { id, source: connection.source!, target: connection.target! }]
}

/**
 * Closing either node removes the edge - the whole lifecycle rule. Run inside the same removal
 * wrapper that feeds `recentlyClosedNodes`, so every close path a session node has drops its
 * edges too.
 */
export function withoutEdgesTouchingNodes(edges: readonly Edge[], removedNodeIds: ReadonlySet<string>): Edge[] {
  return edges.filter((edge) => !removedNodeIds.has(edge.source) && !removedNodeIds.has(edge.target))
}

/**
 * What main's registry is told: the durable terminal `sessionId` (never the canvas node id, which
 * no terminal IPC routes by) paired with the agent session id, which *is* the chat node's id -
 * the key `useAgentConversation` creates and addresses the session under. An edge whose endpoint
 * has vanished or changed kind mirrors as nothing rather than as a guess.
 */
export function mirroredTerminalContextEdges(
  nodes: readonly CanvasNode[],
  edges: readonly Edge[]
): TerminalContextEdge[] {
  return edges.flatMap((edge) => {
    const source = nodes.find((node) => node.id === edge.source)
    const target = nodes.find((node) => node.id === edge.target)
    if (!source || !target || !isTerminalContextPair(source, target)) return []
    return [{ terminalSessionId: source.data.sessionId, agentId: target.id }]
  })
}

/**
 * When a session may restart to adopt an edge drawn onto it mid-conversation. Narrower than the
 * worktree adoption boundary on purpose: `dormant` and `exited` sessions are not restarted -
 * their next natural creation consults the registry anyway, and reviving an exited session
 * because an edge appeared would be the edge doing more than granting a read.
 */
export const TERMINAL_CONTEXT_ADOPTION_BOUNDARY: readonly TerminalNodeStatus[] = ['idle', 'result']

/**
 * The chat nodes whose live session must restart to pick up the read tool: an edge stands, but
 * the session reported launching without the tool (`sessions[id] === false` - the launch-time
 * truth off `AgentCreateResult`; unknown means a session is still opening and will consult the
 * registry itself). Only at a boundary with nothing in flight, and only with a conversation to
 * resume - the restart replays the transcript, it must never begin a new one. Removing an edge
 * plans nothing: the registry already refuses at call time, and the definition drops off at the
 * session's next natural resume.
 */
export function planTerminalContextAdoptions(
  nodes: readonly CanvasNode[],
  edges: readonly Edge[],
  statuses: Readonly<Record<string, TerminalNodeStatus>>,
  sessions: Readonly<Record<string, boolean>>
): string[] {
  const connected = new Set(mirroredTerminalContextEdges(nodes, edges).map((edge) => edge.agentId))
  return nodes
    .filter(isChatCanvasNode)
    .filter(
      (node) =>
        connected.has(node.id) &&
        sessions[node.id] === false &&
        !node.data.dormant &&
        Boolean(node.data.conversationId) &&
        TERMINAL_CONTEXT_ADOPTION_BOUNDARY.includes(sessionNodeStatus(node, statuses))
    )
    .map((node) => node.id)
}

/**
 * Applies those adoptions: bumping `terminalContextNonce` is what restarts the session effect,
 * and `resume` makes the restart load the same conversation - the `adoptClaimedWorktrees` move,
 * except the cwd never changes, which is why this one is safe for both providers.
 */
export function adoptTerminalContext(nodes: CanvasNode[], nodeIds: readonly string[]): CanvasNode[] {
  if (nodeIds.length === 0) return nodes
  const ids = new Set(nodeIds)
  return nodes.map((node) =>
    isChatCanvasNode(node) && ids.has(node.id)
      ? {
          ...node,
          data: {
            ...node.data,
            terminalContextNonce: (node.data.terminalContextNonce ?? 0) + 1,
            launchMode: 'resume' as const
          }
        }
      : node
  )
}
