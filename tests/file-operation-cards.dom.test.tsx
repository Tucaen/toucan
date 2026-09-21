import { fireEvent, render, within } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { TestChatView as ChatView, type TestChatViewProps as ChatViewProps } from './dom/chat-view-fixture'
import type { AgentActivity } from '../src/shared/agent'

// File-operation tool cards (issue #88): Read/Write/Edit/MultiEdit/NotebookEdit lead with the
// path, shortened against the workspace root, and show the operation rather than a raw dump.

const WORKSPACE_ROOT = 'D:\\Development\\Toucan'

const baseChatViewProps: ChatViewProps = {
  provider: 'claude',
  messages: [],
  activities: [],
  plan: [],
  approval: null,
  authMethods: [],
  authLink: null,
  reauthenticating: false,
  status: 'ready',
  draft: '',
  imageSupport: false,
  attachments: [],
  addImages: vi.fn(),
  removeAttachment: vi.fn(),
  submit: vi.fn(),
  cancel: vi.fn(),
  authenticate: vi.fn(),
  openAuthLink: vi.fn(),
  resolveApproval: vi.fn(),
  sendMessage: vi.fn(),
  answerDecision: vi.fn(),
  queued: [],
  editQueued: vi.fn(),
  withdrawQueued: vi.fn(),
  sendQueuedNow: vi.fn()
}

const copyText = vi.fn()
const showItemInFolder = vi.fn()

beforeEach(() => {
  copyText.mockClear()
  showItemInFolder.mockClear()
  Object.defineProperty(window, 'terminalApi', {
    configurable: true,
    value: { copyText, showItemInFolder }
  })
})

function renderCards(activities: AgentActivity[]): HTMLElement {
  const { container } = render(
    <ChatView
      {...baseChatViewProps}
      activities={activities}
      workspaceRoots={[WORKSPACE_ROOT]}
      focusMode={false}
      setFocusMode={vi.fn()}
    />
  )
  return container
}

function cards(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.activity-card'))
}

function expand(card: HTMLElement): HTMLElement {
  if (card.dataset.expanded !== 'true') fireEvent.click(within(card).getAllByRole('button')[0])
  return card
}

function read(id: string, filePath: string, extra: Record<string, unknown> = {}): AgentActivity {
  return {
    id,
    kind: 'read',
    toolName: 'Read',
    status: 'completed',
    title: 'Read a file',
    rawInput: { file_path: filePath, ...extra },
    startedAt: 0,
    endedAt: 100
  }
}

