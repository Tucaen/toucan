import type { FitViewOptions, NodeChange, Viewport } from '@xyflow/react'
import { createContext } from 'react'
import type { CanvasNode } from './canvas-workspace'
import type { WorktreeActivity, WorktreeCanvasEdges, WorktreeCanvasPartition } from './worktree-canvas'

/**
 * What the workspace may do to one worktree's canvas from outside it: measure it, read and move
 * its viewport, frame its chats. Each inner canvas is its own React Flow, so its viewport is
 * reachable only through its own instance - this is that instance, lent to the workspace for as
 * long as the canvas is mounted. Positions and sizes stay the workspace's; only the view is here.
 */
export interface WorktreeCanvasHandle {
  /** The canvas's element, whose layout size (not its on-screen, main-zoom-scaled size) is the viewport's. */
  element: HTMLElement
  getViewport(): Viewport
  setViewport(viewport: Viewport, options?: { duration?: number }): Promise<boolean>
  fitView(options?: FitViewOptions): Promise<boolean>
}

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
  /** The canvas mounted and lends its instance to the workspace; the return unregisters it. */
  registerCanvas(canvas: string, handle: WorktreeCanvasHandle): () => void
  /** The canvas's layout size changed - its worktree was resized, focused or restored. */
  onCanvasResize(canvas: string): void
}

/** Empty by default, so a worktree node renders in isolation (tests) with an empty canvas. */
export const WorktreeCanvasContext = createContext<WorktreeCanvasHost>({
  partition: { main: [], children: new Map() },
  edges: { main: [], children: new Map() },
  activity: new Map(),
  onNodesChange: () => undefined,
  onPaneClick: () => undefined,
  registerCanvas: () => () => undefined,
  onCanvasResize: () => undefined
})
