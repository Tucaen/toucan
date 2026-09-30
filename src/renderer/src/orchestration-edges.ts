import type { Edge } from '@xyflow/react'
import { isChatCanvasNode, type CanvasNode } from './canvas-workspace'
import { LINEAGE_SOURCE_HANDLE, LINEAGE_TARGET_HANDLE } from './conversation-lineage'

/**
 * The orchestrated-by edge (#34): from an orchestrator to each ticket session it spawned. Like the
 * lineage edge it is a projection of node data - `orchestratedBy` on the ticket session - rebuilt
 * at render time and never stored, so it survives a restart exactly as long as the record does,
 * cannot be drawn or removed by hand, and grants nothing: it is not a terminal-context connection
 * and main never reads it. A ticket session sits on its worktree's canvas, so the edge usually
 * crosses canvases and is listed by the connections dialog rather than drawn
 * (`splitWorktreeCanvasEdges`).
 */

export const ORCHESTRATED_EDGE_CLASS = 'orchestrated-edge'

/**
 * Own namespace, so the edge can never be confused with a lineage edge or a context grant.
 * @internal exported for tests
 */
export function orchestratedEdgeId(orchestratorNodeId: string, ticketNodeId: string): string {
  return `orchestrated:${orchestratorNodeId}->${ticketNodeId}`
}

/** What the projection depends on, so a drag does not mint fresh edges per frame (see `lineageKey`). */
export function orchestratedKey(nodes: readonly CanvasNode[]): string {
  return nodes
    .map((node) => `${node.id}:${(isChatCanvasNode(node) && node.data.orchestratedBy?.nodeId) || ''}`)
    .join('|')
}

/** The orchestrated-by edges the canvas implies; a link to a node that is gone draws nothing. */
export function orchestratedEdges(nodes: readonly CanvasNode[]): Edge[] {
  const present = new Set(nodes.map((node) => node.id))
  return nodes.filter(isChatCanvasNode).flatMap((node) => {
    const orchestrator = node.data.orchestratedBy
    if (!orchestrator || orchestrator.nodeId === node.id || !present.has(orchestrator.nodeId)) return []
    return [
      {
        id: orchestratedEdgeId(orchestrator.nodeId, node.id),
        source: orchestrator.nodeId,
        target: node.id,
        sourceHandle: LINEAGE_SOURCE_HANDLE,
        targetHandle: LINEAGE_TARGET_HANDLE,
        className: ORCHESTRATED_EDGE_CLASS,
        selectable: false,
        deletable: false,
        reconnectable: false,
        focusable: false
      }
    ]
  })
}
