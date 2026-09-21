import { deepEqual, equal } from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyLayoutSlot,
  canvasOverlayOpen,
  captureLayoutSlot,
  layoutKeyAction,
  matchNodeSizes,
  nextTileMode,
  pruneLayoutSlots,
  tileNodes,
  type CanvasOverlays,
  type LayoutShortcutKey
} from '../src/renderer/src/canvas-layout'

const region = { position: { x: 16, y: 16 }, width: 968, height: 668 }

function nodes(): {
  id: string
  position: { x: number; y: number }
  data: Record<string, unknown>
  style: { width: number; height: number }
}[] {
  return [
    { id: 'a', position: { x: 600, y: 10 }, data: {}, style: { width: 300, height: 200 } },
    { id: 'b', position: { x: 10, y: 20 }, data: {}, style: { width: 500, height: 400 } },
    { id: 'c', position: { x: 10, y: 500 }, data: {}, style: { width: 200, height: 100 } }
  ]
}

function key(overrides: Partial<LayoutShortcutKey> = {}): LayoutShortcutKey {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: true,
    metaKey: false,
    repeat: false,
    ...overrides
  }
}

test('Alt+Arrow snaps from a focused textarea but not other text fields; Alt+Shift+Arrow is nothing', () => {
  const textarea = { editingText: true, editingTextarea: true }
  const input = { editingText: true, editingTextarea: false }
  const canvas = { editingText: false, editingTextarea: false }
  deepEqual(layoutKeyAction(key({ key: 'ArrowLeft' }), canvas), { kind: 'snap', arrow: 'left' })
  deepEqual(layoutKeyAction(key({ key: 'ArrowUp' }), canvas), { kind: 'snap', arrow: 'up' })
  deepEqual(layoutKeyAction(key({ key: 'ArrowLeft' }), textarea), { kind: 'snap', arrow: 'left' })
  deepEqual(layoutKeyAction(key({ key: 'ArrowLeft' }), input), { kind: 'none' })
  deepEqual(layoutKeyAction(key({ key: 'ArrowLeft', shiftKey: true }), canvas), { kind: 'none' })
  deepEqual(layoutKeyAction(key({ key: 'ArrowLeft', repeat: true }), canvas), { kind: 'none' })
  deepEqual(layoutKeyAction(key({ key: 'ArrowLeft', ctrlKey: true }), canvas), { kind: 'none' })
  deepEqual(layoutKeyAction(key({ key: 'ArrowLeft', altKey: false }), canvas), { kind: 'none' })
})

test('digits pick slots by physical key, Shift saves, and the rest of the keys', () => {
  const canvas = { editingText: false, editingTextarea: false }
  deepEqual(layoutKeyAction(key({ key: '3', code: 'Digit3' }), canvas), { kind: 'slot-restore', slot: 3 })
  // Shift+1 types '!' on every layout; the physical key still names the slot.
  deepEqual(layoutKeyAction(key({ key: '!', code: 'Digit1', shiftKey: true }), canvas), { kind: 'slot-save', slot: 1 })
  deepEqual(layoutKeyAction(key({ key: '0', code: 'Digit0' }), canvas), { kind: 'none' })
  deepEqual(layoutKeyAction(key({ key: 'S', code: 'KeyS', shiftKey: true }), canvas), { kind: 'match-size' })
  deepEqual(layoutKeyAction(key({ key: 's', code: 'KeyS' }), canvas), { kind: 'none' })
  deepEqual(layoutKeyAction(key({ key: 'A', altKey: false, ctrlKey: true, shiftKey: true }), canvas), { kind: 'tile' })
  deepEqual(layoutKeyAction(key({ key: 'a', altKey: false, ctrlKey: true }), canvas), { kind: 'none' })
  deepEqual(layoutKeyAction(key({ key: 'A', ctrlKey: true, shiftKey: true }), canvas), { kind: 'none' })
})

