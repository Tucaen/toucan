import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { ChatView, type ChatViewProps } from '../src/renderer/src/ChatNode'
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
      rawInput: { command: 'npm test', cwd: '/workspace/ade' }
    })

    render(
      <ChatView
        {...baseChatViewProps}
        approval={{
          id: 'approval-1',
          title,
          options: [{ id: 'allow', label: 'Allow Once', kind: 'allow_once' }]
        }}
        worklogCollapsed
        setWorklogCollapsed={vi.fn()}
      />
    )

    expect(screen.getByText('Run command: npm test')).toBeInTheDocument()
  })
})
