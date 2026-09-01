import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { ConversationSummary } from '../src/shared/conversation'
import ConversationHistoryDialog, { formatRelativeTime } from '../src/renderer/src/ConversationHistoryDialog'

// Covers the browsing surface's contract: it reads one page at a time, labels the worktree a
// conversation ran in, and refuses honestly when a transcript has vanished since it was listed.

const PROJECT = 'D:\\Dev\\Toucan'
const WORKTREE = 'D:\\Dev\\Toucan-worktrees\\feature'

function summary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 'conversation-1',
    provider: 'claude',
    path: 'C:\\transcripts\\conversation-1.jsonl',
    title: 'Rename the parser',
    updatedAt: new Date(Date.now() - 70 * 60_000).toISOString(),
    messageCount: 12,
    cwd: PROJECT,
    ...overrides
  }
}

function installConversationApi(list: ReturnType<typeof vi.fn>, exists: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, 'conversationApi', {
    configurable: true,
    value: { list, exists }
  })
}

function renderDialog(onOpen = vi.fn()): { onOpen: ReturnType<typeof vi.fn> } {
  render(
    <ConversationHistoryDialog
      projectName="Toucan"
      directories={[PROJECT, WORKTREE]}
      directoryLabels={{ [PROJECT.toLocaleLowerCase()]: 'Toucan', [WORKTREE.toLocaleLowerCase()]: 'feature' }}
      onCancel={vi.fn()}
      onOpen={onOpen}
    />
  )
  return { onOpen }
}

test('formats how long ago a conversation was last touched', () => {
  const now = Date.parse('2026-08-28T12:00:00.000Z')
  expect(formatRelativeTime('2026-08-28T11:59:30.000Z', now)).toBe('just now')
  expect(formatRelativeTime('2026-08-28T11:30:00.000Z', now)).toBe('30m ago')
  expect(formatRelativeTime('2026-08-28T09:00:00.000Z', now)).toBe('3h ago')
  expect(formatRelativeTime('2026-08-25T12:00:00.000Z', now)).toBe('3d ago')
  expect(formatRelativeTime('not a date', now)).toBe('unknown')
})

test('shows what a conversation was, when it ran, and where', async () => {
  installConversationApi(
    vi.fn(async () => ({
      entries: [summary({ provider: 'codex', cwd: WORKTREE, messageCount: 1 })],
      total: 1,
      hasMore: false
    })),
    vi.fn(async () => true)
  )
  renderDialog()

  const row = await screen.findByRole('button', { name: /Rename the parser/ })
  expect(row.textContent?.replace(/\s+/g, ' ')).toContain('Codex · 1h ago · 1 message · feature')
  expect(screen.getByText(/use no model tokens/i)).toBeInTheDocument()
})

test('reads one page at a time and only asks for more on request', async () => {
  const list = vi.fn(async ({ offset }: { offset?: number }) =>
    offset
      ? { entries: [summary({ id: 'second', path: 'p2', title: 'Second' })], total: 2, hasMore: false }
      : { entries: [summary({ id: 'first', path: 'p1', title: 'First' })], total: 2, hasMore: true }
  )
  installConversationApi(
    list,
    vi.fn(async () => true)
  )
  renderDialog()

  await screen.findByText('First')
  expect(list).toHaveBeenCalledTimes(1)
  expect(list.mock.calls[0][0]).toMatchObject({ offset: 0, limit: 25 })
  expect(screen.queryByText('Second')).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

  await screen.findByText('Second')
  expect(list.mock.calls[1][0]).toMatchObject({ offset: 1 })
  expect(screen.getByText('First')).toBeInTheDocument()
})

test('opens a conversation that is still on disk', async () => {
  installConversationApi(
    vi.fn(async () => ({ entries: [summary()], total: 1, hasMore: false })),
    vi.fn(async () => true)
  )
  const { onOpen } = renderDialog()

  fireEvent.click(await screen.findByText('Rename the parser'))

  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'conversation-1' })))
})

test('says so rather than opening when the transcript has been deleted', async () => {
  installConversationApi(
    vi.fn(async () => ({ entries: [summary()], total: 1, hasMore: false })),
    vi.fn(async () => false)
  )
  const { onOpen } = renderDialog()

  fireEvent.click(await screen.findByText('Rename the parser'))

  await screen.findByRole('alert')
  expect(screen.getByRole('alert')).toHaveTextContent('no longer on disk')
  expect(onOpen).not.toHaveBeenCalled()
})
