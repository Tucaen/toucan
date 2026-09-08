/**
 * Layout commands that place nodes themselves - tiling, matching sizes, and remembered
 * arrangements - plus the keys that reach them and snap. Snap itself lives in `node-snap.ts`.
 */
import type { Node } from '@xyflow/react'
import type { WorkspaceLayoutSlot } from '../../shared/terminal'
import { nodeAtGeometry, renderedNodeGeometry, type NodeGeometry, type SnapArrow } from './node-snap'

export type TileMode = 'grid' | 'columns' | 'rows'
export const TILE_MODES: readonly TileMode[] = ['grid', 'columns', 'rows']

export function nextTileMode(mode: TileMode): TileMode {
  return TILE_MODES[(TILE_MODES.indexOf(mode) + 1) % TILE_MODES.length]
}

export type LayoutKeyAction =
  | { kind: 'snap'; arrow: SnapArrow }
  | { kind: 'match-size' }
  | { kind: 'tile' }
  | { kind: 'slot-save'; slot: number }
  | { kind: 'slot-restore'; slot: number }
  | { kind: 'none' }

/** The subset of `KeyboardEvent` the layout shortcuts read, so callers can test without a DOM. */
export interface LayoutShortcutKey {
  key: string
  code: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  repeat: boolean
}

export interface LayoutKeyContext {
  /** Whether the key went to an input, textarea or editable element, where Alt+Arrow moves the caret. */
  editingText: boolean
}

const ARROWS: Readonly<Record<string, SnapArrow>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down'
}

/** Shown in tooltips so the keys are discoverable where the mouse already is. */
export const LAYOUT_SHORTCUT_LABELS = {
  fit: 'Alt+↑',
  restore: 'Alt+↓',
  tile: 'Ctrl+Shift+A'
} as const

/**
 * Alt is the layout modifier: Ctrl plus a letter is taken by node creation, and Ctrl+Alt is AltGr
 * on German layouts. Alt+Arrow snaps, Alt+Shift+S matches sizes, Alt(+Shift)+digit restores
 * (saves) a slot; Ctrl+Shift+A tiles, next to Ctrl+Shift+T/B/K. A held key repeats the event and
 * would otherwise step a snap several times, so only the first press counts. Text fields keep
 * Alt+Arrow for the caret; the digit and tile keys mean nothing there and are taken anyway.
 */
export function layoutKeyAction(event: LayoutShortcutKey, context: LayoutKeyContext): LayoutKeyAction {
  if (event.metaKey || event.repeat) return { kind: 'none' }
  if (event.altKey && !event.ctrlKey) {
    const arrow = ARROWS[event.key]
    if (arrow) return event.shiftKey || context.editingText ? { kind: 'none' } : { kind: 'snap', arrow }
    // `code` rather than `key`: Shift+1 is '!' on every layout, and '1' is a different key on some.
    const digit = /^Digit([1-9])$/.exec(event.code)
    if (digit) {
      const slot = Number(digit[1])
      return event.shiftKey ? { kind: 'slot-save', slot } : { kind: 'slot-restore', slot }
    }
    if (event.shiftKey && event.code === 'KeyS' && !context.editingText) return { kind: 'match-size' }
    return { kind: 'none' }
  }
  if (event.ctrlKey && event.shiftKey && !event.altKey && event.key.toLocaleLowerCase() === 'a') return { kind: 'tile' }
  return { kind: 'none' }
}

/**
 * Lays the given nodes into the region: grid as square as possible, columns side by side, rows
 * stacked. Reading order follows current position - top to bottom, then left to right - so a node
 * keeps rough neighbours. Nodes not in `ids` and nodes without geometry are left alone.
 */
export function tileNodes<T extends Node>(
  nodes: T[],
  ids: readonly string[],
  mode: TileMode,
  region: NodeGeometry,
  gap: number
): T[] {
  const wanted = new Set(ids)
  const targets = nodes
    .filter((node) => wanted.has(node.id) && renderedNodeGeometry(node))
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
  if (targets.length === 0) return nodes
  const columns = mode === 'columns' ? targets.length : mode === 'rows' ? 1 : Math.ceil(Math.sqrt(targets.length))
  const rows = Math.ceil(targets.length / columns)
  const cellWidth = (region.width - gap * (columns - 1)) / columns
  const cellHeight = (region.height - gap * (rows - 1)) / rows
  const placed = new Map<string, NodeGeometry>()
  targets.forEach((node, index) => {
    placed.set(node.id, {
      position: {
        x: region.position.x + (index % columns) * (cellWidth + gap),
        y: region.position.y + Math.floor(index / columns) * (cellHeight + gap)
      },
      width: cellWidth,
      height: cellHeight
    })
  })
  return nodes.map((node) => {
    const geometry = placed.get(node.id)
    return geometry ? nodeAtGeometry(node, geometry) : node
  })
}

/** Every node in `ids` takes the size of the first one, which is the node selected first. */
export function matchNodeSizes<T extends Node>(nodes: T[], ids: readonly string[]): T[] {
  const lead = nodes.find((node) => node.id === ids[0])
  const size = lead ? renderedNodeGeometry(lead) : null
  if (!size || ids.length < 2) return nodes
  const following = new Set(ids.slice(1))
  return nodes.map((node) => {
    const geometry = following.has(node.id) ? renderedNodeGeometry(node) : null
    return geometry ? nodeAtGeometry(node, { ...geometry, width: size.width, height: size.height }) : node
  })
}

/** Where every node is right now, keyed by id; the shape the workspace snapshot stores. */
export function captureLayoutSlot(nodes: readonly Node[]): WorkspaceLayoutSlot {
  const slot: WorkspaceLayoutSlot = {}
  for (const node of nodes) {
    const geometry = renderedNodeGeometry(node)
    if (geometry)
      slot[node.id] = { x: geometry.position.x, y: geometry.position.y, width: geometry.width, height: geometry.height }
  }
  return slot
}

/** Nodes the slot never saw are left alone; nodes it saw that are gone are skipped. */
export function applyLayoutSlot<T extends Node>(nodes: T[], slot: WorkspaceLayoutSlot): T[] {
  return nodes.map((node) => {
    const saved = slot[node.id]
    return saved
      ? nodeAtGeometry(node, { position: { x: saved.x, y: saved.y }, width: saved.width, height: saved.height })
      : node
  })
}

/** Slots whose every node is gone are dropped, so a stale workspace does not keep empty numbers alive. */
export function pruneLayoutSlots(
  slots: Readonly<Record<string, WorkspaceLayoutSlot>>,
  liveNodeIds: ReadonlySet<string>
): Record<string, WorkspaceLayoutSlot> {
  const pruned: Record<string, WorkspaceLayoutSlot> = {}
  for (const [number, slot] of Object.entries(slots)) {
    const kept = Object.fromEntries(Object.entries(slot).filter(([nodeId]) => liveNodeIds.has(nodeId)))
    if (Object.keys(kept).length > 0) pruned[number] = kept
  }
  return pruned
}
