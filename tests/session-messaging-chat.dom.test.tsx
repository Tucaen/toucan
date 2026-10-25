import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TestChatView as ChatView } from './dom/chat-view-fixture'
import { useAgentConversation } from '../src/renderer/src/use-agent-conversation'
import { createMockAgentApi } from './dom/agent-api-mock'
import {
  applyMessagingEvent,
  EMPTY_MESSAGING_VIEW,
  messagingEntriesFor,
  messagingNoticesFor,
  type SessionMessagingView
} from '../src/renderer/src/session-messaging-view'
import type { SessionMessage } from '../src/shared/session-messaging'

// A chat renders the entries and refusal notices messaging hands it (#3), labelled and inline.

const A = 'aaaaaaaa-1111'
const B = 'bbbbbbbb-2222'

const ask: SessionMessage = {
  id: 'm1',
  kind: 'ask',
  from: A,
  to: B,
  fromTitle: 'Alpha',
  toTitle: 'Beta',
  text: 'Which port?',
  depth: 1,
  createdAt: '2026-10-25T10:00:00.000Z',
  delivery: 'queued',
  queuedBecause: 'waiting_on_human'
}

function Harness(props: { nodeId: string; view: SessionMessagingView; dismiss?(key: string): void }): JSX.Element {
  const conversation = useAgentConversation({
    id: props.nodeId,
    provider: 'claude',
    cwd: '/project',
    enabled: true,
    onSessionId: vi.fn(),
    onPermissionMode: vi.fn(),
    onModel: vi.fn()
  })
  return (
    <ChatView
      {...conversation}
      provider="claude"
      focusMode={false}
      setFocusMode={vi.fn()}
      messaging={{
        entries: messagingEntriesFor(props.view, props.nodeId),
        notices: messagingNoticesFor(props.view, props.nodeId),
        dismissNotice: props.dismiss ?? vi.fn()
      }}
    />
  )
}

function mount(nodeId: string, view: SessionMessagingView, dismiss?: (key: string) => void): void {
  window.agentApi = createMockAgentApi({
    create: vi.fn(async () => ({ ok: true, status: 'ready' as const, imageSupport: false }))
  }).api
  render(<Harness nodeId={nodeId} view={view} dismiss={dismiss} />)
}

afterEach(cleanup)

describe('messaging in the chat', () => {
  const view = applyMessagingEvent(EMPTY_MESSAGING_VIEW, { type: 'message', message: ask })

  test('the asker and the target each see the message, labelled, with the queued reason', async () => {
    mount(A, view)
    await waitFor(() => expect(screen.getByText('Question to Beta (bbbbbbbb)')).toBeInTheDocument())
    expect(screen.getByText('Which port?')).toBeInTheDocument()
    expect(screen.getByText('queued: target waiting on human')).toBeInTheDocument()
    cleanup()
    mount(B, view)
    await waitFor(() => expect(screen.getByText('Question from Alpha (aaaaaaaa)')).toBeInTheDocument())
  })

  test('an implicit reply is labelled as implicit', async () => {
    const withReply = applyMessagingEvent(view, {
      type: 'message',
      message: {
        ...ask,
        id: 'm2',
        kind: 'reply',
        fromTitle: 'Beta',
        toTitle: 'Alpha',
        from: B,
        to: A,
        askId: 'm1',
        replyKind: 'implicit',
        delivery: 'delivered',
        text: '8080'
      }
    })
    mount(A, withReply)
    await waitFor(() => expect(screen.getByText('Implicit reply from Beta (bbbbbbbb)')).toBeInTheDocument())
  })

  test('a refusal shows as an alert on the session it names, and dismissing it asks the host to drop it', async () => {
    const refused = applyMessagingEvent(EMPTY_MESSAGING_VIEW, {
      type: 'notice',
      nodeId: A,
      text: 'Message refused: at most 5 asks per turn',
      at: '2026-10-25T10:02:00.000Z'
    })
    const dismiss = vi.fn()
    mount(A, refused, dismiss)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Message refused: at most 5 asks per turn')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notice' }))
    expect(dismiss).toHaveBeenCalledWith(messagingNoticesFor(refused, A)[0]!.key)
  })

  test('a session the notice does not name shows nothing', async () => {
    const refused = applyMessagingEvent(EMPTY_MESSAGING_VIEW, { type: 'notice', nodeId: A, text: 'refused', at: 'x' })
    mount(B, refused)
    await screen.findByPlaceholderText(/message the agent/i)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
