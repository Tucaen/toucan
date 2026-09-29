import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import type { WorkspaceState } from '../src/shared/workspace'
import { savedWorkspace } from './dom/app-harness'
import {
  chat,
  lastSaved,
  mountWorktreeCanvases,
  nodeElement,
  worktree,
  worktreeHeader as header,
  type WorktreeCanvasesHarness
} from './dom/worktree-canvases'

/**
 * Issue #27: five worktrees running side by side, one of them focused and one collapsed, and the
 * overview still says which worktree - and which chat in it - needs the user. The headers and the
 * navigator read one summary, going to a worktree reads nothing, and going to a chat reveals that
 * exact chat without restarting anything or moving any worktree.
 */

let harness: WorktreeCanvasesHarness

afterEach(() => harness?.teardown())

const BRANCHES = ['feature/login', 'feature/signup', 'feature/search', 'feature/billing', 'feature/export']

/** Five worktrees in a row, `w3` with two chats and the rest with one, and a chat on the main canvas. */
function fiveWorktrees(): WorkspaceState {
  return savedWorkspace({
    worktrees: BRANCHES.map((branch, index) => worktree(`w${index + 1}`, branch, index * 1000)),
    nodes: [
      chat('c1', 'Chat C1', 'w1', 0),
      chat('c2', 'Chat C2', 'w2', 0),
      chat('c3a', 'Chat C3a', 'w3', 0),
      chat('c3b', 'Chat C3b', 'w3', 560),
      chat('c4', 'Chat C4', 'w4', 0),
      chat('c5', 'Chat C5', 'w5', 0),
      chat('loose', 'Loose chat', undefined, 5200)
    ]
  })
}

const CHATS = ['c1', 'c2', 'c3a', 'c3b', 'c4', 'c5']

function navigator(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Worktrees' })
}

/** The navigator's entry for a worktree: its row and the chats listed under it. */
function entry(branch: string): HTMLElement {
  return within(navigator()).getByText(branch).closest('li')!
}

function createsFor(nodeId: string): number {
  const create = harness.agent.api.create as unknown as { mock: { calls: unknown[][] } }
  return create.mock.calls.filter(([request]) => (request as { id?: string }).id === nodeId).length
}

function isSelected(nodeId: string): boolean {
  return nodeElement(nodeId)!.classList.contains('selected')
}

function worktreePositions(): unknown {
  return lastSaved(harness).worktrees.map((saved) => [saved.id, saved.position])
}

async function finishTurn(nodeId: string, answer: string): Promise<void> {
  await act(async () => {
    harness.agent.emit(nodeId, { type: 'status', status: 'working' })
  })
  await act(async () => {
    harness.agent.emit(nodeId, { type: 'message', role: 'assistant', messageId: `${nodeId}-answer`, text: answer })
    harness.agent.emit(nodeId, { type: 'turn_complete', stopReason: 'end_turn' })
    harness.agent.emit(nodeId, { type: 'status', status: 'ready' })
  })
}

const APPROVAL = {
  type: 'approval' as const,
  approvalId: 'perm-billing',
  title: 'Run command: npm test',
  options: [{ id: 'allow', label: 'Allow Once', kind: 'allow_once' as const }]
}

