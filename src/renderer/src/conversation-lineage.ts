import type { Edge } from '@xyflow/react'
import type { TerminalKind } from '../../shared/terminal'
import type { ConversationLineage } from '../../shared/workspace'
import {
  isChatCanvasNode,
  type CanvasNode,
  type TerminalCanvasNode,
  type TerminalNodeData,
  type TerminalNodeStatus
} from './canvas-workspace'
import { ADOPTION_BOUNDARY } from './worktree-attachment'

/**
 * Branching a conversation, as the canvas sees it: when the action is offered, when it may run,
 * and how the lineage between parent and child is drawn.
 *
 * The lineage is *node data* - `branchedFrom` on the child - and the edge is a projection of it,
 * rebuilt at render time and never stored. That is the whole difference from the terminal-context
 * edge (`terminal-context-edges.ts`), which is runtime-only edge state: a terminal does not
 * survive a restart, but a conversation's parentage is a fact about the transcript and does. It
 * also means a deleted parent simply stops producing an edge while the child keeps the record of
 * where it came from, and that nothing the user does to the canvas can rewrite provenance -
 * a lineage edge is not drawable, not removable, and not a connection at all.
 */

/**
 * Providers whose fork is verified end to end. The `session.fork` capability is necessary but not
 * sufficient: an adapter can advertise it and still replay a transcript Toucan has never checked,
 * so the action stays behind an allow-list until each provider is verified - both by
 * `scripts/verify-session-fork.mjs <provider>` (Claude for #200, Codex for #205).
 */
// Deliberately not `AGENT_PROVIDERS`: this list is the verification record, so a provider Toucan
// gains is unbranchable until someone has run the script against it and added it here.
export const BRANCHABLE_PROVIDERS: readonly TerminalKind[] = ['claude', 'codex']

/** The little of a node this decision reads, so a rendering node can ask without being one. */
export type BranchCandidate = { data: Pick<TerminalNodeData, 'kind' | 'conversationId' | 'forkSupport'> }

/**
 * The action is *absent* rather than disabled when the provider cannot fork - a control that can
 * never become available is noise, not information. `forkSupport` is launch-time truth reported by
 * the running session (`AgentCreateResult.forkSupport`); `undefined` means no session has reported
 * yet - a dormant or freshly restored node - and is deliberately permissive, because a fork runs
 * in the *child's* adapter and so needs nothing from the parent's process. A node with no
 * conversation id has no transcript to copy, so there is nothing to branch from either.
 */
export function offersBranchAction(node: BranchCandidate): boolean {
  if (!BRANCHABLE_PROVIDERS.includes(node.data.kind)) return false
  if (node.data.forkSupport === false) return false
  return typeof node.data.conversationId === 'string' && node.data.conversationId.length > 0
}

/**
 * Why a shown Branch action is disabled, or `undefined` when it can run. A fork copies the
 * transcript the provider has written to disk, and that file is only a complete conversation at a
 * turn boundary - so the same boundary a worktree move demands applies here, for its own reason.
 */
export function branchBlockedReason(status: TerminalNodeStatus): string | undefined {
  if (ADOPTION_BOUNDARY.includes(status)) return undefined
  return 'Branching waits for the current turn to finish.'
}

/**
 * Own namespace, so a lineage edge can never be confused with a terminal-context grant.
 * @internal exported for tests
 */
export function lineageEdgeId(parentNodeId: string, childNodeId: string): string {
  return `lineage:${parentNodeId}->${childNodeId}`
}

/** The handle ids the projection attaches to; a lineage edge borrows no connectable port. */
export const LINEAGE_SOURCE_HANDLE = 'lineage-source'
export const LINEAGE_TARGET_HANDLE = 'lineage-target'

/**
 * What the projection actually depends on: which nodes exist, and which of them record a parent.
 * A drag rewrites `nodes` on every pointer frame without touching either, so memoising on this key
 * keeps a moving node from minting a fresh edge identity per frame - React Flow positions an edge
 * from its endpoints, not from the object it was given.
 */
export function lineageKey(nodes: readonly CanvasNode[]): string {
  return nodes.map((node) => `${node.id}:${(isChatCanvasNode(node) && node.data.branchedFrom?.nodeId) || ''}`).join('|')
}

/**
 * The lineage edges the current canvas implies. Purely derived: call it on every render with the
 * live node list and concatenate the result onto the real edge state. A `branchedFrom` naming a
 * node that is gone (closed, or from a workspace whose parent was never restored) draws nothing
 * while the record itself stays on the child.
 */
export function lineageEdges(nodes: readonly CanvasNode[]): Edge[] {
  const present = new Set(nodes.map((node) => node.id))
  return nodes.filter(isChatCanvasNode).flatMap((node) => {
    const parent = node.data.branchedFrom
    if (!parent || parent.nodeId === node.id || !present.has(parent.nodeId)) return []
    return [
      {
        id: lineageEdgeId(parent.nodeId, node.id),
        source: parent.nodeId,
        target: node.id,
        sourceHandle: LINEAGE_SOURCE_HANDLE,
        targetHandle: LINEAGE_TARGET_HANDLE,
        className: 'lineage-edge',
        // A projection is not a thing the canvas owns: it cannot be picked, deleted or redrawn.
        selectable: false,
        deletable: false,
        reconnectable: false,
        focusable: false
      }
    ]
  })
}

/** Everything a branch inherits from the node it was taken at; `undefined` when there is nothing to fork. */
export interface BranchPlan {
  kind: TerminalKind
  /**
   * The child's own title. The fork copies the transcript, so a title derived from it comes out
   * identical to the parent's; the child is titled at creation instead, as a manual title, so no
   * generated one can ever replace it (#240).
   */
  label: string
  /** The provenance record the child carries, and the conversation its fork copies. */
  branchedFrom: ConversationLineage
  /**
   * The model the parent is running, so the branch continues the same conversation on the same
   * model. Absent only when the parent never reported one, which leaves the child on the adapter's
   * default exactly as a fresh node would be - a branch must not silently change the model that
   * wrote the transcript it inherits.
   */
  modelId?: string
  /** The worktree the parent runs in, so the child runs in the same checkout. */
  worktreeId?: string
}

/**
 * "<parent> (branch)", numbered from 2 when that title is already taken - by an earlier branch of
 * the same parent, typically - so siblings stay as distinguishable as parent and child.
 * @internal exported for tests
 */
export function branchLabel(parentLabel: string, takenLabels: Iterable<string>): string {
  const taken = new Set(takenLabels)
  for (let index = 1; ; index += 1) {
    const candidate = `${parentLabel} (branch${index === 1 ? '' : ` ${index}`})`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * What a branch of this node would be. One place decides it, so the canvas's placement code
 * cannot quietly drop an inherited property the way passing fields one by one invites.
 * `takenLabels` are the titles already on the canvas, so a second branch is numbered.
 */
export function planBranch(parent: TerminalCanvasNode, takenLabels: Iterable<string> = []): BranchPlan | undefined {
  if (!parent.data.conversationId) return undefined
  return {
    kind: parent.data.kind,
    label: branchLabel(parent.data.label, takenLabels),
    branchedFrom: { nodeId: parent.id, conversationId: parent.data.conversationId },
    modelId: parent.data.modelId,
    worktreeId: parent.data.worktreeId
  }
}
