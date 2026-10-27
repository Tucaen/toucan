import { deepEqual, equal } from 'node:assert/strict'
import type { NodeChange } from '@xyflow/react'
import { test } from 'vitest'
import {
  MAXIMISED,
  canvasRegion,
  hydrateSnaps,
  nextSnapSlice,
  nodeBeforeTemporaryFit,
  nodesWithMaximisedFits,
  persistedSnapSlice,
  reflowSnappedNodes,
  reflowSnappedNodesWithin,
  releaseSnaps,
  restoreSnappedNode,
  sliceGeometry,
  snapNode,
  snapNodePair,
  snapNodeToSlice,
  snapsReleasedByChanges,
  toggleNodeFit,
  viewportShowingNode,
  type DragOrigins,
  type SnapSlice,
  type SnapStates
} from '../src/renderer/src/node-snap'

const canvas = { width: 1000, height: 700 }
const viewport = { x: 0, y: 0, zoom: 1 }
const region = canvasRegion(canvas, viewport, 16)

function nodes(): {
  id: string
  position: { x: number; y: number }
  data: { fittedToCanvas?: boolean }
  style: { width: number; height: number }
}[] {
  return [
    { id: 'a', position: { x: 10, y: 20 }, data: {}, style: { width: 300, height: 200 } },
    { id: 'b', position: { x: 400, y: 60 }, data: {}, style: { width: 500, height: 400 } }
  ]
}

test('the region is the panned, zoomed visible canvas in flow coordinates', () => {
  deepEqual(canvasRegion({ width: 1000, height: 700 }, { x: -200, y: 80, zoom: 1 }, 16), {
    position: { x: 216, y: -64 },
    width: 968,
    height: 668
  })
  deepEqual(canvasRegion({ width: 900, height: 600 }, { x: 120, y: -60, zoom: 1.5 }, 18), {
    position: { x: -68, y: 52 },
    width: 576,
    height: 376
  })
  // The inset is applied in screen pixels before converting.
  deepEqual(canvasRegion({ width: 640, height: 480 }, { x: 0, y: 0, zoom: 0.5 }, 20), {
    position: { x: 40, y: 40 },
    width: 1200,
    height: 880
  })
})

test('slices split the region in half with the inset as the gap', () => {
  deepEqual(sliceGeometry(region, { h: 'left', v: 'full' }, 16), {
    position: { x: 16, y: 16 },
    width: 476,
    height: 668
  })
  deepEqual(sliceGeometry(region, { h: 'right', v: 'bottom' }, 16), {
    position: { x: 16 + 476 + 16, y: 16 + 326 + 16 },
    width: 476,
    height: 326
  })
  deepEqual(sliceGeometry(region, MAXIMISED, 16), region)
})

test('arrows step through Windows Snap: halves, quarters, maximise, restore', () => {
  const walk = (start: SnapSlice | null, ...arrows: Parameters<typeof nextSnapSlice>[1][]): SnapSlice | null =>
    arrows.reduce<SnapSlice | null>(
      (slice, arrow) => (slice === null && start !== null ? null : nextSnapSlice(slice, arrow)),
      start
    )

  deepEqual(nextSnapSlice(null, 'left'), { h: 'left', v: 'full' })
  deepEqual(nextSnapSlice(null, 'up'), MAXIMISED)
  equal(nextSnapSlice(null, 'down'), null)
  deepEqual(walk(null, 'left', 'up'), { h: 'left', v: 'top' })
  deepEqual(walk(null, 'left', 'up', 'down'), { h: 'left', v: 'full' })
  deepEqual(walk(null, 'left', 'down'), { h: 'left', v: 'bottom' })
  deepEqual(walk(null, 'left', 'right'), { h: 'full', v: 'full' })
  deepEqual(walk(null, 'right', 'left'), { h: 'full', v: 'full' })
  deepEqual(walk(null, 'left', 'left'), { h: 'left', v: 'full' })
  equal(walk(null, 'up', 'down'), null)
  equal(walk(null, 'left', 'down', 'down'), null)
  deepEqual(walk(null, 'up', 'left'), { h: 'left', v: 'full' })
})