describe('the worktree overview', () => {
  test('finds and answers a request in a collapsed, unselected worktree while the others keep working', async () => {
    harness = await mountWorktreeCanvases(fiveWorktrees())
    await waitFor(() => CHATS.forEach((id) => expect(createsFor(id)).toBe(1)))

    // Every worktree is listed by branch, in canvas order.
    const rows = within(navigator()).getAllByRole('button', { name: /feature\// })
    expect(rows.map((row) => within(row).getByText(/^feature\//).textContent)).toEqual(BRANCHES)

    // Background work in w2, a collapsed w4, and w1 focused onto the whole canvas.
    act(() => harness.agent.emit('c2', { type: 'status', status: 'working' }))
    fireEvent.click(within(header('w4')).getByRole('button', { name: 'Collapse worktree' }))
    fireEvent.click(within(header('w1')).getByRole('button', { name: 'Fit to canvas' }))
    await waitFor(() => expect(within(header('w1')).getByRole('button', { name: 'Restore' })).toBeInTheDocument())

    // Header and navigator agree on the work in w2, and neither reads git state as agent state.
    await waitFor(() => expect(within(header('w2')).getByText('1 working')).toBeInTheDocument())
    expect(within(entry('feature/signup')).getByText('1 working')).toBeInTheDocument()
    expect(
      header('w2')
        .querySelector('.worktree-status')!
        .contains(within(header('w2')).getByText('1 working'))
    ).toBe(false)

    // The collapsed worktree's chat asks for approval: it is still mounted, so it still reports.
    await act(async () => harness.agent.emit('c4', APPROVAL))
    await waitFor(() => expect(within(header('w4')).getByText('1 unread')).toBeInTheDocument())
    expect(within(entry('feature/billing')).getByText('1 unread')).toBeInTheDocument()
    const request = within(entry('feature/billing')).getByRole('button', { name: /Approval.*Chat C4/ })
    expect(nodeElement('worktree:w4')!.querySelector('.worktree-node')).toHaveClass('collapsed')
    expect(createsFor('c4')).toBe(1)

    // Going there: w4 expands, the exact chat is selected, and the focused w1 gives its room back.
    fireEvent.click(request)
    await waitFor(() => expect(isSelected('c4')).toBe(true))
    expect(nodeElement('worktree:w4')!.querySelector('.worktree-node')).not.toHaveClass('collapsed')
    await waitFor(() => expect(within(header('w1')).getByRole('button', { name: 'Fit to canvas' })).toBeInTheDocument())
    // Looking at the request is not answering it.
    expect(within(header('w4')).getByText('1 unread')).toBeInTheDocument()
    expect(within(entry('feature/billing')).getByText('1 unread')).toBeInTheDocument()

    // Answering it clears it everywhere at once.
    fireEvent.click(within(nodeElement('c4')!).getByRole('button', { name: 'Allow Once' }))
    await waitFor(() => expect(within(header('w4')).queryByText('1 unread')).toBeNull())
    expect(within(entry('feature/billing')).queryByText('1 unread')).toBeNull()
    expect(harness.agent.api.resolveApproval).toHaveBeenCalled()

    // Nothing restarted, the background turn is still running, and no worktree moved on its own.
    CHATS.forEach((id) => expect(createsFor(id)).toBe(1))
    expect(harness.agent.api.kill).not.toHaveBeenCalled()
    expect(within(header('w2')).getByText('1 working')).toBeInTheDocument()
    expect(within(entry('feature/signup')).getByText('1 working')).toBeInTheDocument()
    await waitFor(() =>
      expect(worktreePositions()).toEqual(BRANCHES.map((_, index) => [`w${index + 1}`, { x: index * 1000, y: 0 }]))
    )
  })

  test('visiting a worktree reads nothing; only showing the chat itself marks its result viewed', async () => {
    harness = await mountWorktreeCanvases(fiveWorktrees())
    await waitFor(() => CHATS.forEach((id) => expect(createsFor(id)).toBe(1)))

    await finishTurn('c3b', 'Search now pages results.')
    await act(async () =>
      harness.agent.emit('c3a', { ...APPROVAL, approvalId: 'perm-search', title: 'Edit src/search.ts' })
    )
    // Two children, two kinds, one total both surfaces agree on.
    await waitFor(() => expect(within(header('w3')).getByText('2 unread')).toBeInTheDocument())
    expect(within(entry('feature/search')).getByText('2 unread')).toBeInTheDocument()
    expect(within(entry('feature/search')).getByRole('button', { name: /Approval.*Chat C3a/ })).toBeInTheDocument()
    expect(within(entry('feature/search')).getByRole('button', { name: /Result.*Chat C3b/ })).toBeInTheDocument()

    // The worktree itself: its frame is selected, none of its chats, and nothing is read.
    fireEvent.click(within(navigator()).getByRole('button', { name: /feature\/search/ }))
    await waitFor(() => expect(isSelected('worktree:w3')).toBe(true))
    expect(isSelected('c3a')).toBe(false)
    expect(isSelected('c3b')).toBe(false)
    expect(within(header('w3')).getByText('2 unread')).toBeInTheDocument()

    // The chat with the result: shown, selected, and its result read under the chat's own policy.
    fireEvent.click(within(entry('feature/search')).getByRole('button', { name: /Result.*Chat C3b/ }))
    await waitFor(() => expect(isSelected('c3b')).toBe(true))
    await waitFor(() => expect(within(header('w3')).getByText('1 unread')).toBeInTheDocument())
    expect(within(entry('feature/search')).getByText('1 unread')).toBeInTheDocument()
    expect(within(entry('feature/search')).queryByRole('button', { name: /Result.*Chat C3b/ })).toBeNull()

    // The header's own shortcut goes to the chat that is waiting, not the first one in the worktree.
    fireEvent.click(within(header('w3')).getByRole('button', { name: /1 unread - show Chat C3a/ }))
    await waitFor(() => expect(isSelected('c3a')).toBe(true))
    expect(within(header('w3')).getByText('1 unread')).toBeInTheDocument()
  })

  test('a chat selected when its worktree collapses does not read what arrives while it is hidden', async () => {
    harness = await mountWorktreeCanvases(fiveWorktrees())
    await waitFor(() => expect(createsFor('c5')).toBe(1))

    fireEvent.click(nodeElement('c5')!.querySelector('.node-header')!)
    await waitFor(() => expect(isSelected('c5')).toBe(true))

    // Collapsing is a click on the worktree's frame, which takes the selection off every chat inside.
    fireEvent.click(within(header('w5')).getByRole('button', { name: 'Collapse worktree' }))
    await waitFor(() => expect(isSelected('c5')).toBe(false))
    await finishTurn('c5', 'Export is streamed now.')
    await waitFor(() => expect(within(header('w5')).getByText('1 unread')).toBeInTheDocument())
  })

  test('the navigator is walked with the arrow keys and folds to one line', async () => {
    harness = await mountWorktreeCanvases(fiveWorktrees())
    const toggle = within(navigator()).getByRole('button', { name: /Worktrees/ })
    toggle.focus()

    fireEvent.keyDown(toggle, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(within(navigator()).getByRole('button', { name: /feature\/login/ }))
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(within(navigator()).getByRole('button', { name: /feature\/export/ }))
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement).toBe(toggle)

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(navigator()).queryByRole('button', { name: /feature\// })).toBeNull()
  })

  test('the bottom row stays Add chat and Fit chats, with no details or close-selected action', async () => {
    harness = await mountWorktreeCanvases(fiveWorktrees())
    const row = nodeElement('worktree:w1')!.querySelector<HTMLElement>('.worktree-actions')!
    const labels = within(row)
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(labels).toEqual(['Codex', 'Claude', 'Fit chats'])
  })
})
