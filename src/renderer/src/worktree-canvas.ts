import type { Edge } from '@xyflow/react'
import type { TerminalNodeStatus } from '../../shared/terminal'
import {
  COLLAPSED_WORKTREE_HEIGHT,
  DEFAULT_WORKTREE_SIZE,
  isWorktreeCanvasChild,
  isWorktreeCanvasNode,
  measured,
  NEW_SESSION_NODE_SIZE,
  sessionNodeStatus,
  WORKTREE_CHILD_GAP,
  type CanvasNode,
  type TerminalCanvasNode,
  type WorktreeCanvasNode
} from './canvas-workspace'

/**
 * Which canvas each node is shown on. There is one workspace node set - `App`'s - and every
 * worktree's inner canvas is a *view* of it, never a copy: membership is derived here from the
 * attachment (`isWorktreeCanvasChild`), and every change an inner canvas makes goes back into that
 * one set. Partitioning rather than filtering per canvas is what makes "shown exactly once" true by
 * construction - a node lands in exactly one of `main` and the worktree lists.
 */
export interface WorktreeCanvasPartition {
  /** What the main canvas shows: everything that is not a worktree's child. */
  main: CanvasNode[]
  /** Each worktree's children by worktree id; every worktree on the canvas has an entry, if empty. */
  children: ReadonlyMap<string, TerminalCanvasNode[]>
}

function sameMembers<T>(previous: readonly T[] | undefined, next: readonly T[]): previous is T[] {
  return !!previous && previous.length === next.length && previous.every((item, index) => item === next[index])
}

/** One canvas-by-canvas grouping, keeping every array whose members are unchanged since `previous`. */
function reuseUnchanged<T>(
  main: T[],
  grouped: ReadonlyMap<string, T[]>,
  previous?: { main: T[]; children: ReadonlyMap<string, T[]> }
): { main: T[]; children: Map<string, T[]> } {
  const children = new Map<string, T[]>()
  for (const [worktreeId, members] of grouped) {
    const before = previous?.children.get(worktreeId)
    children.set(worktreeId, sameMembers(before, members) ? before : members)
  }
  return { main: sameMembers(previous?.main, main) ? previous.main : main, children }
}

/**
 * `previous` lets an unchanged canvas keep the same array. Each inner canvas is its own React Flow,
 * fed a `nodes` prop; handing it a fresh array on every drag elsewhere would make every worktree
 * re-adopt its children on every pointer frame.
 */
export function partitionWorktreeCanvases(
  nodes: readonly CanvasNode[],
  previous?: WorktreeCanvasPartition
): WorktreeCanvasPartition {
  const hosts = new Set(nodes.filter(isWorktreeCanvasNode).map((node) => node.data.worktreeId))
  const main: CanvasNode[] = []
  const grouped = new Map<string, TerminalCanvasNode[]>([...hosts].map((worktreeId) => [worktreeId, []]))
  for (const node of nodes) {
    // A chat whose worktree node is not on the canvas stays on the main one: shown somewhere is
    // always better than shown nowhere.
    const host = isWorktreeCanvasChild(node) ? grouped.get(node.data.worktreeId!) : undefined
    if (host && isWorktreeCanvasChild(node)) host.push(node)
    else main.push(node)
  }
  const { main: kept, children } = reuseUnchanged<CanvasNode>(main, grouped, previous)
  return { main: kept, children: children as Map<string, TerminalCanvasNode[]> }
}

export interface WorktreeCanvasEdges {
  main: Edge[]
  children: ReadonlyMap<string, Edge[]>
}

/**
 * An edge is drawn where both of its ends are, and one whose ends sit on different canvases is not
 * drawn at all. Drawing is all this decides; `App` revokes a terminal-context edge that ends up
 * here rather than leave a grant nobody can see.
 */
