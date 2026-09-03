import { deepEqual, equal } from 'node:assert/strict'
import { test } from 'node:test'
import {
  clearNodeFitFlag,
  fitNodeToCanvas,
  nodeFitAfterChanges,
  nodeBeforeTemporaryFit,
  reflowFittedNode,
  requestNodeFit
} from '../src/renderer/src/node-fit'

test('fits a node to panned visible canvas bounds', () => {
  deepEqual(fitNodeToCanvas({ width: 1000, height: 700 }, { x: -200, y: 80, zoom: 1 }, 16), {
    position: { x: 216, y: -64 },
    width: 968,
    height: 668
  })
})

test('fits a node to zoomed visible canvas bounds', () => {
  deepEqual(fitNodeToCanvas({ width: 900, height: 600 }, { x: 120, y: -60, zoom: 1.5 }, 18), {
    position: { x: -68, y: 52 },
    width: 576,
    height: 376
  })
})

test('applies the inset in screen pixels before converting to flow coordinates', () => {
  deepEqual(fitNodeToCanvas({ width: 640, height: 480 }, { x: 0, y: 0, zoom: 0.5 }, 20), {
    position: { x: 40, y: 40 },
    width: 1200,
    height: 880
  })
})

test('persistence sees pre-fit geometry while the live node remains fitted', () => {
  const fittedNode = {
    id: 'node',
    position: { x: 16, y: 16 },
    data: {},
    style: { width: 968, height: 668 },
    measured: { width: 968, height: 668 }
  }
  const original = { position: { x: 80, y: 120 }, width: 520, height: 340 }

  deepEqual(nodeBeforeTemporaryFit(fittedNode, { nodeId: 'node', restoreGeometry: original }), {
    ...fittedNode,
    position: original.position,
    style: { width: original.width, height: original.height },
    measured: { width: original.width, height: original.height }
  })
  deepEqual(fittedNode, {
    id: 'node',
    position: { x: 16, y: 16 },
    data: {},
    style: { width: 968, height: 668 },
    measured: { width: 968, height: 668 }
  })
})

test('fitting another node restores the currently fitted one first', () => {
  const nodes: {
    id: string
    position: { x: number; y: number }
    data: { fittedToCanvas?: boolean }
    style: { width: number; height: number }
  }[] = [
    { id: 'a', position: { x: 10, y: 20 }, data: {}, style: { width: 300, height: 200 } },
    { id: 'b', position: { x: 400, y: 60 }, data: {}, style: { width: 500, height: 400 } }
  ]
  const canvas = { width: 1000, height: 700 }
  const viewport = { x: 0, y: 0, zoom: 1 }

  const first = requestNodeFit(nodes, null, 'a', canvas, viewport, 16)
  deepEqual(first.fit, { nodeId: 'a', restoreGeometry: { position: { x: 10, y: 20 }, width: 300, height: 200 } })

  const second = requestNodeFit(first.nodes, first.fit, 'b', canvas, viewport, 16)
  deepEqual(second.fit, { nodeId: 'b', restoreGeometry: { position: { x: 400, y: 60 }, width: 500, height: 400 } })
  const restored = second.nodes.find((node) => node.id === 'a')
  deepEqual(restored?.position, { x: 10, y: 20 })
  deepEqual(restored?.style, { width: 300, height: 200 })
  equal(restored?.data.fittedToCanvas, false)
  const fitted = second.nodes.find((node) => node.id === 'b')
  deepEqual(fitted?.position, { x: 16, y: 16 })
  equal(fitted?.data.fittedToCanvas, true)
})

test('requesting the fitted node again restores it and leaves no fit state', () => {
  const nodes = [{ id: 'a', position: { x: 10, y: 20 }, data: {}, style: { width: 300, height: 200 } }]
  const fitted = requestNodeFit(nodes, null, 'a', { width: 800, height: 600 }, { x: 0, y: 0, zoom: 1 }, 16)

  const restored = requestNodeFit(
    fitted.nodes,
    fitted.fit,
    'a',
    { width: 400, height: 300 },
    { x: 5, y: 5, zoom: 2 },
    16
  )
  equal(restored.fit, null)
  deepEqual(restored.nodes[0].position, { x: 10, y: 20 })
  deepEqual(restored.nodes[0].style, { width: 300, height: 200 })
})

