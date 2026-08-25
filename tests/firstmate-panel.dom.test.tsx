import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { SelectorPicker } from '../src/renderer/src/ChatNode'
import { FirstMateCaptainSelectors, FirstMateProviderTabs, FirstMateTaskHistory } from '../src/renderer/src/FirstMatePanel'
import { useAgentConversation } from '../src/renderer/src/use-agent-conversation'
import { createMockAgentApi } from './dom/agent-api-mock'

// Real-DOM companion to firstmate-panel.test.ts, covering the parts of that file's "selector/
// dropdown behavior" no source-text match can verify: that SelectorPicker's menu actually opens,
// is selectable, and (the earlier overflow-clipping fix from PR #41) is portaled out to
// document.body with fixed, computed positioning rather than CSS-anchored inside an
// overflow:hidden ancestor - a regression there would clip the menu at the FirstMate panel/canvas
// node edge again, and a source-text match on the fix's implementation can't catch that. The rest
// of firstmate-panel.test.ts (auth flows, dispatch lifecycle, project catalog/autonomy wiring)
// stays as documented source-text assertions: FirstMatePanel itself pulls in the same
// @xyflow/react/@moonshine-ai/moonshine-wasm dependencies called out in
// firstmate-quota.dom.test.tsx, well beyond what a jsdom harness can mount.

const options = [
  { id: 'opus', name: 'Opus', description: 'Most capable' },
  { id: 'sonnet', name: 'Sonnet', description: 'Balanced' }
]

test('provider tabs present separate captain conversations and select the inactive provider', () => {
  const select = vi.fn()
  render(<FirstMateProviderTabs activeProvider="codex" switchingDisabled={false} select={select} />)

  expect(screen.getByRole('tablist', { name: 'FirstMate captain conversations' })).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: /Codex Active captain/ })).toHaveAttribute(
    'aria-controls',
    'firstmate-active-conversation'
  )
  expect(screen.getByRole('tab', { name: /Codex Active captain/ })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('tab', { name: /Claude Separate conversation/ })).toHaveAttribute('aria-selected', 'false')

  fireEvent.click(screen.getByRole('tab', { name: /Claude/ }))
  expect(select).toHaveBeenCalledWith('claude')
})

test('task history presents timestamped sources, dispatch identity, and current evidence detail', () => {
  render(<FirstMateTaskHistory task={{
    id: 'ship-69', mode: 'no-mistakes', stage: 'validating', detail: 'Checks running', statusHash: 'hash',
    history: [{
      id: 'event-1', occurredAt: '2026-08-24T10:00:00.000Z', source: 'ade-reconciliation',
      stage: 'dispatching', detail: 'Validation sent',
      dispatch: { id: 'ship-69.dispatch', status: 'acknowledged', attempt: 2 }
    }]
  }} />)
  fireEvent.click(screen.getByText('History (1)'))
  expect(screen.getByText('Validation sent')).toBeInTheDocument()
  expect(screen.getByText(/ade-reconciliation.*ship-69\.dispatch.*attempt 2/)).toBeInTheDocument()
  expect(document.querySelector('time')).toHaveAttribute('datetime', '2026-08-24T10:00:00.000Z')
})

test('task history presents pending decisions and terminal outcomes', () => {
  render(<FirstMateTaskHistory task={{
    id: 'ship-69', mode: 'no-mistakes', stage: 'implemented', detail: 'Finished', statusHash: 'hash',
    terminalOutcome: 'completed',
    pendingDecisions: [{ key: 'release', detail: 'choose release window' }],
    history: [{
      id: 'event-1', occurredAt: '2026-08-24T10:00:00.000Z', source: 'firstmate-status',
      stage: 'implemented', detail: 'Finished', outcome: 'completed'
    }]
  }} />)
  fireEvent.click(screen.getByText('History (1)'))
  expect(screen.getByText('Current state: Completed')).toBeInTheDocument()
  expect(screen.getByText('Terminal outcome: completed')).toBeInTheDocument()
  expect(screen.getByRole('list', { name: 'Pending decisions' })).toHaveTextContent('release: choose release window')
  expect(screen.getByText(/outcome completed/)).toBeInTheDocument()
})

test('provider tabs cannot interrupt an active captain turn', () => {
  const select = vi.fn()
  render(<FirstMateProviderTabs activeProvider="claude" switchingDisabled select={select} />)

  const codex = screen.getByRole('tab', { name: /Codex/ })
  expect(codex).toBeDisabled()
  fireEvent.click(codex)
  expect(select).not.toHaveBeenCalled()
})

test('a disabled picker cannot be opened', () => {
  render(<SelectorPicker kind="model" options={options} selectedId="opus" disabled select={vi.fn()} />)

  const button = screen.getByRole('button', { name: /Opus/ })
  expect(button).toBeDisabled()
  fireEvent.click(button)
  expect(screen.queryByRole('listbox')).toBeNull()
})

test('a picker with no options cannot be opened even when not explicitly disabled', () => {
  render(<SelectorPicker kind="model" options={[]} disabled={false} select={vi.fn()} />)

  expect(screen.getByRole('button', { name: /Model/ })).toBeDisabled()
})

