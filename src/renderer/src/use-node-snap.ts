import type { Node, NodeChange, Viewport } from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'
import {
  NODE_FIT_INSET,
  canvasRegion,
  isMaximised,
  releaseSnaps,
  reflowSnappedNodesWithin,
  restoreSnappedNode,
  snapNode,
  snapNodePair,
  snapsReleasedByChanges,
  toggleNodeFit,
  type NodeGeometry,
  type SnapArrow,
  type SnapStates
} from './node-snap'

/**
 * The canvases beyond the main one - a worktree's canvas of chats is one. A node is on exactly one
 * canvas, and a snap is measured against that canvas's usable region in its own coordinates, so a
 * chat maximised inside a worktree fills the worktree, not the window.
 */
export interface NodeSnapCanvases<T extends Node> {
  /** Which canvas a node is on: null for the main canvas, otherwise the canvas's id. */
  canvasOf(node: T): string | null
  /** An inner canvas's usable region in its flow coordinates, or null while it has no room to show. */
  regionOf(canvas: string): NodeGeometry | null
}

export interface NodeSnapController<T extends Node> {
  /** Maximises a node, or restores it when it is the maximised one - the header action. */
  toggle(nodeId: string): void
  /** One Alt+Arrow press: on two ids the pair is placed side by side or stacked, otherwise the first steps through Windows Snap. */
  snap(ids: readonly string[], arrow: SnapArrow): void
  /**
   * Puts a snapped node back to where it was before its first snap, and returns the node array
   * that produced - for the same reason `release` does. A node that is not snapped is left alone.
   */
  restore(nodeId: string): T[]
  /**
   * Re-fits every node snapped on `canvas` (null for the main canvas) to that canvas's current
   * usable region: for an inner canvas whose host was resized, which no observer here can see.
   */
  reflow(canvas: string | null): void
  /**
   * Forgets the snap state of the given nodes (all when omitted) without moving them; for layouts
   * that place nodes themselves. Returns the released node array, which is the array such a layout
   * must start from: `getNodes` still reads the pre-release one until React has applied this
   * update, so a layout that re-read it would write the cleared `fittedToCanvas` flags straight
   * back on while `state()` reported nothing snapped - a header offering "restore" that maximises.
   */
  release(ids?: readonly string[]): T[]
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
  setNodes,
  canvases,
  onMaximisedChange
}: {
  canvasRef: RefObject<HTMLElement | null>
  getNodes: () => T[]
  getViewport: () => Viewport
  setNodes: (nodes: T[]) => void
  /** Absent means every node is on the main canvas. */
  canvases?: NodeSnapCanvases<T>
  /**
   * A node was maximised, or a maximised node stopped being so, by a layout action - `toggle`,
   * `snap` or `restore`. A drag or resize that merely releases the snap does not report: the node
   * is still where the user put it, so there is nothing to undo.
   */
  onMaximisedChange?(nodeId: string, maximised: boolean): void
}): NodeSnapController<T> {
  const snaps = useRef<SnapStates>({})
  const notify = useRef(onMaximisedChange)
  notify.current = onMaximisedChange

  const canvasOf = useCallback((node: T): string | null => canvases?.canvasOf(node) ?? null, [canvases])

  /** The usable region of `canvas`; the main one is measured here, an inner one is the caller's to know. */
  const regionOf = useCallback(
    (canvas: string | null): NodeGeometry | null => {
      if (canvas !== null) return canvases?.regionOf(canvas) ?? null
      const rect = canvasRef.current?.getBoundingClientRect()
      return rect ? canvasRegion(rect, getViewport(), NODE_FIT_INSET) : null
    },
    [canvasRef, canvases, getViewport]
  )

  /** Whether a node id is on `canvas`, over the nodes as they are now. */
  const membership = useCallback(
    (nodes: readonly T[], canvas: string | null): ((nodeId: string) => boolean) => {
      const members = new Set(nodes.filter((node) => canvasOf(node) === canvas).map((node) => node.id))
      return (nodeId) => members.has(nodeId)
    },
    [canvasOf]
  )

  /** A node's canvas region, and the test for whether another node shares that canvas. */
  const scope = useCallback(
    (nodeId: string): { region: NodeGeometry | null; within: (otherId: string) => boolean } => {
      const nodes = getNodes()
      const node = nodes.find((candidate) => candidate.id === nodeId)
      const canvas = node ? canvasOf(node) : null
      return { region: regionOf(canvas), within: membership(nodes, canvas) }
    },
    [canvasOf, getNodes, membership, regionOf]
  )

  const apply = useCallback(
    (result: { nodes: T[]; snaps: SnapStates }, report = false): void => {
      const before = snaps.current
      snaps.current = result.snaps
      setNodes(result.nodes)
      if (!report || !notify.current) return
      for (const id of new Set([...Object.keys(before), ...Object.keys(result.snaps)])) {
        const was = isMaximised(before[id])
        const is = isMaximised(result.snaps[id])
        if (was !== is) notify.current(id, is)
      }
    },
    [setNodes]
  )

  const toggle = useCallback(
    (nodeId: string): void => {
      const { region, within } = scope(nodeId)
      if (region) apply(toggleNodeFit(getNodes(), snaps.current, nodeId, region, NODE_FIT_INSET, within), true)
    },
    [apply, getNodes, scope]
  )

  const snap = useCallback(
    (ids: readonly string[], arrow: SnapArrow): void => {
      if (ids.length === 0) return
      const { region, within } = scope(ids[0])
      if (!region) return
      apply(
        ids.length === 2
          ? snapNodePair(getNodes(), snaps.current, [ids[0], ids[1]], arrow, region, NODE_FIT_INSET, within)
          : snapNode(getNodes(), snaps.current, ids[0], arrow, region, NODE_FIT_INSET, within),
        true
      )
    },
    [apply, getNodes, scope]
  )

  const restore = useCallback(
    (nodeId: string): T[] => {
      const nodes = getNodes()
      const result = restoreSnappedNode(nodes, snaps.current, nodeId)
      if (result.nodes !== nodes) apply(result, true)
      return result.nodes
    },
    [apply, getNodes]
  )

  const reflow = useCallback(
    (canvas: string | null): void => {
      const region = regionOf(canvas)
      if (!region) return
      const nodes = getNodes()
      const reflowed = reflowSnappedNodesWithin(nodes, snaps.current, region, NODE_FIT_INSET, membership(nodes, canvas))
      if (reflowed !== nodes) setNodes(reflowed)
    },
    [getNodes, membership, regionOf, setNodes]
  )

  const release = useCallback(
    (ids: readonly string[] = Object.keys(snaps.current)): T[] => {
      const result = releaseSnaps(getNodes(), snaps.current, ids)
      apply(result)
      return result.nodes
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
    // A canvas with no room for the inset (hidden, or not yet laid out) is ignored rather than
    // collapsing the nodes onto it.
    const observer = new ResizeObserver(() => {
      const { width, height } = canvas.getBoundingClientRect()
      if (width > NODE_FIT_INSET * 2 && height > NODE_FIT_INSET * 2) reflow(null)
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [canvasRef, reflow])

  return useMemo(
    () => ({ toggle, snap, release, restore, reflow, observeChanges, state }),
    [observeChanges, reflow, release, restore, snap, state, toggle]
  )
}