test('reflow follows the usable canvas without touching the viewport or other nodes', () => {
  const nodes = [
    { id: 'a', position: { x: 16, y: 16 }, data: { fittedToCanvas: true }, style: { width: 968, height: 668 } },
    { id: 'b', position: { x: 500, y: 40 }, data: {}, style: { width: 200, height: 150 } }
  ]
  const viewport = { x: -200, y: 80, zoom: 1.5 }
  const fit = { nodeId: 'a', restoreGeometry: { position: { x: 10, y: 20 }, width: 300, height: 200 } }

  const reflowed = reflowFittedNode(nodes, fit, { width: 700, height: 500 }, viewport, 16)
  deepEqual(reflowed[0].position, fitNodeToCanvas({ width: 700, height: 500 }, viewport, 16).position)
  deepEqual(reflowed[0].style, { width: 445.3333333333333, height: 312 })
  equal(reflowed[0].data.fittedToCanvas, true)
  equal(reflowed[1], nodes[1])
  deepEqual(viewport, { x: -200, y: 80, zoom: 1.5 })
})

test('reflow is a no-op without a fitted node or a usable canvas', () => {
  const nodes = [{ id: 'a', position: { x: 16, y: 16 }, data: {}, style: { width: 968, height: 668 } }]
  const fit = { nodeId: 'a', restoreGeometry: { position: { x: 10, y: 20 }, width: 300, height: 200 } }

  equal(reflowFittedNode(nodes, null, { width: 700, height: 500 }, { x: 0, y: 0, zoom: 1 }, 16), nodes)
  equal(reflowFittedNode(nodes, fit, { width: 24, height: 500 }, { x: 0, y: 0, zoom: 1 }, 16), nodes)
  equal(reflowFittedNode(nodes, fit, { width: 700, height: 0 }, { x: 0, y: 0, zoom: 1 }, 16), nodes)
})

test('only the user dragging or resizing the fitted node exits fit mode', () => {
  const fit = { nodeId: 'a', restoreGeometry: { position: { x: 10, y: 20 }, width: 300, height: 200 } }

  equal(nodeFitAfterChanges([{ id: 'a', type: 'position', dragging: true }], fit), 'exit')
  equal(nodeFitAfterChanges([{ id: 'a', type: 'dimensions', resizing: true }], fit), 'exit')
  // React Flow measurement and selection changes are not the user changing geometry.
  equal(nodeFitAfterChanges([{ id: 'a', type: 'dimensions', dimensions: { width: 968, height: 668 } }], fit), 'keep')
  equal(nodeFitAfterChanges([{ id: 'a', type: 'position', dragging: false }], fit), 'keep')
  equal(nodeFitAfterChanges([{ id: 'a', type: 'select', selected: true }], fit), 'keep')
  equal(nodeFitAfterChanges([{ id: 'b', type: 'position', dragging: true }], fit), 'keep')
  equal(nodeFitAfterChanges([{ id: 'a', type: 'position', dragging: true }], null), 'keep')
})

test('removing the fitted node forgets fit mode, and another node being removed does not', () => {
  const fit = { nodeId: 'a', restoreGeometry: { position: { x: 10, y: 20 }, width: 300, height: 200 } }

  equal(nodeFitAfterChanges([{ id: 'a', type: 'remove' }], fit), 'forget')
  // A removal outranks a drag in the same batch: there is no geometry left to keep.
  equal(
    nodeFitAfterChanges(
      [
        { id: 'a', type: 'position', dragging: true },
        { id: 'a', type: 'remove' }
      ],
      fit
    ),
    'forget'
  )
  equal(nodeFitAfterChanges([{ id: 'b', type: 'remove' }], fit), 'keep')
})

test('clearing the fit flag keeps the geometry the user just produced', () => {
  const nodes = [
    { id: 'a', position: { x: 40, y: 60 }, data: { fittedToCanvas: true }, style: { width: 968, height: 668 } },
    { id: 'b', position: { x: 0, y: 0 }, data: { fittedToCanvas: false }, style: { width: 100, height: 100 } }
  ]
  const cleared = clearNodeFitFlag(nodes, 'a')

  equal(cleared[0].data.fittedToCanvas, false)
  deepEqual(cleared[0].position, { x: 40, y: 60 })
  deepEqual(cleared[0].style, { width: 968, height: 668 })
  equal(cleared[1], nodes[1])
})

test('serialization reads the restore geometry only for the fitted node', () => {
  const fitted = {
    id: 'a',
    position: { x: 16, y: 16 },
    data: {},
    style: { width: 968, height: 668 },
    measured: { width: 968, height: 668 }
  }
  const fit = { nodeId: 'a', restoreGeometry: { position: { x: 80, y: 120 }, width: 520, height: 340 } }

  deepEqual(nodeBeforeTemporaryFit(fitted, fit).position, { x: 80, y: 120 })
  equal(nodeBeforeTemporaryFit({ ...fitted, id: 'b' }, fit).position.x, 16)
  equal(nodeBeforeTemporaryFit(fitted, null), fitted)
})
