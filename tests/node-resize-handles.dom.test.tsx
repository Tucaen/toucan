import { render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { describe, expect, test } from 'vitest'
import NodeBorderResizer from '../src/renderer/src/NodeBorderResizer'

// Every node root clips its overflow to keep the rounded corners, so a resize control anchored on
// the outer border (xyflow's default: `left`/`top: 100%`) is clipped away and cannot be grabbed.
// These tests pin all eight controls to the inside of the border. See NodeBorderResizer.tsx.

function renderResizer(selected: boolean): HTMLElement {
  const { container } = render(
    <ReactFlowProvider>
      <NodeBorderResizer minWidth={100} minHeight={100} selected={selected} color="#abcdef" />
    </ReactFlowProvider>
  )
  return container
}

function control(container: HTMLElement, ...positions: string[]): HTMLElement {
  const selector = `.react-flow__resize-control${positions.map((position) => `.${position}`).join('')}`
  const found = container.querySelectorAll<HTMLElement>(selector)
  expect(found).toHaveLength(1)
  return found[0]
}

describe('node resize controls', () => {
  test('renders a line per edge and a handle per corner', () => {
    const container = renderResizer(true)

    expect(container.querySelectorAll('.node-resize-line')).toHaveLength(4)
    expect(container.querySelectorAll('.node-resize-handle')).toHaveLength(4)
    for (const edge of ['top', 'right', 'bottom', 'left']) control(container, 'line', edge)
  })

  test('anchors every control inside the node border', () => {
    const container = renderResizer(true)

    for (const trailing of [control(container, 'line', 'right'), control(container, 'handle', 'top', 'right')]) {
      expect(trailing.style.right).toBe('0px')
      expect(trailing.style.left).toBe('auto')
    }
    for (const bottom of [control(container, 'line', 'bottom'), control(container, 'handle', 'bottom', 'left')]) {
      expect(bottom.style.bottom).toBe('0px')
      expect(bottom.style.top).toBe('auto')
    }

    // xyflow centers its controls on the border with a translate; keeping them inside means dropping it.
    expect(control(container, 'line', 'left').style.transform).toBe('none')
    expect(control(container, 'handle', 'bottom', 'right').style.translate).toBe('none')
  })

  test('shows the handles only while the node is selected', () => {
    expect(control(renderResizer(true), 'handle', 'top', 'left').style.borderColor).toBe('rgb(255, 255, 255)')
    expect(control(renderResizer(false), 'handle', 'top', 'left').style.borderColor).toBe('transparent')
  })
})
