import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { expect, test, vi } from 'vitest'
import { ChatView, type ChatViewProps } from '../src/renderer/src/ChatNode'

const baseProps: ChatViewProps = {
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
  setDraft: vi.fn(),
  addImages: vi.fn(),
  removeAttachment: vi.fn(),
  submit: vi.fn(),
  cancel: vi.fn(),
  authenticate: vi.fn(),
  openAuthLink: vi.fn(),
  submitAuthCode: vi.fn(),
  resolveApproval: vi.fn(),
  sendMessage: vi.fn(),
  answerDecision: vi.fn()
}

test('captain typing updates the input without rerendering application workload', () => {
  let workloadRenders = 0
  let updateLifecycle = (): void => {}

  function ApplicationWorkload(): JSX.Element {
    workloadRenders += 1
    return <span>Captain status</span>
  }

  function CaptainHarness(): JSX.Element {
    const [draft, setDraft] = useState('')
    const [lifecycleVersion, setLifecycleVersion] = useState(0)
    updateLifecycle = () => setLifecycleVersion((value) => value + 1)
    return (
      <>
        <span>Lifecycle update {lifecycleVersion}</span>
        <ChatView
          {...baseProps}
          draft={draft}
          setDraft={setDraft}
          worklogCollapsed
          setWorklogCollapsed={vi.fn()}
          statusBar={<ApplicationWorkload />}
        />
      </>
    )
  }

  render(<CaptainHarness />)
  const textarea = screen.getByPlaceholderText('Message the agent...')
  textarea.focus()
  expect(workloadRenders).toBe(1)

  fireEvent.change(textarea, { target: { value: 'responsive typing' } })

  expect(textarea).toHaveValue('responsive typing')
  expect(workloadRenders).toBe(1)

  act(() => updateLifecycle())
  expect(textarea).toHaveValue('responsive typing')
  expect(textarea).toHaveFocus()
  expect(workloadRenders).toBe(2)
})
