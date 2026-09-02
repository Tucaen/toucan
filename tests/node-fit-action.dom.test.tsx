import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import NodeFitAction from '../src/renderer/src/NodeFitAction'
import { NodeFitContext } from '../src/renderer/src/node-fit-context'

describe('node fit header action', () => {
  test('fits and restores through the same accessible action', () => {
    const onToggle = vi.fn()
    function Harness(): JSX.Element {
      const [fitted, setFitted] = useState(false)
      return (
        <NodeFitContext.Provider
          value={(nodeId) => {
            onToggle(nodeId)
            setFitted((current) => !current)
          }}
        >
          <NodeFitAction nodeId="node-1" fitted={fitted} />
        </NodeFitContext.Provider>
      )
    }
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: 'Fit to canvas' }))
    expect(onToggle).toHaveBeenCalledWith('node-1')

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(onToggle).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Fit to canvas' })).toBeInTheDocument()
  })
})