export function splitWorktreeCanvasEdges(
  edges: readonly Edge[],
  partition: WorktreeCanvasPartition,
  previous?: WorktreeCanvasEdges
): WorktreeCanvasEdges {
  const canvasOf = new Map<string, string | null>(partition.main.map((node) => [node.id, null]))
  for (const [worktreeId, members] of partition.children) {
    for (const node of members) canvasOf.set(node.id, worktreeId)
  }
  const main: Edge[] = []
  const grouped = new Map<string, Edge[]>([...partition.children.keys()].map((worktreeId) => [worktreeId, []]))
  for (const edge of edges) {
    const source = canvasOf.get(edge.source)
    const target = canvasOf.get(edge.target)
    if (source === undefined || source !== target) continue
    if (source === null) main.push(edge)
    else grouped.get(source)!.push(edge)
  }
  return reuseUnchanged(main, grouped, previous)
}

/** A worktree's chats, read from any node list - including one a render has not caught up with. */
export function worktreeChildren(nodes: readonly CanvasNode[], worktreeId: string): TerminalCanvasNode[] {
  return nodes.filter(isWorktreeCanvasChild).filter((node) => node.data.worktreeId === worktreeId)
}

/**
 * Where the next chat goes on a worktree canvas: beside the rightmost one, level with the highest,
 * so "+ Codex" then "+ Claude" reads as two chats side by side. Coordinates are the inner canvas's.
 */
export function nextWorktreeChildPosition(children: readonly TerminalCanvasNode[]): { x: number; y: number } {
  if (children.length === 0) return { x: 0, y: 0 }
  return {
    x:
      Math.max(...children.map((node) => node.position.x + measured(node, NEW_SESSION_NODE_SIZE).width)) +
      WORKTREE_CHILD_GAP,
    y: Math.min(...children.map((node) => node.position.y))
  }
}

/**
 * A worktree gets room for a chat when one is added to it: one discovered, or saved before
 * worktrees held chats, is far too small to show one at a readable zoom. It only ever grows, and
 * only to the size a new worktree opens at.
 */
export function withRoomForChat(nodes: CanvasNode[], worktreeId: string): CanvasNode[] {
  const host = worktreeHost(nodes, worktreeId)
  if (!host) return nodes
  const { width, height } = measured(host, { width: 0, height: 0 })
  if (width >= DEFAULT_WORKTREE_SIZE.width && height >= DEFAULT_WORKTREE_SIZE.height) return nodes
  const style = {
    ...host.style,
    width: Math.max(width, DEFAULT_WORKTREE_SIZE.width),
    height: Math.max(height, DEFAULT_WORKTREE_SIZE.height)
  }
  return nodes.map((node) => (node === host ? { ...host, style } : node))
}

/** A worktree shown as its header and bottom row only. Its chats are mounted and running, out of view. */
export function isCollapsedWorktree(node: CanvasNode): node is WorktreeCanvasNode {
  return isWorktreeCanvasNode(node) && node.data.collapsed === true
}

/** The worktree node hosting `worktreeId`, if it is on the canvas. */
export function worktreeHost(nodes: readonly CanvasNode[], worktreeId: string): WorktreeCanvasNode | undefined {
  return nodes.filter(isWorktreeCanvasNode).find((node) => node.data.worktreeId === worktreeId)
}

/** The node at `height`, wherever React Flow reads a height from - see `nodeAtGeometry`. */
function worktreeAtHeight(node: WorktreeCanvasNode, height: number): WorktreeCanvasNode {
  return {
    ...node,
    ...(node.height !== undefined ? { height } : {}),
    style: { ...node.style, height },
    measured: { ...node.measured, height }
  }
}

/**
 * Collapses a worktree to its chrome: header and bottom row. It is a change of the node's height,
 * nothing else - its canvas and every chat on it stay mounted, so no session is disturbed - and
 * the height it had is kept on the node to expand back to and to be saved as its size. Already
 * collapsed, or not on the canvas: the same array.
 */
