import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CanvasTerminalLiveness, SidebarTerminalLiveness } from '../src/renderer/src/TerminalLivenessPresentation'
import type { TerminalLiveness } from '../src/shared/terminal'

describe.each([
  ['live', 'Live'],
  ['unverifiable', 'Unverifiable'],
  ['exited', 'Exited']
] as const)('%s terminal liveness presentation', (liveness, label) => {
  it('is visibly distinguished on the canvas and in the sidebar', () => {
    render(
      <>
        <CanvasTerminalLiveness liveness={liveness as TerminalLiveness} />
        <SidebarTerminalLiveness liveness={liveness as TerminalLiveness} />
      </>
    )

    const canvas = screen.getByText(label.toUpperCase())
    const sidebar = screen.getByText(label)
    expect(canvas).toHaveAttribute('data-liveness', liveness)
    expect(canvas).toHaveAttribute('title')
    expect(sidebar).toHaveAttribute('data-liveness', liveness)
  })
})
