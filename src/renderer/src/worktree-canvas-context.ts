import type { NodeChange } from '@xyflow/react'
import { createContext } from 'react'
import type { CanvasNode } from './canvas-workspace'
import type { WorktreeActivity, WorktreeCanvasEdges, WorktreeCanvasPartition } from './worktree-canvas'

/**
 * What a worktree's inner canvas reads from the workspace: which chats it shows, which edges run
 * between them, what they are doing - and the one place its changes go. That place is the
 * workspace's own node handler, so a drag, a resize or a close inside a worktree lands in the same
 * single node set, through the same lifecycle, as it would on the main canvas.
 */
export interface WorktreeCanvasHost {
  partition: WorktreeCanvasPartition
  edges: WorktreeCanvasEdges
  activity: ReadonlyMap<string, WorktreeActivity>
  /** `canvas` names the worktree whose canvas the changes came from. */
  onNodesChange(changes: NodeChange<CanvasNode>[], canvas: string): void
  /** Its empty pane was clicked: nothing may stay selected on any other canvas. */
  onPaneClick(canvas: string): void
}

/** Empty by default, so a worktree node renders in isolation (tests) with an empty canvas. */
export const WorktreeCanvasContext = createContext<WorktreeCanvasHost>({
  partition: { main: [], children: new Map() },
  edges: { main: [], children: new Map() },
  activity: new Map(),
  onNodesChange: () => undefined,
  onPaneClick: () => undefined
})
