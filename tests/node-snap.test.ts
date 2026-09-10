import { deepEqual, equal } from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAXIMISED,
  canvasRegion,
  nextSnapSlice,
  nodeBeforeTemporaryFit,
  reflowSnappedNodes,
  releaseSnaps,
  sliceGeometry,
  snapNode,
  snapNodePair,
  snapsReleasedByChanges,
  toggleNodeFit,
  viewportShowingNode,
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

test('one node per slice: a second node taking a slice restores the first', () => {
  const first = snapNode(nodes(), {}, 'a', 'left', region, 16)
  const second = snapNode(first.nodes, first.snaps, 'b', 'left', region, 16)
  deepEqual(Object.keys(second.snaps), ['b'])
  deepEqual(second.nodes[0].position, { x: 10, y: 20 })
  deepEqual(second.nodes[1].position, { x: 16, y: 16 })

  // Different slices coexist.
  const right = snapNode(first.nodes, first.snaps, 'b', 'right', region, 16)
  deepEqual(Object.keys(right.snaps).sort(), ['a', 'b'])
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