test('snapping records the pre-snap geometry once and restoring returns to it', () => {
  const first = snapNode(nodes(), {}, 'a', 'left', region, 16)
  deepEqual(first.snaps.a, {
    h: 'left',
    v: 'full',
    restoreGeometry: { position: { x: 10, y: 20 }, width: 300, height: 200 }
  })
  deepEqual(first.nodes[0].position, { x: 16, y: 16 })
  deepEqual(first.nodes[0].style, { width: 476, height: 668 })

  const quarter = snapNode(first.nodes, first.snaps, 'a', 'up', region, 16)
  deepEqual(quarter.snaps.a.restoreGeometry, first.snaps.a.restoreGeometry)
  deepEqual(quarter.nodes[0].style, { width: 476, height: 326 })

  // Top quarter → half → bottom quarter → restore, as on Windows.
  const half = snapNode(quarter.nodes, quarter.snaps, 'a', 'down', region, 16)
  const bottom = snapNode(half.nodes, half.snaps, 'a', 'down', region, 16)
  equal(bottom.snaps.a.v, 'bottom')
  const restored = snapNode(bottom.nodes, bottom.snaps, 'a', 'down', region, 16)
  deepEqual(restored.snaps, {})
  deepEqual(restored.nodes[0].position, { x: 10, y: 20 })
  deepEqual(restored.nodes[0].style, { width: 300, height: 200 })
})

test('an arrow snap never touches another node, even one already in the same slice', () => {
  const first = snapNode(nodes(), {}, 'a', 'left', region, 16)
  const second = snapNode(first.nodes, first.snaps, 'b', 'left', region, 16)
  deepEqual(Object.keys(second.snaps).sort(), ['a', 'b'])
  equal(second.nodes[0], first.nodes[0])
  deepEqual(second.snaps.a, first.snaps.a)
  deepEqual(second.nodes[1].position, { x: 16, y: 16 })

  // Maximising with Alt+Up leaves another maximised node maximised too.
  const up = snapNode(nodes(), {}, 'a', 'up', region, 16)
  const both = snapNode(up.nodes, up.snaps, 'b', 'up', region, 16)
  equal(both.nodes[0], up.nodes[0])
  equal(both.nodes[1].data.fittedToCanvas, true)

  // Nor does a pair displace a node already in one of its halves.
  const third = { id: 'c', position: { x: 50, y: 50 }, data: {}, style: { width: 100, height: 100 } }
  const c = snapNode([...nodes(), third], {}, 'c', 'left', region, 16)
  const pair = snapNodePair(c.nodes, c.snaps, ['a', 'b'], 'left', region, 16)
  equal(pair.nodes[2], c.nodes[2])
  deepEqual(pair.snaps.c, c.snaps.c)
})

test('the header toggle maximises and restores, and only the maximised node carries the flag', () => {
  const half = snapNode(nodes(), {}, 'a', 'left', region, 16)
  equal(half.nodes[0].data.fittedToCanvas, false)

  const maximised = toggleNodeFit(half.nodes, half.snaps, 'a', region, 16)
  deepEqual(maximised.nodes[0].position, { x: 16, y: 16 })
  deepEqual(maximised.nodes[0].style, { width: 968, height: 668 })
  equal(maximised.nodes[0].data.fittedToCanvas, true)
  // Restore geometry is where the node was before it was first snapped, not the half.
  deepEqual(maximised.snaps.a.restoreGeometry, { position: { x: 10, y: 20 }, width: 300, height: 200 })

  const other = toggleNodeFit(maximised.nodes, maximised.snaps, 'b', region, 16)
  equal(other.nodes[0].data.fittedToCanvas, false)
  deepEqual(other.nodes[0].position, { x: 10, y: 20 })
  equal(other.nodes[1].data.fittedToCanvas, true)

  const restored = toggleNodeFit(other.nodes, other.snaps, 'b', region, 16)
  deepEqual(restored.snaps, {})
  deepEqual(restored.nodes[1].position, { x: 400, y: 60 })
  deepEqual(restored.nodes[1].style, { width: 500, height: 400 })
})

