import { act, render } from '@testing-library/react'
import type { Node, Viewport } from '@xyflow/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { NODE_FIT_INSET } from '../src/renderer/src/node-snap'
import { useNodeSnap, type NodeSnapController } from '../src/renderer/src/use-node-snap'

type TestNode = Node<{ fittedToCanvas?: boolean }>

const observers: (() => void)[] = []

class ResizeObserverStub {
  constructor(private readonly callback: () => void) {
    observers.push(() => this.callback())
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** One `ResizeObserver` on the canvas region is the only reflow trigger, whatever changed its size. */
function resizeCanvas(rect: { width: number; height: number }, into: { current: DOMRect }): void {
  into.current = { ...into.current, ...rect } as DOMRect
  act(() => {
    for (const notify of observers) notify()
  })
}

function initialNodes(): TestNode[] {
  return [
    { id: 'a', type: 'test', position: { x: 40, y: 60 }, data: {}, style: { width: 300, height: 200 } },
    { id: 'b', type: 'test', position: { x: 700, y: 90 }, data: {}, style: { width: 500, height: 400 } }
  ]
}

function geometryOf(node: TestNode | undefined): unknown {
  return { position: node?.position, style: node?.style, fitted: node?.data.fittedToCanvas }
}

describe('canvas snap mode', () => {
  let rect: { current: DOMRect }
  let viewport: Viewport
  let controller: NodeSnapController<TestNode>
  let nodes: TestNode[]

  function Harness(): JSX.Element {
    const [current, setCurrent] = useState<TestNode[]>(initialNodes)
    const canvasRef = useRef<HTMLElement>(null)
    nodes = current
    controller = useNodeSnap<TestNode>({
      canvasRef,
      getNodes: () => current,
      getViewport: () => viewport,
      setNodes: setCurrent
    })
    return (
      <section
        ref={(element) => {
          if (element) element.getBoundingClientRect = () => rect.current
          canvasRef.current = element
        }}
      />
    )
  }

  beforeEach(() => {
    observers.length = 0
    rect = { current: { width: 1000, height: 700 } as DOMRect }
    viewport = { x: 0, y: 0, zoom: 1 }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    render(<Harness />)
  })

  afterEach(() => vi.unstubAllGlobals())

  function fit(nodeId: string): void {
    act(() => controller.toggle(nodeId))
  }

  test('a fitted node follows the usable canvas as the application window resizes', () => {
    fit('a')
    expect(geometryOf(nodes[0])).toEqual({
      position: { x: 16, y: 16 },
      style: { width: 968, height: 668 },
      fitted: true
    })

    resizeCanvas({ width: 800, height: 500 }, rect)
    expect(geometryOf(nodes[0])).toEqual({
      position: { x: 16, y: 16 },
      style: { width: 768, height: 468 },
      fitted: true
    })
  })

  test('it follows a sidebar collapse and the docked brain-dump panel, at the current pan and zoom', () => {
    viewport = { x: -240, y: 120, zoom: 2 }
    fit('a')

    // Collapsing the sidebar widens the canvas region; the panel opening narrows it again.
    resizeCanvas({ width: 1160, height: 700 }, rect)
    expect(nodes[0].style).toEqual({ width: (1160 - 32) / 2, height: (700 - 32) / 2 })
    expect(nodes[0].position).toEqual({ x: (NODE_FIT_INSET + 240) / 2, y: (NODE_FIT_INSET - 120) / 2 })

    resizeCanvas({ width: 800, height: 700 }, rect)
    expect(nodes[0].style).toEqual({ width: (800 - 32) / 2, height: (700 - 32) / 2 })
    // Reflow reads the viewport and never writes it.
    expect(viewport).toEqual({ x: -240, y: 120, zoom: 2 })
  })

  test('reflow leaves every other node alone', () => {
    fit('a')
    const other = nodes[1]

    resizeCanvas({ width: 600, height: 400 }, rect)
    expect(nodes[1]).toBe(other)
  })

  test('dragging the fitted node exits fit mode and discards the pending restore', () => {
    fit('a')
    act(() => controller.observeChanges([{ id: 'a', type: 'position', dragging: true }]))

    expect(controller.state()).toEqual({})
    // The drag itself is React Flow's to apply; snap mode must not undo it.
    expect(nodes[0].position).toEqual({ x: 16, y: 16 })
    expect(nodes[0].data.fittedToCanvas).toBe(false)

    resizeCanvas({ width: 600, height: 400 }, rect)
    expect(nodes[0].style).toEqual({ width: 968, height: 668 })
  })

  test('manually resizing the fitted node exits fit mode and keeps the new size', () => {
    fit('a')
    act(() => controller.observeChanges([{ id: 'a', type: 'dimensions', resizing: true }]))

    expect(controller.state()).toEqual({})
    expect(nodes[0].style).toEqual({ width: 968, height: 668 })

    // Fitting again saves the geometry the user produced, not the pre-fit geometry it replaced.
    fit('a')
    expect(controller.state().a.restoreGeometry).toEqual({
      position: { x: 16, y: 16 },
      width: 968,
      height: 668
    })
  })

  test('measurement reported after a fit does not exit fit mode', () => {
    fit('a')
    act(() => controller.observeChanges([{ id: 'a', type: 'dimensions', dimensions: { width: 968, height: 668 } }]))

    expect(Object.keys(controller.state())).toEqual(['a'])
    expect(nodes[0].data.fittedToCanvas).toBe(true)
  })

  test('fit mode moves to another node, restoring the one it leaves', () => {
    fit('a')
    fit('b')

    expect(Object.keys(controller.state())).toEqual(['b'])
    expect(geometryOf(nodes[0])).toEqual({
      position: { x: 40, y: 60 },
      style: { width: 300, height: 200 },
      fitted: false
    })
    expect(geometryOf(nodes[1])).toEqual({
      position: { x: 16, y: 16 },
      style: { width: 968, height: 668 },
      fitted: true
    })
  })

  test('a removed fitted node leaves no restore behind and the others stay fittable', () => {
    fit('a')
    act(() => controller.observeChanges([{ id: 'a', type: 'remove' }]))

    expect(controller.state()).toEqual({})

    fit('b')
    expect(controller.state()).toEqual({
      b: { h: 'full', v: 'full', restoreGeometry: { position: { x: 700, y: 90 }, width: 500, height: 400 } }
    })
  })

  test('two selected nodes go side by side with one Alt+Arrow and both follow a resize', () => {
    act(() => controller.snap(['a', 'b'], 'left'))
    expect(nodes[0].position).toEqual({ x: 16, y: 16 })
    expect(nodes[0].style).toEqual({ width: 476, height: 668 })
    expect(nodes[1].position).toEqual({ x: 16 + 476 + 16, y: 16 })
    // Neither is maximised, so neither header shows Restore.
    expect(nodes.map((node) => node.data.fittedToCanvas)).toEqual([false, false])

    resizeCanvas({ width: 800, height: 500 }, rect)
    expect(nodes[0].style).toEqual({ width: 376, height: 468 })
    expect(nodes[1].position).toEqual({ x: 16 + 376 + 16, y: 16 })
  })

  test('the header toggle and Alt+Up are the same maximise, and Alt+Down restores it', () => {
    act(() => controller.snap(['a'], 'up'))
    expect(nodes[0].data.fittedToCanvas).toBe(true)
    expect(nodes[0].style).toEqual({ width: 968, height: 668 })

    fit('a')
    expect(geometryOf(nodes[0])).toEqual({
      position: { x: 40, y: 60 },
      style: { width: 300, height: 200 },
      fitted: false
    })

    fit('a')
    act(() => controller.snap(['a'], 'down'))
    expect(geometryOf(nodes[0])).toEqual({
      position: { x: 40, y: 60 },
      style: { width: 300, height: 200 },
      fitted: false
    })
    expect(controller.state()).toEqual({})
  })

  test('release forgets snaps without moving anything, so tiling can take over', () => {
    act(() => controller.snap(['a', 'b'], 'left'))
    act(() => controller.release())
    expect(controller.state()).toEqual({})
    expect(nodes[0].position).toEqual({ x: 16, y: 16 })

    resizeCanvas({ width: 600, height: 400 }, rect)
    expect(nodes[0].style).toEqual({ width: 476, height: 668 })
  })
})
