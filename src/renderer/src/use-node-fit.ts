import type { Node, NodeChange, Viewport } from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'
import {
  NODE_FIT_INSET,
  clearNodeFitFlag,
  nodeFitAfterChanges,
  reflowFittedNode,
  requestNodeFit,
  type NodeFitState
} from './node-fit'

export interface NodeFitController<T extends Node> {
  /** Fits a node, restores it, or moves fit mode over from whichever node currently holds it. */
  toggle(nodeId: string): void
  /**
   * Must see every React Flow node change before it is applied: a drag or manual resize of the
   * fitted node leaves fit mode, and a removed node takes its fit state with it.
   */
  observeChanges(changes: NodeChange<T>[]): void
  /**
   * The fitted node and the pre-fit geometry persistence and recently-closed capture must
   * serialize instead of the fitted projection. Null when no node is fitted.
   */
  state(): NodeFitState | null
}

/**
 * Owns fit mode for the whole canvas: which node is fitted, the geometry a restore returns it to,
 * and keeping that node on the usable canvas as the canvas changes.
 *
 * The usable canvas is observed rather than derived: the canvas region is a layout sibling of the
 * project sidebar and the docked brain-dump panel, so one `ResizeObserver` on it covers an
 * application resize, a sidebar collapse, and the panel opening or being dragged - and never
 * touches the React Flow viewport while doing it.
 *
 * Fit state is a ref rather than React state because nothing renders from it; the node's own
 * `fittedToCanvas` data flag is what the header action reads. It is also written eagerly, before
 * the node list update it belongs to has been applied, because `state()` has to be truthful
 * within the same tick: the removal path reads it to serialize a closing node's pre-fit geometry.
 * That is why the node updates here are whole arrays read through `getNodes` rather than
 * functional updates - the caller must funnel every node change through one place.
 */
export function useNodeFit<T extends Node>({
  canvasRef,
  getNodes,
  getViewport,
  setNodes
}: {
  canvasRef: RefObject<HTMLElement | null>
  getNodes: () => T[]
  getViewport: () => Viewport
  setNodes: (nodes: T[]) => void
}): NodeFitController<T> {
  const fit = useRef<NodeFitState | null>(null)

  const toggle = useCallback(
    (nodeId: string): void => {
      const canvas = canvasRef.current?.getBoundingClientRect()
      if (!canvas) return
      const result = requestNodeFit(getNodes(), fit.current, nodeId, canvas, getViewport(), NODE_FIT_INSET)
      fit.current = result.fit
      setNodes(result.nodes)
    },
    [canvasRef, getNodes, getViewport, setNodes]
  )

  const observeChanges = useCallback(
    (changes: NodeChange<T>[]): void => {
      const current = fit.current
      const outcome = nodeFitAfterChanges(changes, current)
      if (outcome === 'keep' || !current) return
      fit.current = null
      // The geometry the user just produced is theirs to keep; only the pending restore is dropped.
      // A removed node needs no flag cleared, and React Flow is about to drop it anyway.
      if (outcome === 'exit') setNodes(clearNodeFitFlag(getNodes(), current.nodeId))
    },
    [getNodes, setNodes]
  )

  const state = useCallback((): NodeFitState | null => fit.current, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => {
      if (!fit.current) return
      setNodes(reflowFittedNode(getNodes(), fit.current, canvas.getBoundingClientRect(), getViewport(), NODE_FIT_INSET))
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [canvasRef, getNodes, getViewport, setNodes])

  return useMemo(() => ({ toggle, observeChanges, state }), [observeChanges, state, toggle])
}