test('a pair goes side by side or stacked in canvas order, never swapping', () => {
  const side = snapNodePair(nodes(), {}, ['b', 'a'], 'right', region, 16)
  deepEqual(side.nodes[0].position, { x: 16, y: 16 })
  deepEqual(side.nodes[1].position, { x: 16 + 476 + 16, y: 16 })
  deepEqual(side.snaps.a, {
    h: 'left',
    v: 'full',
    restoreGeometry: { position: { x: 10, y: 20 }, width: 300, height: 200 }
  })
  equal(side.snaps.b.h, 'right')

  const stacked = snapNodePair(side.nodes, side.snaps, ['a', 'b'], 'down', region, 16)
  // Both now share x, so order falls back to the original y (a above b) via the current positions.
  equal(stacked.snaps.a.v, 'top')
  equal(stacked.snaps.b.v, 'bottom')
  deepEqual(stacked.snaps.b.restoreGeometry, { position: { x: 400, y: 60 }, width: 500, height: 400 })
})

test('persistence sees the pre-fit geometry of a maximised node and the live geometry of a half', () => {
  const half = snapNode(nodes(), {}, 'a', 'left', region, 16)
  deepEqual(nodeBeforeTemporaryFit(half.nodes[0], half.snaps), half.nodes[0])

  const maximised = toggleNodeFit(nodes(), {}, 'a', region, 16)
  const persisted = nodeBeforeTemporaryFit(maximised.nodes[0], maximised.snaps)
  deepEqual(persisted.position, { x: 10, y: 20 })
  deepEqual(persisted.style, { width: 300, height: 200 })
  // The live node stays maximised.
  deepEqual(maximised.nodes[0].position, { x: 16, y: 16 })
})

test('reflow follows the usable canvas for every snapped node without touching the viewport or others', () => {
  const side = snapNodePair(nodes(), {}, ['a', 'b'], 'left', region, 16)
  const zoomed = { x: -200, y: 80, zoom: 1.5 }
  const reflowed = reflowSnappedNodes(side.nodes, side.snaps, { width: 700, height: 500 }, zoomed, 16)
  const next = canvasRegion({ width: 700, height: 500 }, zoomed, 16)
  deepEqual(reflowed[0].position, next.position)
  deepEqual(reflowed[0].style, { width: (next.width - 16) / 2, height: next.height })
  deepEqual(reflowed[1].position, { x: next.position.x + (next.width - 16) / 2 + 16, y: next.position.y })
  deepEqual(zoomed, { x: -200, y: 80, zoom: 1.5 })

  const untouched = nodes()
  equal(reflowSnappedNodes(untouched, {}, { width: 700, height: 500 }, viewport, 16), untouched)
  equal(reflowSnappedNodes(untouched, side.snaps, { width: 24, height: 500 }, viewport, 16), untouched)
})

test('only the user dragging, resizing or removing a snapped node releases it', () => {
  const snaps: SnapStates = {
    a: { h: 'left', v: 'full', restoreGeometry: { position: { x: 0, y: 0 }, width: 1, height: 1 } }
  }
  deepEqual(snapsReleasedByChanges([{ id: 'a', type: 'position', dragging: true }], snaps), ['a'])
  deepEqual(snapsReleasedByChanges([{ id: 'a', type: 'dimensions', resizing: true }], snaps), ['a'])
  deepEqual(snapsReleasedByChanges([{ id: 'a', type: 'remove' }], snaps), ['a'])
  // React Flow measurement and selection changes are not the user changing geometry.
  deepEqual(
    snapsReleasedByChanges([{ id: 'a', type: 'dimensions', dimensions: { width: 968, height: 668 } }], snaps),
    []
  )
  deepEqual(snapsReleasedByChanges([{ id: 'a', type: 'position', dragging: false }], snaps), [])
  deepEqual(snapsReleasedByChanges([{ id: 'a', type: 'select', selected: true }], snaps), [])
  deepEqual(snapsReleasedByChanges([{ id: 'b', type: 'position', dragging: true }], snaps), [])
})

