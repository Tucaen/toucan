import type { Node, NodeChange, Viewport } from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'
import {
  NODE_FIT_INSET,
  canvasRegion,
  releaseSnaps,
  reflowSnappedNodes,
  snapNode,
  snapNodePair,
  snapsReleasedByChanges,
  toggleNodeFit,
  type SnapArrow,
  type SnapStates
} from './node-snap'

export interface NodeSnapController<T extends Node> {
  /** Maximises a node, or restores it when it is the maximised one - the header action. */
  toggle(nodeId: string): void
  /** One Alt+Arrow press: on two ids the pair is placed side by side or stacked, otherwise the first steps through Windows Snap. */
  snap(ids: readonly string[], arrow: SnapArrow): void
  /** Forgets the snap state of the given nodes (all when omitted) without moving them; for layouts that place nodes themselves. */
  release(ids?: readonly string[]): void
  /**
   * Must see every React Flow node change before it is applied: a drag or manual resize of a
   * snapped node releases it, and a removed node takes its snap state with it.
   */
  observeChanges(changes: NodeChange<T>[]): void
  /**
   * Every snapped node by id. Persistence and the recently-closed capture must serialize the
   * maximised node at its restore geometry instead of filling the canvas.
   */
  state(): SnapStates
}

/**
 * Owns snap mode for the whole canvas: which nodes are snapped where, the geometry a restore
 * returns each to, and keeping them on the usable canvas as the canvas changes.
 *
 * The usable canvas is observed rather than derived: the canvas region is a layout sibling of the
 * project sidebar and the docked panels, so one `ResizeObserver` on it covers an application
 * resize, a sidebar collapse, and a panel opening or being dragged - and never touches the React
 * Flow viewport while doing it.
 *
 * Snap state is a ref rather than React state because nothing renders from it; the node's own
 * `fittedToCanvas` data flag is what the header action reads. It is also written eagerly, before
 * the node list update it belongs to has been applied, because `state()` has to be truthful
 * within the same tick: the removal path reads it to serialize a closing node's pre-fit geometry.
 * That is why the node updates here are whole arrays read through `getNodes` rather than
 * functional updates - the caller must funnel every node change through one place.
 */
export function useNodeSnap<T extends Node>({
  canvasRef,
  getNodes,
  getViewport,
  setNodes
}: {
  canvasRef: RefObject<HTMLElement | null>
  getNodes: () => T[]
  getViewport: () => Viewport
  setNodes: (nodes: T[]) => void
}): NodeSnapController<T> {
  const snaps = useRef<SnapStates>({})

  const region = useCallback(() => {
    const canvas = canvasRef.current?.getBoundingClientRect()
    return canvas ? canvasRegion(canvas, getViewport(), NODE_FIT_INSET) : null
  }, [canvasRef, getViewport])

  const apply = useCallback(
    (result: { nodes: T[]; snaps: SnapStates }): void => {
      snaps.current = result.snaps
      setNodes(result.nodes)
    },
    [setNodes]
  )

  const toggle = useCallback(
    (nodeId: string): void => {
      const rect = region()
      if (rect) apply(toggleNodeFit(getNodes(), snaps.current, nodeId, rect, NODE_FIT_INSET))
    },
    [apply, getNodes, region]
  )

  const snap = useCallback(
    (ids: readonly string[], arrow: SnapArrow): void => {
      const rect = region()
      if (!rect || ids.length === 0) return
      apply(
        ids.length === 2
          ? snapNodePair(getNodes(), snaps.current, [ids[0], ids[1]], arrow, rect, NODE_FIT_INSET)
          : snapNode(getNodes(), snaps.current, ids[0], arrow, rect, NODE_FIT_INSET)
      )
    },
    [apply, getNodes, region]
  )

  const release = useCallback(
    (ids: readonly string[] = Object.keys(snaps.current)): void => {
      apply(releaseSnaps(getNodes(), snaps.current, ids))
    },
    [apply, getNodes]
  )

  const observeChanges = useCallback(
    (changes: NodeChange<T>[]): void => {
      const released = snapsReleasedByChanges(changes, snaps.current)
      // The geometry the user just produced is theirs to keep; only the pending restore is dropped.
      // A removed node needs no flag cleared, and React Flow is about to drop it anyway.
      if (released.length > 0) apply(releaseSnaps(getNodes(), snaps.current, released))
    },
    [apply, getNodes]
  )

  const state = useCallback((): SnapStates => snaps.current, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => {
      if (Object.keys(snaps.current).length === 0) return
      setNodes(
        reflowSnappedNodes(getNodes(), snaps.current, canvas.getBoundingClientRect(), getViewport(), NODE_FIT_INSET)
      )
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [canvasRef, getNodes, getViewport, setNodes])

  return useMemo(
    () => ({ toggle, snap, release, observeChanges, state }),
    [observeChanges, release, snap, state, toggle]
  )
}