describe('file-operation tool cards', () => {
  test('a turn that reads two files and edits one shows three cards, each named by its path', () => {
    const container = renderCards([
      read('r1', `${WORKSPACE_ROOT}\\src\\main\\index.ts`),
      read('r2', `${WORKSPACE_ROOT}\\src\\renderer\\src\\ChatNode.tsx`, { offset: 120, limit: 40 }),
      {
        id: 'e1',
        kind: 'edit',
        toolName: 'Edit',
        status: 'completed',
        title: 'Edited a file',
        rawInput: {
          file_path: `${WORKSPACE_ROOT}\\src\\shared\\agent.ts`,
          old_string: 'const a = 1',
          new_string: 'const a = 2'
        },
        startedAt: 0,
        endedAt: 100
      }
    ])

    const headers = cards(container).map((card) => within(card).getAllByRole('button')[0].textContent ?? '')
    expect(headers.length).toBe(3)
    // Collapsed, and still identifiable by path alone.
    expect(cards(container).every((card) => card.dataset.expanded === 'false')).toBe(true)
    expect(headers[0]).toContain('src/main/index.ts')
    expect(headers[1]).toContain('src/renderer/src/ChatNode.tsx:120-159')
    expect(headers[2]).toContain('src/shared/agent.ts')
    expect(cards(container).every((card) => card.dataset.family === 'file-operation')).toBe(true)
  })

  test('a worktree session shortens a file it read from the main checkout too', () => {
    const worktree = 'D:\\Development\\Toucan.worktrees\\feature'
    const { container } = render(
      <ChatView
        {...baseChatViewProps}
        activities={[read('r1', `${worktree}\\src\\a.ts`), read('r2', `${WORKSPACE_ROOT}\\src\\b.ts`)]}
        workspaceRoots={[worktree, WORKSPACE_ROOT]}
        focusMode={false}
        setFocusMode={vi.fn()}
      />
    )
    const headers = cards(container).map((card) => within(card).getAllByRole('button')[0].textContent ?? '')
    expect(headers[0]).toContain('src/a.ts')
    expect(headers[1]).toContain('src/b.ts')
  })

  test('a file outside the workspace keeps its full path', () => {
    const container = renderCards([read('r1', 'C:\\elsewhere\\notes.md')])
    expect(within(cards(container)[0]).getAllByRole('button')[0].textContent).toContain('C:/elsewhere/notes.md')
  })

  test('a read shows its excerpt numbered from the start of the range', () => {
    const container = renderCards([
      {
        ...read('r1', `${WORKSPACE_ROOT}\\src\\a.ts`, { offset: 10, limit: 3 }),
        content: 'alpha\nbeta\ngamma'
      }
    ])
    const card = expand(cards(container)[0])
    const lines = card.querySelectorAll('.file-op-line')
    expect(lines.length).toBe(3)
    expect(lines[0].textContent).toBe('10alpha')
    expect(lines[2].textContent).toBe('12gamma')
  })

  test('a write shows a size and a preview instead of the whole payload', () => {
    const payload = Array.from({ length: 500 }, (_, index) => `line ${index}`).join('\n')
    const container = renderCards([
      {
        id: 'w1',
        kind: 'edit',
        toolName: 'Write',
        status: 'completed',
        rawInput: { file_path: `${WORKSPACE_ROOT}\\out.txt`, content: payload },
        startedAt: 0,
        endedAt: 100
      }
    ])
    const card = expand(cards(container)[0])
    expect(card.textContent).toContain('500 lines')
    expect(card.querySelectorAll('.file-op-line').length).toBe(40)
    expect(within(card).getByRole('button', { name: /show 460 more lines/i })).toBeTruthy()
    expect(card.querySelectorAll('.file-op-line[data-tone="new"]')).toHaveLength(40)
  })

  test('an edit shows a compact before and after', () => {
    const container = renderCards([
      {
        id: 'e1',
        kind: 'edit',
        toolName: 'Edit',
        status: 'completed',
        rawInput: {
          file_path: `${WORKSPACE_ROOT}\\src\\a.ts`,
          old_string: 'const a = 1',
          new_string: 'const a = 2'
        },
        startedAt: 0,
        endedAt: 100
      }
    ])
    const card = expand(cards(container)[0])
    const before = card.querySelectorAll('.file-op-line[data-tone="old"]')
    const after = card.querySelectorAll('.file-op-line[data-tone="new"]')
    expect(before.length).toBe(1)
    expect(before[0].textContent).toContain('const a = 1')
    expect(after.length).toBe(1)
    expect(after[0].textContent).toContain('const a = 2')
  })

  test('an ACP multi-file edit renders one card with a highlighted diff for each file', () => {
    const container = renderCards([
      {
        id: 'e-multi',
        kind: 'edit',
        status: 'completed',
        diffs: [
          {
            path: `${WORKSPACE_ROOT}\\src\\a.ts`,
            oldText: ['const untouched = true', 'const answer = 41', 'export { answer }'].join('\n'),
            newText: ['const untouched = true', 'const answer = 42', 'export { answer }'].join('\n')
          },
          {
            path: `${WORKSPACE_ROOT}\\src\\b.ts`,
            oldText: 'export const enabled = false',
            newText: 'export const enabled = true'
          }
        ],
        startedAt: 0,
        endedAt: 100
      }
    ])

    expect(cards(container)).toHaveLength(1)
    const card = expand(cards(container)[0])
    expect(card.querySelectorAll('.file-op-path')).toHaveLength(2)
    expect(within(card.querySelectorAll('.file-op-path')[0] as HTMLElement).getByText('src/a.ts')).toBeInTheDocument()
    expect(within(card.querySelectorAll('.file-op-path')[1] as HTMLElement).getByText('src/b.ts')).toBeInTheDocument()
    expect(card.querySelectorAll('.file-op-hunk')).toHaveLength(2)
    expect(card.querySelector('.file-op-line[data-tone="new"] .hljs-number')?.textContent).toBe('42')
  })

  test('a full-file diff collapses unchanged regions to hunks with context', () => {
    const oldText = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
    const newText = [...oldText]
    newText[9] = 'line ten changed'
    const container = renderCards([
      {
        id: 'e-hunk',
        kind: 'edit',
        status: 'completed',
        diffs: [{ path: `${WORKSPACE_ROOT}\\src\\a.ts`, oldText: oldText.join('\n'), newText: newText.join('\n') }]
      }
    ])

    const card = expand(cards(container)[0])
    expect(card.textContent).toContain('@@ -7,7 +7,7 @@')
    expect(within(card).queryByText('line 1', { exact: true })).not.toBeInTheDocument()
    expect(within(card).queryByText('line 20', { exact: true })).not.toBeInTheDocument()
    expect(card.textContent).toContain('line 7')
    expect(card.textContent).toContain('line 13')
  })

  test('separate hunks for one file share one file heading and preserve multiline syntax state', () => {
    const oldLines = [
      '/* start',
      'continued */',
      'const first = false',
      ...Array.from({ length: 12 }, (_, i) => `const gap${i} = ${i}`),
      'const last = false'
    ]
    const newLines = [...oldLines]
    newLines[2] = 'const first = true'
    newLines[newLines.length - 1] = 'const last = true'
    const container = renderCards([
      {
        id: 'e-two-hunks',
        kind: 'edit',
        status: 'completed',
        diffs: [{ path: `${WORKSPACE_ROOT}\\src\\a.ts`, oldText: oldLines.join('\n'), newText: newLines.join('\n') }]
      }
    ])

    const card = expand(cards(container)[0])
    expect(card.querySelectorAll('.file-op-hunk')).toHaveLength(2)
    expect(card.querySelectorAll('.file-op-path')).toHaveLength(1)
    const continued = within(card).getByText('continued */')
    expect(continued.closest('.hljs-comment')).not.toBeNull()
  })

  test('a MultiEdit labels each of its edits', () => {
    const container = renderCards([
      {
        id: 'e2',
        kind: 'edit',
        toolName: 'MultiEdit',
        status: 'completed',
        rawInput: {
          file_path: `${WORKSPACE_ROOT}\\src\\a.ts`,
          edits: [
            { old_string: 'a', new_string: 'b' },
            { old_string: 'c', new_string: 'd' }
          ]
        },
        startedAt: 0,
        endedAt: 100
      }
    ])
    const card = expand(cards(container)[0])
    expect(card.textContent).toContain('Edit 1 of 2')
    expect(card.textContent).toContain('Edit 2 of 2')
    expect(within(cards(container)[0]).getAllByRole('button')[0].textContent).toContain('2 edits')
  })

  test('a notebook edit names the cell it replaced', () => {
    const container = renderCards([
      {
        id: 'n1',
        kind: 'edit',
        toolName: 'NotebookEdit',
        status: 'completed',
        rawInput: {
          notebook_path: `${WORKSPACE_ROOT}\\analysis.ipynb`,
          cell_id: 'cell-3',
          edit_mode: 'replace',
          new_source: 'print(1)'
        },
        startedAt: 0,
        endedAt: 100
      }
    ])
    const card = expand(cards(container)[0])
    expect(within(cards(container)[0]).getAllByRole('button')[0].textContent).toContain('analysis.ipynb')
    expect(card.textContent).toContain('Cell cell-3')
    expect(card.textContent).toContain('print(1)')
  })

  test('the full path can be copied and revealed', () => {
    const absolute = `${WORKSPACE_ROOT}\\src\\a.ts`
    const container = renderCards([read('r1', absolute)])
    const card = expand(cards(container)[0])
    fireEvent.click(within(card).getByRole('button', { name: /copy path/i }))
    expect(copyText).toHaveBeenCalledWith(absolute)
    fireEvent.click(within(card).getByRole('button', { name: /reveal/i }))
    expect(showItemInFolder).toHaveBeenCalledWith(absolute)
  })

  test('a still-running read is open and says so without a body it does not have yet', () => {
    const container = renderCards([
      {
        id: 'r1',
        kind: 'read',
        toolName: 'Read',
        status: 'in_progress',
        rawInput: { file_path: `${WORKSPACE_ROOT}\\src\\a.ts` },
        startedAt: 0
      }
    ])
    expect(cards(container)[0].dataset.expanded).toBe('true')
    expect(cards(container)[0].querySelectorAll('.file-op-line').length).toBe(0)
  })

  test('a tool that touches no file keeps the generic card', () => {
    // Whatever stands in for "no family claims this" has to be a tool no family claims: every
    // sub-issue that lands a card shrinks that set, so pick something outside all of them.
    const container = renderCards([
      {
        id: 'b1',
        kind: 'switch_mode',
        toolName: 'ExitPlanMode',
        title: 'Left plan mode',
        status: 'completed',
        rawInput: {},
        startedAt: 0,
        endedAt: 100
      }
    ])
    expect(cards(container)[0].dataset.family).toBe('generic')
  })
})