export function collapseWorktree(nodes: CanvasNode[], worktreeId: string): CanvasNode[] {
  const host = worktreeHost(nodes, worktreeId)
  if (!host || host.data.collapsed) return nodes
  const { height } = measured(host, DEFAULT_WORKTREE_SIZE)
  const collapsed = worktreeAtHeight(
    { ...host, data: { ...host.data, collapsed: true, expandedHeight: height } },
    COLLAPSED_WORKTREE_HEIGHT
  )
  return nodes.map((node) => (node === host ? collapsed : node))
}

/** The inverse of `collapseWorktree`: back to the height it had. Not collapsed: the same array. */
export function expandWorktree(nodes: CanvasNode[], worktreeId: string): CanvasNode[] {
  const host = worktreeHost(nodes, worktreeId)
  if (!host || !host.data.collapsed) return nodes
  const { collapsed: _collapsed, expandedHeight, ...data } = host.data
  const expanded = worktreeAtHeight({ ...host, data }, expandedHeight ?? DEFAULT_WORKTREE_SIZE.height)
  return nodes.map((node) => (node === host ? expanded : node))
}

/**
 * The arrangement a layout slot should remember: every collapsed worktree at the height it expands
 * back to, since collapse is a view of the worktree and the slot is an arrangement. Nothing else
 * changes, and the nodes are for capture only - they are never rendered.
 */
export function layoutGeometry(nodes: readonly CanvasNode[]): CanvasNode[] {
  return nodes.map((node) =>
    isCollapsedWorktree(node) ? worktreeAtHeight(node, node.data.expandedHeight ?? DEFAULT_WORKTREE_SIZE.height) : node
  )
}

/**
 * The inverse, after a slot has placed the nodes: a worktree that is collapsed keeps its chrome
 * height and takes the slot's height as the one it expands back to, so restoring an arrangement
 * neither unfolds a collapsed worktree nor squashes an expanded one to a collapsed height.
 */
export function keepCollapsed(nodes: CanvasNode[]): CanvasNode[] {
  return nodes.map((node) => {
    if (!isCollapsedWorktree(node)) return node
    const { height } = measured(node, DEFAULT_WORKTREE_SIZE)
    if (height === COLLAPSED_WORKTREE_HEIGHT) return node
    return worktreeAtHeight({ ...node, data: { ...node.data, expandedHeight: height } }, COLLAPSED_WORKTREE_HEIGHT)
  })
}

/** What a worktree's bottom row says about its chats. Agent state only - git state is the header's. */
export interface WorktreeActivity {
  working: number
  attention: number
}

export function worktreeActivity(
  children: readonly TerminalCanvasNode[],
  statuses: Readonly<Record<string, TerminalNodeStatus>>
): WorktreeActivity {
  let working = 0
  let attention = 0
  for (const node of children) {
    const status = sessionNodeStatus(node, statuses)
    if (status === 'working') working += 1
    else if (status === 'attention') attention += 1
  }
  return { working, attention }
}

/**
 * Each canvas is its own React Flow, and each keeps its own selection and listens for Delete on
 * the whole document - so a chat picked in one worktree would stay selected while something is
 * picked in another, and one Delete would close both. Picking anything therefore clears the
 * selection on every other canvas, which is what a single canvas always did. A worktree's frame is
 * on the main canvas, like any other node there.
 *
 * `canvas` is where the pick happened: a worktree id, or null for the main canvas. Returns the same
 * array when nothing needed clearing.
 */
export function selectOnlyWithinCanvas(nodes: CanvasNode[], canvas: string | null): CanvasNode[] {
  const outside = (node: CanvasNode): boolean =>
    node.selected === true && (isWorktreeCanvasChild(node) ? node.data.worktreeId! : null) !== canvas
  if (!nodes.some(outside)) return nodes
  return nodes.map((node) => (outside(node) ? { ...node, selected: false } : node))
}
