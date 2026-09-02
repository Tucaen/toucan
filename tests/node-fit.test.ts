import { deepEqual } from 'node:assert/strict'
import { test } from 'node:test'
import { fitNodeToCanvas, nodeBeforeTemporaryFit, toggleNodeFit } from '../src/renderer/src/node-fit'

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

test('restores the exact geometry captured before fitting', () => {
  const original = { position: { x: 31.25, y: -47.5 }, width: 517.75, height: 339.5 }
  const fitted = toggleNodeFit(original, undefined, { width: 900, height: 600 }, { x: 120, y: -60, zoom: 1.5 }, 16)

  deepEqual(fitted.restoreGeometry, original)
  deepEqual(
    toggleNodeFit(fitted.geometry, fitted.restoreGeometry, { width: 400, height: 300 }, { x: 0, y: 0, zoom: 1 }, 16),
    { geometry: original, fitted: false }
  )
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

  deepEqual(nodeBeforeTemporaryFit(fittedNode, original), {
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