test('a click with an unsteady hand is not a drag: the snap survives a nudge but not a move', () => {
  const snaps: SnapStates = {
    a: { h: 'left', v: 'full', restoreGeometry: { position: { x: 0, y: 0 }, width: 1, height: 1 } }
  }
  const at = (x: number, y: number, dragging = true): NodeChange[] => [
    { id: 'a', type: 'position', dragging, position: { x, y } }
  ]
  const placed = [{ id: 'a', position: { x: 16, y: 16 }, data: {} }]

  // React Flow starts a drag after one pixel of pointer travel, so a nudge arrives as a drag.
  deepEqual(snapsReleasedByChanges(at(17, 16), snaps, placed), [])
  deepEqual(snapsReleasedByChanges(at(16, 21), snaps, placed), ['a'])

  // Distance is from where the drag began, so many small frames still add up to a move.
  const origins: DragOrigins = new Map()
  deepEqual(snapsReleasedByChanges(at(18, 16), snaps, placed, origins), [])
  deepEqual(snapsReleasedByChanges(at(20, 16), snaps, [{ ...placed[0], position: { x: 18, y: 16 } }], origins), [])
  deepEqual(snapsReleasedByChanges(at(21, 16), snaps, [{ ...placed[0], position: { x: 20, y: 16 } }], origins), ['a'])

  // The drop ends the drag, so the next one is measured afresh.
  snapsReleasedByChanges(at(18, 16, false), snaps, placed, origins)
  equal(origins.size, 0)
})

test('a sidebar jump still puts an Alt+Arrow placed node in its slice after a nudging click', () => {
  const [a, b] = nodes()
  const left = snapNode([a, b], {}, 'a', 'left', region, 16)
  const placed = left.nodes.find((node) => node.id === 'a')!
  const nudge: NodeChange[] = [
    { id: 'a', type: 'position', dragging: true, position: { x: placed.position.x + 1, y: placed.position.y + 1 } }
  ]
  const released = snapsReleasedByChanges(nudge, left.snaps, left.nodes)
  deepEqual(released, [])

  const shown = viewportShowingNode(placed, left.snaps.a, canvas, { x: 600, y: 300, zoom: 1 }, 16)!
  // On the left inset, not centred: the node's screen rectangle is its slice again.
  equal(placed.position.x * shown.zoom + shown.x, 16)
  equal(placed.position.y * shown.zoom + shown.y, 16)
})

test('releasing forgets the snap and the flag but leaves the geometry where it is', () => {
  const maximised = toggleNodeFit(nodes(), {}, 'a', region, 16)
  const released = releaseSnaps(maximised.nodes, maximised.snaps, ['a'])
  deepEqual(released.snaps, {})
  equal(released.nodes[0].data.fittedToCanvas, false)
  deepEqual(released.nodes[0].position, { x: 16, y: 16 })
  equal(released.nodes[1], maximised.nodes[1])
})

test('showing a node keeps the zoom and centres an unsnapped node', () => {
  const node = { id: 'a', position: { x: 100, y: 50 }, data: {}, style: { width: 300, height: 200 } }
  deepEqual(viewportShowingNode(node, undefined, canvas, { x: -900, y: 400, zoom: 0.5 }, 16), {
    x: (1000 - 150) / 2 - 50,
    y: (700 - 100) / 2 - 25,
    zoom: 0.5
  })
})

