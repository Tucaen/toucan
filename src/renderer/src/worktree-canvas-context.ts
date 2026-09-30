import type { Connection, EdgeChange, IsValidConnection, NodeChange, Viewport } from '@xyflow/react'
import { createContext } from 'react'
import type { CanvasNode } from './canvas-workspace'
import type { WorktreeCanvasEdges, WorktreeCanvasPartition } from './worktree-canvas'
import type { WorktreeSummary } from './worktree-overview'

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
  /** Frames every chat, as the Fit chats action does. */
  fitChats(): Promise<boolean>
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
  /** By worktree id. */
  summaries: ReadonlyMap<string, WorktreeSummary>
  /** Brings a chat into view on its canvas and selects it, expanding its worktree if collapsed. */
  onReveal(nodeId: string): void
  /** `canvas` names the worktree whose canvas the changes came from. */
  onNodesChange(changes: NodeChange<CanvasNode>[], canvas: string): void
  /**
   * Edge changes land in the workspace's one edge set, exactly as node changes do: deleting a
   * terminal-context edge inside a worktree is the same revocation it is on the main canvas.
   */
  onEdgesChange(changes: EdgeChange[]): void
  /** Drawing an edge grants terminal context; the workspace owns the set and mirrors it to main. */
  onConnect(connection: Connection): void
  /** The one admission rule - terminal → chat - shared with the main canvas. */
  isValidConnection: IsValidConnection
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
  summaries: new Map(),
  onReveal: () => undefined,
  onNodesChange: () => undefined,
  onEdgesChange: () => undefined,
  onConnect: () => undefined,
  isValidConnection: () => false,
  onPaneClick: () => undefined,
  registerCanvas: () => () => undefined,
  onCanvasResize: () => undefined
})
