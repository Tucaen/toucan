import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { TestChatView as ChatView, type TestChatViewProps as ChatViewProps } from './dom/chat-view-fixture'
import { agentPermissionTitle } from '../src/shared/agent-permission'

const baseChatViewProps: ChatViewProps = {
  provider: 'codex',
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
  setDraft: vi.fn(),
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

describe('permission dialog details', () => {
  test('shows the command requested by a title-less Codex approval', () => {
    const title = agentPermissionTitle({
      kind: 'execute',
      rawInput: { command: 'npm test', cwd: '/workspace/toucan' }
    })

    render(
      <ChatView
        {...baseChatViewProps}
        approval={{
          id: 'approval-1',
          title,
          options: [{ id: 'allow', label: 'Allow Once', kind: 'allow_once' }]
        }}
        focusMode={false}
        setFocusMode={vi.fn()}
      />
    )

    expect(screen.getByText('Run command: npm test')).toBeInTheDocument()
  })

  test('a file edit approval puts accept and reject on its inline diff', () => {
    const resolveApproval = vi.fn()
    render(
      <ChatView
        {...baseChatViewProps}
        approval={{
          id: 'approval-edit',
          title: 'Change file: /workspace/toucan/src/a.ts',
          options: [
            { id: 'allow', label: 'Accept', kind: 'allow_once' },
            { id: 'reject', label: 'Reject', kind: 'reject_once' }
          ],
          activity: {
            id: 'tool-edit',
            kind: 'edit',
            diffs: [{ path: '/workspace/toucan/src/a.ts', oldText: 'const n = 1', newText: 'const n = 2' }]
          }
        }}
        workspaceRoots={['/workspace/toucan']}
        resolveApproval={resolveApproval}
        focusMode={false}
        setFocusMode={vi.fn()}
      />
    )

    const panel = screen.getByText('Permission requested').closest('.chat-approval-panel') as HTMLElement
    expect(within(panel).getByText('src/a.ts')).toBeInTheDocument()
    expect(panel.querySelector('.file-op-line[data-tone="old"]')?.textContent).toContain('const n = 1')
    expect(panel.querySelector('.file-op-line[data-tone="new"]')?.textContent).toContain('const n = 2')
    fireEvent.click(within(panel).getByRole('button', { name: 'Accept' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Reject' }))
    expect(resolveApproval).toHaveBeenNthCalledWith(1, 'approval-edit', 'allow')
    expect(resolveApproval).toHaveBeenNthCalledWith(2, 'approval-edit', 'reject')
  })
})