test('showing a snapped node puts it back on the side it was snapped to', () => {
  const [a, b] = nodes()
  const right = snapNode([a, b], {}, 'a', 'right', region, 16)
  const snapped = right.nodes.find((node) => node.id === 'a')!
  const shown = viewportShowingNode(snapped, right.snaps.a, canvas, { x: 300, y: -200, zoom: 1 }, 16)!
  // Right edge on the inset, top on the inset: the node's screen rectangle is its slice again.
  equal(snapped.position.x * shown.zoom + shown.x + snapped.style.width, canvas.width - 16)
  equal(snapped.position.y * shown.zoom + shown.y, 16)

  const bottom = snapNode(right.nodes, right.snaps, 'a', 'down', region, 16)
  const quarter = bottom.nodes.find((node) => node.id === 'a')!
  const shownQuarter = viewportShowingNode(quarter, bottom.snaps.a, canvas, { x: 0, y: 0, zoom: 2 }, 16)!
  equal(quarter.position.y * 2 + shownQuarter.y + quarter.style.height * 2, canvas.height - 16)
  equal(shownQuarter.zoom, 2)
})

test('a node without geometry has nothing to show', () => {
  equal(viewportShowingNode({ id: 'x', position: { x: 0, y: 0 }, data: {} }, undefined, canvas, viewport, 16), null)
})

test('a slice belongs to one canvas: maximising on another canvas displaces nothing there', () => {
  // `a` and `b` are on different canvases (`within` says so), so both can be maximised at once;
  // a third node on `a`'s canvas taking the maximised slice restores `a` alone.
  const all = [...nodes(), { id: 'c', position: { x: 50, y: 50 }, data: {}, style: { width: 100, height: 100 } }]
  const onA = (id: string): boolean => id !== 'b'
  const onB = (id: string): boolean => id === 'b'
  const first = toggleNodeFit(all, {}, 'a', region, 16, onA)
  const second = toggleNodeFit(first.nodes, first.snaps, 'b', region, 16, onB)
  deepEqual(Object.keys(second.snaps), ['a', 'b'])
  deepEqual(second.nodes[0].position, { x: 16, y: 16 })
  deepEqual(second.nodes[1].position, { x: 16, y: 16 })

  const third = snapNodeToSlice(second.nodes, second.snaps, 'c', MAXIMISED, region, 16, onA)
  deepEqual(Object.keys(third.snaps), ['b', 'c'])
  deepEqual(third.nodes[0].position, { x: 10, y: 20 })
  equal(third.nodes[0].data.fittedToCanvas, false)
  deepEqual(third.nodes[1].position, { x: 16, y: 16 })

  // Without a scope every node shares the one canvas, as before.
  const unscoped = toggleNodeFit(first.nodes, first.snaps, 'b', region, 16)
  deepEqual(Object.keys(unscoped.snaps), ['b'])
})

test('restoring a snapped node puts it back; an unsnapped node is untouched', () => {
  const fitted = toggleNodeFit(nodes(), {}, 'a', region, 16)
  const restored = restoreSnappedNode(fitted.nodes, fitted.snaps, 'a')
  deepEqual(restored.snaps, {})
  deepEqual(restored.nodes[0].position, { x: 10, y: 20 })
  deepEqual(restored.nodes[0].style, { width: 300, height: 200 })
  equal(restored.nodes[0].data.fittedToCanvas, false)

  const untouched = nodes()
  equal(restoreSnappedNode(untouched, {}, 'a').nodes, untouched)
})