test('opening the picker portals its menu to document.body, positioned fixed rather than CSS-anchored', () => {
  render(
    <div style={{ overflow: 'hidden' }} data-testid="clipping-ancestor">
      <SelectorPicker kind="model" options={options} selectedId="opus" disabled={false} select={vi.fn()} />
    </div>
  )

  fireEvent.click(screen.getByRole('button', { name: /Opus/ }))

  const menu = screen.getByRole('listbox', { name: 'Model' })
  expect(within(screen.getByTestId('clipping-ancestor')).queryByRole('listbox')).toBeNull()
  expect(document.body).toContainElement(menu)
  expect(menu.style.position).toBe('fixed')
  expect(menu.style.top).not.toBe('')
  expect(menu.style.left).not.toBe('')
})

test('selecting an option delivers the choice and closes the menu', () => {
  const select = vi.fn()
  render(<SelectorPicker kind="model" options={options} selectedId="opus" disabled={false} select={select} />)

  fireEvent.click(screen.getByRole('button', { name: /Opus/ }))
  fireEvent.click(screen.getByRole('option', { name: /Sonnet/ }))

  expect(select).toHaveBeenCalledWith('sonnet')
  expect(screen.queryByRole('listbox')).toBeNull()
})

test('the currently selected option is marked distinctly from the rest', () => {
  render(<SelectorPicker kind="model" options={options} selectedId="sonnet" disabled={false} select={vi.fn()} />)

  fireEvent.click(screen.getByRole('button', { name: /Sonnet/ }))

  expect(screen.getByRole('option', { name: /Opus/ })).toHaveAttribute('aria-selected', 'false')
  expect(screen.getByRole('option', { name: /Sonnet/ })).toHaveAttribute('aria-selected', 'true')
})

test('thinking effort renders one non-text selected marker only in the open menu', () => {
  render(<SelectorPicker
    kind="effort"
    options={[
      { id: 'low', name: 'Low', description: 'Faster responses' },
      { id: 'high', name: 'High', description: 'Deeper reasoning' }
    ]}
    selectedId="low"
    disabled={false}
    select={vi.fn()}
  />)

  const trigger = screen.getByRole('button', { name: 'Low' })
  expect(trigger).not.toHaveTextContent(/â|œ|✓/)
  expect(document.querySelector('.node-picker-selected-marker')).toBeNull()

  fireEvent.click(trigger)

  const selected = screen.getByRole('option', { name: /Low/ })
  const unselected = screen.getByRole('option', { name: /High/ })
  expect(selected.querySelector('.node-picker-selected-marker')).toHaveAttribute('aria-hidden', 'true')
  expect(unselected.querySelector('.node-picker-selected-marker')).toBeNull()
  expect(screen.getByRole('listbox')).not.toHaveTextContent(/â|œ|✓/)
})

test('captain selectors place thinking directly between model and permissions', () => {
  const { container } = render(<div className="firstmate-settings-bar">
    <FirstMateCaptainSelectors
      models={[{ id: 'gpt-5', name: 'GPT-5' }]}
      selectedModelId="gpt-5"
      efforts={[{ id: 'high', name: 'High' }]}
      selectedEffortId="high"
      modes={[{ id: 'agent', name: 'Agent' }]}
      selectedModeId="agent"
      disabled={false}
      selectModel={vi.fn()}
      selectEffort={vi.fn()}
      selectMode={vi.fn()}
    />
  </div>)

  expect(Array.from(container.querySelectorAll('label > span')).map((label) => label.textContent))
    .toEqual(['Model', 'Thinking', 'Permissions'])
})

test('selecting captain effort applies and persists the advertised option', async () => {
  const onEffort = vi.fn()
  const setEffort = vi.fn(async () => ({ ok: true }))
  const { api } = createMockAgentApi({
    create: vi.fn(async () => ({
      ok: true,
      status: 'ready' as const,
      efforts: {
        currentEffortId: 'medium',
        availableEfforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }]
      }
    })),
    setEffort
  })
  window.agentApi = api
  const { result } = renderHook(() => useAgentConversation({
    id: 'captain-effort', provider: 'codex', cwd: '/project', enabled: true,
    effortId: 'medium', onSessionId: vi.fn(), onPermissionMode: vi.fn(), onModel: vi.fn(), onEffort
  }))

  await waitFor(() => expect(result.current.efforts?.currentEffortId).toBe('medium'))
  expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ effortId: 'medium' }))
  await act(async () => result.current.selectEffort('high'))
  await waitFor(() => expect(result.current.efforts?.currentEffortId).toBe('high'))

  expect(setEffort).toHaveBeenCalledWith('captain-effort', 'high')
  expect(onEffort).toHaveBeenCalledWith('high')
})

test('selectorsDisabled only blocks the starting/exited window, not authentication', async () => {
  const { api } = createMockAgentApi({
    create: vi.fn(async () => ({ ok: true, status: 'auth_required' as const, authMethods: [] }))
  })
  window.agentApi = api

  const { result } = renderHook(() => useAgentConversation({
    id: 'session-auth',
    provider: 'codex',
    cwd: '/project',
    enabled: true,
    onSessionId: vi.fn(),
    onPermissionMode: vi.fn(),
    onModel: vi.fn()
  }))

  await waitFor(() => expect(result.current.status).toBe('auth_required'))
  expect(result.current.selectorsDisabled).toBe(false)
})
