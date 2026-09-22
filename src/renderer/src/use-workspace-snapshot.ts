import { useMemo } from 'react'
import type { AttentionItem } from '../../shared/attention'
import type { DecisionDelegationPreference } from '../../shared/decision-delegation'
import type { DictationCleanupPreference } from '../../shared/dictation-cleanup'
import type { RoutineDelegationPreference } from '../../shared/routine-delegation'
import type {
  AgentPermissionModes,
  BrainDumpPanelState,
  ComposerSendKey,
  ProjectGroup,
  TicketBoardPanelState,
  WorkspaceLayoutSlot,
  WorkspaceProject,
  WorkspaceState,
  WorkspaceTerminalNode
} from '../../shared/workspace'
import { serializeCanvasNodes, type CanvasNode } from './canvas-workspace'
import { nodeBeforeTemporaryFit, type SnapStates } from './node-snap'

/**
 * Everything the persisted snapshot is built from, in one object. Every field is read by
 * `buildWorkspaceSnapshot`, and every field is a memo dependency - see `useWorkspaceSnapshot`.
 */
export interface WorkspaceSnapshotInput {
  projects: WorkspaceProject[]
  projectGroups: ProjectGroup[]
  activeProjectId: string | null
  sidebarCollapsed: boolean
  agentPermissionModes: AgentPermissionModes
  composerSendKey: ComposerSendKey
  routineDelegation: RoutineDelegationPreference
  decisionDelegation: DecisionDelegationPreference
  dictationCleanup: DictationCleanupPreference
  nodes: readonly CanvasNode[]
  /**
   * Snap state at save time, so a maximised node is serialized at the geometry a restore would
   * return it to rather than filling whatever canvas it happened to be maximised on. Passed as a
   * getter because the controller keeps it in a ref: every snap, restore, reflow and release also
   * rewrites `nodes`, so the snapshot is already recomputed whenever this can differ.
   */
  snaps: () => SnapStates
  recentlyClosedNodes: WorkspaceTerminalNode[]
  attention: readonly AttentionItem[]
  layoutSlots: Record<string, WorkspaceLayoutSlot>
  brainDumpPanel: BrainDumpPanelState
  ticketBoardPanel: TicketBoardPanelState
}

/**
 * The workspace as it goes to disk. Several fields are written only once the user has touched the
 * feature, which is what lets a workspace saved before that feature existed keep the shape it had.
 */
function buildWorkspaceSnapshot(input: WorkspaceSnapshotInput): WorkspaceState {
  const { routineDelegation, decisionDelegation, dictationCleanup, layoutSlots } = input
  return {
    version: 3,
    projects: input.projects,
    // Absent rather than empty, so a workspace that never made a group keeps writing the same
    // snapshot shape it wrote before groups existed.
    ...(input.projectGroups.length > 0 ? { projectGroups: input.projectGroups } : {}),
    activeProjectId: input.activeProjectId,
    sidebarCollapsed: input.sidebarCollapsed,
    agentPermissionModes: input.agentPermissionModes,
    composerSendKey: input.composerSendKey,
    // Absent until the user first touches the preference, so older workspaces keep their shape.
    ...(routineDelegation.enabled || routineDelegation.codexWorkerModelId || routineDelegation.claudeWorkerModelId
      ? { routineDelegation }
      : {}),
    // Same rule: absent until the user first turns it on, so older workspaces keep their shape.
    ...(decisionDelegation.enabled ? { decisionDelegation } : {}),
    ...(dictationCleanup.enabled || dictationCleanup.claudeModelId ? { dictationCleanup } : {}),
    // One array per node kind, from the one table that knows how each is persisted - including
    // which of them stay absent from the snapshot rather than being written empty.
    ...serializeCanvasNodes(input.nodes, (node) => nodeBeforeTemporaryFit(node, input.snaps())),
    recentlyClosedNodes: input.recentlyClosedNodes,
    attention: [...input.attention],
    // Absent rather than empty, like `projectGroups`, so a workspace that never saved a slot keeps
    // its snapshot shape.
    ...(Object.keys(layoutSlots).length > 0 ? { layoutSlots } : {}),
    brainDumpPanel: input.brainDumpPanel,
    ticketBoardPanel: input.ticketBoardPanel
  }
}

/**
 * The snapshot, memoised on every field of its own input.
 *
 * The dependency list is derived from the input object rather than written out, because a
 * hand-written one is exactly what drifted: `layoutSlots` was spread into the snapshot while the
 * list never mentioned it, so saving a layout slot produced no new snapshot, no autosave, and a
 * slot that was gone on the next launch. With the input built as one literal, adding a field to the
 * snapshot necessarily adds it to the memo. The rule cannot verify a list it cannot see written
 * out; the type does that job here instead.
 *
 * Two things keep that safe as a dependency list, which React requires to be the same length and
 * order on every render: every field of `WorkspaceSnapshotInput` is required, so the type itself
 * fixes the length, and the keys are sorted, so the order does not depend on how a caller happened
 * to write the literal.
 *
 * Callers must therefore pass stable values: an inline callback rebuilt each render would defeat
 * the memo, and a snapshot with a fresh identity every render restarts the autosave debounce
 * forever.
 */
export function useWorkspaceSnapshot(input: WorkspaceSnapshotInput): WorkspaceState {
  const dependencies = (Object.keys(input) as (keyof WorkspaceSnapshotInput)[]).sort().map((key) => input[key])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => buildWorkspaceSnapshot(input), dependencies)
}
