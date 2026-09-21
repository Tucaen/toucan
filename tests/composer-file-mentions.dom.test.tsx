import { ReactFlowProvider } from '@xyflow/react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { TestChatView as ChatView, type TestChatViewProps as ChatViewProps } from './dom/chat-view-fixture'
import { ComposerSendKeyContext } from '../src/renderer/src/composer-send-key-context'
import ChatNode from '../src/renderer/src/ChatNode'
import type { ComposerFileMentions } from '../src/renderer/src/use-prompt-editor'
import {
  isTerminalCanvasNode,
  restoreCanvasWorkspace,
  type TerminalCanvasNode
} from '../src/renderer/src/canvas-workspace'
import type { WorkspaceState } from '../src/shared/terminal'
import type { WorkspaceFileIndex } from '../src/shared/workspace-files'
import { createMockAgentApi } from './dom/agent-api-mock'

// The composer's `@` file completion. Ranking, token detection and insertion are unit-tested in
// file-mention-completion.ts; this file checks the rendered composer is wired to them, reads the
// node's own working directory, and says what it is not showing.

const WORKTREE = 'D:\\Development\\ADE-worktrees\\feature'

const index = (overrides: Partial<WorkspaceFileIndex> = {}): WorkspaceFileIndex => ({
  root: WORKTREE,
  entries: [
    { path: 'README.md', directory: false },
    { path: 'src', directory: true },
    { path: 'src/main', directory: true },
    { path: 'src/main/index.ts', directory: false },
    { path: 'src/renderer/src/ChatNode.tsx', directory: false }
  ],
  truncated: false,
  gitignored: true,
  ...overrides
})

/** A saved chat node attached to a worktree, restored exactly as the workspace would restore it. */
function worktreeChatNode(): TerminalCanvasNode {
  const state: WorkspaceState = {
    version: 3,
    projects: [{ id: 'project-1', name: 'Toucan', path: '/project', color: '#71a9ff' }],
    activeProjectId: 'project-1',
    sidebarCollapsed: false,
    nodes: [
      {
        id: 'claude-node',
        kind: 'claude',
        label: 'Claude 1',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        position: { x: 0, y: 0 },
        width: 640,
        height: 480,
        focusMode: false
      }
    ],
    worktrees: [
      {
        id: 'worktree-1',
        projectId: 'project-1',
        branch: 'feature',
        path: '/project-worktree',
        baseRef: 'main',
        createdAt: '2026-08-30T00:00:00.000Z',
        position: { x: 0, y: 0 },
        width: 360,
        height: 232
      }
    ]
  }
  const node = restoreCanvasWorkspace(state, {
    onStatusChange: vi.fn(),
    onConversationId: vi.fn(),
    onTitleChange: vi.fn(async () => true),
    onFocusModeChange: vi.fn(),
    onDraftChange: vi.fn(),
    onPermissionModeChange: vi.fn(),
    onModelChange: vi.fn(),
    onResume: vi.fn(),
    onRemoveWorktree: vi.fn(),
    onCreateNodeInWorktree: vi.fn(),
    onRunSetupCommand: vi.fn()
  }).nodes.find(isTerminalCanvasNode)
  if (!node) throw new Error('Expected the saved chat node to restore.')
  return node
}

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
  queued: [],
  addImages: vi.fn(),
  removeAttachment: vi.fn(),
  submit: vi.fn(),
  sendMessage: vi.fn(),
  answerDecision: vi.fn(),
  editQueued: vi.fn(),
  withdrawQueued: vi.fn(),
  sendQueuedNow: vi.fn(),
  cancel: vi.fn(),
  authenticate: vi.fn(),
  submitAuthCode: vi.fn(),
  openAuthLink: vi.fn(),
  resolveApproval: vi.fn()
}

function renderChatView(mentions: Partial<ComposerFileMentions> = {}, overrides: Partial<ChatViewProps> = {}) {
  const read = vi.fn(async (root: string) => index({ root }))
  const fileMentions: ComposerFileMentions = { root: WORKTREE, recent: [], read, ...mentions }
  const view: ReactElement = (
    <ComposerSendKeyContext.Provider value={{ sendKey: 'enter', setSendKey: vi.fn() }}>
      <ChatView
        {...baseChatViewProps}
        fileMentions={fileMentions}
        {...overrides}
        focusMode={false}
        setFocusMode={vi.fn()}
      />
    </ComposerSendKeyContext.Provider>
  )
  return { container: render(view).container, read: fileMentions.read as typeof read }
}

function composer(): HTMLTextAreaElement {
  return screen.getByPlaceholderText('Message the agent...') as HTMLTextAreaElement
}

/** Types `value` into the composer with the caret parked at its end, as real typing leaves it. */
function type(value: string): HTMLTextAreaElement {
  const textarea = composer()
  fireEvent.change(textarea, { target: { value } })
  textarea.setSelectionRange(value.length, value.length)
  fireEvent.select(textarea)
  return textarea
}

const menu = (): HTMLElement => screen.getByRole('listbox', { name: 'Workspace files' })
const findMenu = (): Promise<HTMLElement> => screen.findByRole('listbox', { name: 'Workspace files' })
const queryMenu = (): HTMLElement | null => screen.queryByRole('listbox', { name: 'Workspace files' })

const optionLabels = (): (string | undefined)[] =>
  within(menu())
    .getAllByRole('option')
    .map((option) => option.querySelector('strong > span')?.textContent ?? undefined)