test('reflow within one canvas moves only the nodes snapped on it', () => {
  const inner = { position: { x: 0, y: 0 }, width: 400, height: 300 }
  const onInner = (id: string): boolean => id === 'b'
  const a = toggleNodeFit(nodes(), {}, 'a', region, 16)
  const both = toggleNodeFit(a.nodes, a.snaps, 'b', inner, 16, onInner)
  const grown = { position: { x: -20, y: 10 }, width: 800, height: 500 }
  const reflowed = reflowSnappedNodesWithin(both.nodes, both.snaps, grown, 16, onInner)
  // `a` is snapped on the other canvas and keeps its geometry - and its object.
  equal(reflowed[0], both.nodes[0])
  deepEqual(reflowed[1].position, grown.position)
  deepEqual(reflowed[1].style, { width: 800, height: 500 })
  // Nothing snapped within the canvas: the same array comes back.
  equal(
    reflowSnappedNodesWithin(both.nodes, both.snaps, grown, 16, () => false),
    both.nodes
  )
})

test('a restored slice survives a restart: the sidebar jump keeps the node in its slice', () => {
  const [a, b] = nodes()
  const right = snapNode([a, b], {}, 'a', 'right', region, 16)
  const persisted = persistedSnapSlice(right.snaps, 'a')
  deepEqual(persisted, { h: 'right', v: 'full' })

  // A restart: the node comes back at its slice geometry, and only the saved slice is known.
  const restored = hydrateSnaps(right.nodes, { a: persisted! })
  deepEqual(restored.a.h, 'right')
  const placed = right.nodes.find((node) => node.id === 'a')!
  const shown = viewportShowingNode(placed, restored.a, canvas, { x: 0, y: 0, zoom: 1 }, 16)!
  // Against the right inset, not centred.
  equal(placed.position.x * shown.zoom + shown.x + placed.style.width, canvas.width - 16)
  const centred = viewportShowingNode(placed, undefined, canvas, { x: 0, y: 0, zoom: 1 }, 16)!
  equal(centred.x === shown.x, false)
})

test('a maximised node persists its slice and is hydrated maximised, returning to its saved geometry', () => {
  const [a, b] = nodes()
  const full = snapNode([a, b], {}, 'a', 'up', region, 16)
  deepEqual(persistedSnapSlice(full.snaps, 'a'), MAXIMISED)

  // Saved at the geometry it will return to; restarted, only that geometry and the slice are known.
  const saved = nodeBeforeTemporaryFit(full.nodes[0], full.snaps)
  const hydrated = hydrateSnaps([saved, b], { a: MAXIMISED })
  deepEqual(hydrated.a.restoreGeometry, { position: a.position, width: 300, height: 200 })
  const refitted = nodesWithMaximisedFits([saved, b], hydrated, () => region, 16)
  deepEqual(refitted[0].style, { width: region.width, height: region.height })
  deepEqual(refitted[0].position, region.position)
  equal(refitted[0].data.fittedToCanvas, true)
  equal(refitted[1], b)
  // No room on the canvas yet: flagged, left for the next reflow.
  const waiting = nodesWithMaximisedFits([saved], hydrated, () => null, 16)
  deepEqual(waiting[0].position, a.position)
  equal(waiting[0].data.fittedToCanvas, true)

  const shown = viewportShowingNode(refitted[0], hydrated.a, canvas, viewport, 16)!
  equal(shown.x + refitted[0].position.x, 16)
  deepEqual(hydrateSnaps(full.nodes, { missing: { h: 'left', v: 'full' } }), {})
})

test('releasing a hydrated snap clears what would be persisted', () => {
  const [a, b] = nodes()
  const left = snapNode([a, b], {}, 'a', 'left', region, 16)
  const hydrated = hydrateSnaps(left.nodes, { a: { h: 'left', v: 'full' } })
  const placed = left.nodes.find((node) => node.id === 'a')!
  const drag: NodeChange[] = [
    { id: 'a', type: 'position', dragging: true, position: { x: placed.position.x + 50, y: placed.position.y } }
  ]
  const released = snapsReleasedByChanges(drag, hydrated, left.nodes)
  deepEqual(released, ['a'])
  equal(persistedSnapSlice(releaseSnaps(left.nodes, hydrated, released).snaps, 'a'), undefined)
  equal(persistedSnapSlice(restoreSnappedNode(left.nodes, hydrated, 'a').snaps, 'a'), undefined)
})
