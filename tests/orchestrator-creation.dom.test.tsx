import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { createMockAgentApi } from './dom/agent-api-mock'
import { DEFAULT_PROJECT, renderApp } from './dom/app-harness'

vi.mock('@xterm/xterm', async () => (await import('./dom/xterm-mock')).xtermModule())
vi.mock('@xterm/addon-fit', async () => (await import('./dom/xterm-mock')).fitAddonModule())

test.each([
  ['New orchestrator', 'claude', 'Claude'],
  ['New Codex orchestrator', 'codex', 'Codex']
] as const)('the canvas creates %s with a fixed role and visible provider', async (action, provider, name) => {
  const agent = createMockAgentApi()
  const harness = await renderApp({ apis: { agentApi: agent.api as unknown as Record<string, unknown> } })
  fireEvent.contextMenu(document.querySelector('.react-flow__pane')!, { clientX: 400, clientY: 300 })
  fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${action} `) }))

  const create = vi.mocked(agent.api.create)
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        provider,
        role: 'orchestrator',
        cwd: DEFAULT_PROJECT.path
      })
    )
  )
  expect(document.querySelector('.chat-node-header .node-orchestrator-badge')).toHaveTextContent('Orchestrator')
  expect(document.querySelector('.chat-node-header .node-provider')).toHaveTextContent(name)
  await waitFor(() =>
    expect(harness.saved.at(-1)?.nodes).toEqual([expect.objectContaining({ kind: provider, role: 'orchestrator' })])
  )
})