test('tile modes cycle grid, columns, rows', () => {
  equal(nextTileMode('grid'), 'columns')
  equal(nextTileMode('columns'), 'rows')
  equal(nextTileMode('rows'), 'grid')
})

test('grid tiling fills the region in reading order of the current positions', () => {
  const tiled = tileNodes(nodes(), ['a', 'b', 'c'], 'grid', region, 16)
  const cellWidth = (968 - 16) / 2
  const cellHeight = (668 - 16) / 2
  // Two columns, two rows: a (y 10) then b (y 20) on the first row, c below.
  deepEqual(tiled[0].position, { x: 16, y: 16 })
  deepEqual(tiled[1].position, { x: 16 + cellWidth + 16, y: 16 })
  deepEqual(tiled[2].position, { x: 16, y: 16 + cellHeight + 16 })
  deepEqual(tiled[2].style, { width: cellWidth, height: cellHeight })
})

test('columns and rows tile only the named nodes and leave the rest alone', () => {
  const all = nodes()
  const columns = tileNodes(all, ['a', 'b'], 'columns', region, 16)
  deepEqual(columns[0].style, { width: (968 - 16) / 2, height: 668 })
  equal(columns[2], all[2])

  const rows = tileNodes(all, ['b', 'c'], 'rows', region, 16)
  deepEqual(rows[1].position, { x: 16, y: 16 })
  deepEqual(rows[1].style, { width: 968, height: (668 - 16) / 2 })
  deepEqual(rows[2].position, { x: 16, y: 16 + (668 - 16) / 2 + 16 })
  equal(rows[0], all[0])
  equal(tileNodes(all, [], 'grid', region, 16), all)
})

test('matching sizes copies the first selected size onto the others and keeps positions', () => {
  const matched = matchNodeSizes(nodes(), ['b', 'a', 'c'])
  deepEqual(matched[0].style, { width: 500, height: 400 })
  deepEqual(matched[0].position, { x: 600, y: 10 })
  deepEqual(matched[2].style, { width: 500, height: 400 })
  equal(matched[1].style.width, 500)
  const alone = nodes()
  equal(matchNodeSizes(alone, ['a']), alone)
})

test('a slot captures every node and restores the ones still present', () => {
  const slot = captureLayoutSlot(nodes())
  deepEqual(slot.a, { x: 600, y: 10, width: 300, height: 200 })

  const moved = tileNodes(nodes(), ['a', 'b', 'c'], 'rows', region, 16).filter((node) => node.id !== 'c')
  const extra = { id: 'd', position: { x: 1, y: 1 }, data: {}, style: { width: 5, height: 5 } }
  const restored = applyLayoutSlot([...moved, extra], slot)
  deepEqual(restored[0].position, { x: 600, y: 10 })
  deepEqual(restored[1].style, { width: 500, height: 400 })
  equal(restored[2], extra)
})

test('pruning drops ids that are gone and slots left with nothing', () => {
  const slots = { '1': captureLayoutSlot(nodes()), '2': { gone: { x: 0, y: 0, width: 1, height: 1 } } }
  const pruned = pruneLayoutSlots(slots, new Set(['a', 'c']))
  deepEqual(Object.keys(pruned), ['1'])
  deepEqual(Object.keys(pruned['1']).sort(), ['a', 'c'])
})

test('every surface that covers the canvas gates the shortcuts, one by one', () => {
  // The bug this guards: the project settings dialog and the sidebar's context menu were missing
  // from the expression this replaced, so Ctrl+N put a node on the canvas behind the modal.
  const closed: CanvasOverlays = {
    filePicker: false,
    conversationHistory: false,
    worktreeDraft: false,
    worktreeRemoval: false,
    remoteAccess: false,
    adapterManagement: false,
    projectSettings: false,
    projectMenu: false
  }
  equal(canvasOverlayOpen(closed), false)
  for (const surface of Object.keys(closed) as (keyof CanvasOverlays)[]) {
    equal(canvasOverlayOpen({ ...closed, [surface]: true }), true, surface)
  }
})
