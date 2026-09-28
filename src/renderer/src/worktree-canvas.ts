import type { Edge } from '@xyflow/react'
import type { TerminalNodeStatus } from '../../shared/terminal'
import {
  DEFAULT_WORKTREE_SIZE,
  isWorktreeCanvasChild,
  isWorktreeCanvasNode,
  NEW_SESSION_NODE_SIZE,
  sessionNodeStatus,
  WORKTREE_CHILD_GAP,
  type CanvasNode,
  type TerminalCanvasNode
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
  const children = new Map<string, TerminalCanvasNode[]>()
  for (const [worktreeId, members] of grouped) {
    const before = previous?.children.get(worktreeId)
    children.set(worktreeId, sameMembers(before, members) ? before : members)
  }
  return { main: sameMembers(previous?.main, main) ? previous.main : main, children }
}

export interface WorktreeCanvasEdges {
  main: Edge[]
  children: ReadonlyMap<string, Edge[]>
}

/**
 * An edge is drawn where both of its ends are. One whose ends sit on different canvases is not
 * drawn at all for now - it still exists, and still grants whatever it granted, because drawing is
 * all this decides.
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
  const children = new Map<string, Edge[]>()
  for (const [worktreeId, members] of grouped) {
    const before = previous?.children.get(worktreeId)
    children.set(worktreeId, sameMembers(before, members) ? before : members)
  }
  return { main: sameMembers(previous?.main, main) ? previous.main : main, children }
}

function renderedWidth(node: TerminalCanvasNode): number {
  return (
    node.measured?.width ?? (typeof node.style?.width === 'number' ? node.style.width : NEW_SESSION_NODE_SIZE.width)
  )
}

/**
 * Where the next chat goes on a worktree canvas: beside the rightmost one, level with the highest,
 * so "+ Codex" then "+ Claude" reads as two chats side by side. Coordinates are the inner canvas's.
 */
export function nextWorktreeChildPosition(children: readonly TerminalCanvasNode[]): { x: number; y: number } {
  if (children.length === 0) return { x: 0, y: 0 }
  return {
    x: Math.max(...children.map((node) => node.position.x + renderedWidth(node))) + WORKTREE_CHILD_GAP,
    y: Math.min(...children.map((node) => node.position.y))
  }
}

/**
 * A worktree gets room for a chat when one is added to it: one discovered, or saved before
 * worktrees held chats, is far too small to show one at a readable zoom. It only ever grows, and
 * only to the size a new worktree opens at.
 */
export function withRoomForChat(nodes: CanvasNode[], worktreeId: string): CanvasNode[] {
  const host = nodes.filter(isWorktreeCanvasNode).find((node) => node.data.worktreeId === worktreeId)
  if (!host) return nodes
  const width = host.measured?.width ?? (typeof host.style?.width === 'number' ? host.style.width : 0)
  const height = host.measured?.height ?? (typeof host.style?.height === 'number' ? host.style.height : 0)
  if (width >= DEFAULT_WORKTREE_SIZE.width && height >= DEFAULT_WORKTREE_SIZE.height) return nodes
  const style = {
    ...host.style,
    width: Math.max(width, DEFAULT_WORKTREE_SIZE.width),
    height: Math.max(height, DEFAULT_WORKTREE_SIZE.height)
  }
  return nodes.map((node) => (node === host ? { ...host, style } : node))
}

/** What a worktree's bottom row says about its chats. Agent state only - git state is the header's. */
export interface WorktreeActivity {
  chats: number
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
  return { chats: children.length, working, attention }
}