describe('composer file mentions', () => {
  test('typing @ lists the working directory’s files and folders', async () => {
    renderChatView()
    type('@')

    await findMenu()
    expect(optionLabels()).toEqual([
      'README.md',
      'src/',
      'src/main/',
      'src/main/index.ts',
      'src/renderer/src/ChatNode.tsx'
    ])
  })

  test('the index is read for the node’s resolved working directory, not the project checkout', async () => {
    const { read } = renderChatView()
    type('@')

    await findMenu()
    expect(read).toHaveBeenCalledWith(WORKTREE)
  })

  test('no directory is walked until a mention is actually being typed', () => {
    const { read } = renderChatView()
    type('describe the terminal manager')

    expect(read).not.toHaveBeenCalled()
    expect(queryMenu()).toBeNull()
  })

  test('typing narrows the list', async () => {
    renderChatView()
    type('@chat')

    await findMenu()
    expect(optionLabels()).toEqual(['src/renderer/src/ChatNode.tsx'])
  })

  test('files the agent has already read are offered first and marked as such', async () => {
    renderChatView({ recent: ['src/main/index.ts'] })
    type('@')

    await findMenu()
    expect(optionLabels()[0]).toBe('src/main/index.ts')
    expect(within(menu()).getAllByRole('option')[0].textContent).toContain('already read')
  })

  test('the menu says which files it is not showing', async () => {
    renderChatView()
    type('@')

    expect((await findMenu()).textContent).toContain('.gitignore')
  })

  test('a directory that is not a checkout says .gitignore is not in force', async () => {
    renderChatView({ read: async (root) => index({ root, gitignored: false }) })
    type('@')

    expect((await findMenu()).textContent).toContain('Not a git checkout')
  })

  test('Enter accepts the highlighted path and never submits the prompt', async () => {
    const submit = vi.fn()
    const { container } = renderChatView({}, { submit })
    const textarea = type('@chat')
    await findMenu()

    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(textarea.value).toBe('@src/renderer/src/ChatNode.tsx ')
    expect(textarea.selectionStart).toBe('@src/renderer/src/ChatNode.tsx '.length)
    expect(submit).not.toHaveBeenCalled()
    expect(container).toBeTruthy()
    expect(queryMenu()).toBeNull()
  })

  test('arrow keys move the selection before Tab accepts it', async () => {
    renderChatView()
    const textarea = type('@src/main')
    await findMenu()

    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    fireEvent.keyDown(textarea, { key: 'Tab' })

    expect(textarea.value).toBe('@src/main/index.ts ')
  })

  test('accepting a folder leaves the caret inside it so the path can be walked further', async () => {
    renderChatView()
    const textarea = type('@src')
    await findMenu()

    fireEvent.click(within(menu()).getAllByRole('option')[0])

    expect(textarea.value).toBe('@src/')
    expect(textarea.selectionStart).toBe('@src/'.length)
    // Still offering, because a folder is a step on the way somewhere.
    await waitFor(() => expect(queryMenu()).not.toBeNull())
  })

  test('Escape dismisses the menu without clearing the draft', async () => {
    renderChatView()
    const textarea = type('@chat')
    await findMenu()

    fireEvent.keyDown(textarea, { key: 'Escape' })

    expect(queryMenu()).toBeNull()
    expect(textarea.value).toBe('@chat')
  })

  test('an @ inside a word is ordinary prose, so an address never opens the menu', () => {
    const { read } = renderChatView()
    type('mail morgan@example.com')

    expect(queryMenu()).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  test('a slash command and a mention never share the composer; the token being typed wins', async () => {
    renderChatView({}, { commands: [{ name: 'review', description: 'Review the pending changes' }] })
    type('/rev')
    expect(screen.getByRole('listbox', { name: 'Slash commands' })).toBeTruthy()

    type('/rev @chat')
    await findMenu()
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).toBeNull()
  })

  test('the menu portals out of the clipping node so it can never be cut off', async () => {
    const { container } = renderChatView()
    type('@')
    await findMenu()

    expect(container.querySelector('[role="listbox"][aria-label="Workspace files"]')).toBeNull()
    expect(menu().parentElement).toBe(document.body)
    expect(getComputedStyle(menu()).position).toBe('fixed')
  })

  test('a node attached to a worktree is offered the worktree’s files, never the checkout’s', async () => {
    const agent = createMockAgentApi()
    window.agentApi = agent.api
    const read = vi.fn(async (root: string) => index({ root }))
    window.workspaceFilesApi = { index: read }
    const node = worktreeChatNode()
    render(
      <ComposerSendKeyContext.Provider value={{ sendKey: 'enter', setSendKey: vi.fn() }}>
        <ReactFlowProvider>
          <ChatNode
            id={node.id}
            data={node.data}
            type="terminalNode"
            dragging={false}
            zIndex={0}
            selectable
            deletable
            selected={false}
            draggable
            isConnectable={false}
            positionAbsoluteX={0}
            positionAbsoluteY={0}
          />
        </ReactFlowProvider>
      </ComposerSendKeyContext.Provider>
    )

    await waitFor(() => expect(composer()).not.toBeDisabled())
    type('@')

    await findMenu()
    expect(read).toHaveBeenCalledWith('/project-worktree')
    expect(read).not.toHaveBeenCalledWith('/project')
  })

  test('a directory that cannot be listed costs the completion and nothing else', async () => {
    renderChatView({ read: async () => Promise.reject(new Error('git exploded')) })
    const textarea = type('@src')

    await waitFor(() => expect(queryMenu()).toBeNull())
    expect(textarea.value).toBe('@src')
  })
})
