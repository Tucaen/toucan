import {
  Background,
  BackgroundVariant,
  ReactFlow,
  useReactFlow,
  type Edge,
  type FitViewOptions,
  type NodeChange,
  type NodeTypes,
  type Viewport
} from '@xyflow/react'
import { Maximize } from 'lucide-react'
import { useCallback, useContext, useEffect, useRef } from 'react'
import type { TerminalKind } from '../../shared/terminal'
import type { WorktreeViewport } from '../../shared/worktree'
import type { TerminalCanvasNode } from './canvas-workspace'
import { NodeFitContext } from './node-fit-context'
import SessionKindIcon from './SessionKindIcon'
import { correctScaledCanvasPointerCoordinates } from './scaled-pointer-coordinates'
import SessionNode from './SessionNode'
import { WorktreeCanvasContext } from './worktree-canvas-context'

/**
 * The chats inside a worktree are the ordinary session node, rendered by its own component - the
 * inner canvas registers the same node type the main canvas does, and nothing else.
 */
const nodeTypes: NodeTypes = { terminalNode: SessionNode }

const FIT_CHATS: FitViewOptions = { padding: 0.06, duration: 250 }
const NO_CHILDREN: TerminalCanvasNode[] = []
const NO_EDGES: Edge[] = []
const ORIGIN: Viewport = { x: 0, y: 0, zoom: 1 }

interface WorktreeCanvasProps {
  worktreeId: string
  /** Where the canvas was left; absent frames the chats as soon as they are measured. */
  viewport?: WorktreeViewport
  unavailable: boolean
  attachedNodeCount: number
  onAddChat(kind: TerminalKind): void
  onViewportChange(worktreeId: string, viewport: WorktreeViewport): void
}

/**
 * A worktree's own canvas of chats and the compact row beneath it. Rendered inside its own
 * `ReactFlowProvider`, so every React Flow hook below - the chats' resize handles, their fit
 * action, Fit chats - addresses this canvas and never the main one.
 *
 * It holds no nodes of its own: they are the workspace's, read through `WorktreeCanvasContext`, and
 * every change goes straight back there. Gestures stay here without special casing: React Flow
 * stops a drag, pan or Ctrl+wheel it handles from reaching the main canvas around it, and the
 * `nodrag` on the canvas is what keeps the main canvas from moving the worktree from inside it.
 */
export default function WorktreeCanvas({
  worktreeId,
  viewport,
  unavailable,
  attachedNodeCount,
  onAddChat,
  onViewportChange
}: WorktreeCanvasProps): JSX.Element {
  const host = useContext(WorktreeCanvasContext)
  const children = host.partition.children.get(worktreeId) ?? NO_CHILDREN
  const edges = host.edges.children.get(worktreeId) ?? NO_EDGES
  const activity = host.activity.get(worktreeId)
  const { fitView } = useReactFlow()

  // React Flow queues a fit until every node it is given has been measured, so a chat added a
  // moment ago is framed at its real size rather than ignored.
  const fitChats = useCallback((): void => void fitView(FIT_CHATS), [fitView])
  const fitChat = useCallback(
    (nodeId: string): void => void fitView({ ...FIT_CHATS, nodes: [{ id: nodeId }] }),
    [fitView]
  )

  // A chat that joins after the canvas mounted is brought into view: it was placed beside the
  // others, which may well be outside what the canvas shows. The mount itself is left to the
  // saved viewport, or to the `fitView` prop when there is none.
  const knownIds = useRef<ReadonlySet<string> | null>(null)
  useEffect(() => {
    const ids = new Set(children.map((node) => node.id))
    const known = knownIds.current
    knownIds.current = ids
    if (known && [...ids].some((id) => !known.has(id))) fitChats()
  }, [children, fitChats])

  // The main canvas's zoom scales this one on screen; see `correctScaledCanvasPointerCoordinates`.
  const canvasRef = useRef<HTMLDivElement>(null)
  useEffect(() => correctScaledCanvasPointerCoordinates(canvasRef.current), [])

  const handleNodesChange = useCallback(
    (changes: NodeChange<TerminalCanvasNode>[]): void => host.onNodesChange(changes, worktreeId),
    [host, worktreeId]
  )
  const handlePaneClick = useCallback((): void => host.onPaneClick(worktreeId), [host, worktreeId])

  const handleMoveEnd = useCallback(
    (_event: unknown, next: Viewport): void => onViewportChange(worktreeId, next),
    [onViewportChange, worktreeId]
  )

  return (
    <>
      {/* A click inside stays inside: reaching the main canvas it would select this worktree's
          frame there, and so clear the chat it was meant for (`selectOnlyWithinCanvas`). */}
      <div ref={canvasRef} className="worktree-canvas nodrag" onClick={(event) => event.stopPropagation()}>
        <NodeFitContext.Provider value={fitChat}>
          <ReactFlow
            nodes={children}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={handleNodesChange}
            onPaneClick={handlePaneClick}
            onMoveEnd={handleMoveEnd}
            defaultViewport={viewport ?? ORIGIN}
            fitView={!viewport}
            fitViewOptions={FIT_CHATS}
            minZoom={0.25}
            maxZoom={2}
            // The main canvas's wheel policy, for the same reason: plain wheel scrolls a transcript,
            // only Ctrl+wheel or a pinch moves the canvas under the pointer.
            zoomOnScroll={false}
            zoomOnPinch
            panOnScroll={false}
            preventScrolling={false}
            nodesConnectable={false}
            // Auto-pan measures the pointer against the canvas's on-screen bounds, which the main
            // zoom scales while the corrected pointer is not - it would pan on its own mid-drag.
            autoPanOnNodeDrag={false}
            autoPanOnSelection={false}
            colorMode="dark"
            deleteKeyCode={['Backspace', 'Delete']}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#2a2436" />
          </ReactFlow>
        </NodeFitContext.Provider>
        {children.length === 0 && (
          <p className="worktree-canvas-empty">
            {unavailable
              ? 'Worktree no longer exists. Close its attached sessions to remove this record.'
              : 'No chats in this worktree yet.'}
          </p>
        )}
      </div>

      <footer className="worktree-actions nodrag">
        <span className="worktree-activity">
          <span className="node-status">{attachedNodeCount} attached</span>
          {activity && activity.working > 0 && <span data-kind="working">{activity.working} working</span>}
          {activity && activity.attention > 0 && <span data-kind="attention">{activity.attention} waiting</span>}
        </span>
        <div className="worktree-open-group" role="group" aria-label="Add chat">
          <span className="eyebrow-label">Add chat</span>
          <button
            type="button"
            title="New Codex session in this worktree"
            disabled={unavailable}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => onAddChat('codex')}
          >
            <SessionKindIcon kind="codex" />
            Codex
          </button>
          <button
            type="button"
            title="New Claude session in this worktree"
            disabled={unavailable}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => onAddChat('claude')}
          >
            <SessionKindIcon kind="claude" />
            Claude
          </button>
        </div>
        <button
          type="button"
          className="worktree-fit-chats"
          title="Frame every chat in this worktree"
          disabled={children.length === 0}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={fitChats}
        >
          <Maximize aria-hidden="true" />
          Fit chats
        </button>
      </footer>
    </>
  )
}
