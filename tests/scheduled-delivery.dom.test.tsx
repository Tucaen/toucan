import { act, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ScheduledMessage } from '../src/shared/scheduled-message'
import { useAgentConversation } from '../src/renderer/src/use-agent-conversation'
import { useScheduledMessages } from '../src/renderer/src/use-scheduled-messages'
import { createMockAgentApi } from './dom/agent-api-mock'
import { fakeSubmitEvent } from './dom/form-event'

// The node owns the list (it is persisted with it), so every test stands in for the node with a
// piece of state the hook publishes into - exactly the round trip ChatNode makes through App.
function useNodeScheduler(options: {
  initial?: ScheduledMessage[]
  canDeliver: boolean
  deliver(entry: ScheduledMessage): void
}): ReturnType<typeof useScheduledMessages> {
  const [messages, setMessages] = useState<ScheduledMessage[]>(options.initial ?? [])
  return useScheduledMessages({
    messages,
    onChange: setMessages,
    canDeliver: options.canDeliver,
    deliver: options.deliver
  })
}

const image = { id: 'image-1', data: 'aGVsbG8=', mimeType: 'image/png' }

describe('automatic delivery while Toucan is running', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 25, 12, 0))
  })
  afterEach(() => vi.useRealTimers())

  test('a scheduled message is delivered at its time and leaves the list', () => {
    const deliver = vi.fn<(entry: ScheduledMessage) => void>()
    const { result } = renderHook(() => useNodeScheduler({ canDeliver: true, deliver }))

    act(() => {
      expect(result.current.schedule({ text: 'ship it', images: [image], deliverAt: Date.now() + 60_000 }).ok).toBe(
        true
      )
    })
    expect(result.current.messages).toHaveLength(1)

    act(() => vi.advanceTimersByTime(59_000))
    expect(deliver).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(1_000))
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ text: 'ship it', images: [image] }))
    expect(result.current.messages).toEqual([])
  })

  test('refuses a time in the past and keeps nothing', () => {
    const { result } = renderHook(() => useNodeScheduler({ canDeliver: true, deliver: vi.fn() }))

    act(() => {
      expect(result.current.schedule({ text: 'too late', images: [], deliverAt: Date.now() - 1 }).ok).toBe(false)
    })
    expect(result.current.messages).toEqual([])
  })

  test('a far-off time does not overflow the timer into an immediate delivery', () => {
    const deliver = vi.fn<(entry: ScheduledMessage) => void>()
    const { result } = renderHook(() => useNodeScheduler({ canDeliver: true, deliver }))

    act(() => {
      result.current.schedule({ text: 'next month', images: [], deliverAt: Date.now() + 40 * 24 * 3_600_000 })
    })
    act(() => vi.advanceTimersByTime(3 * 3_600_000))

    expect(deliver).not.toHaveBeenCalled()
  })

  test('a message that comes due while the session cannot take it waits for the session', () => {
    const deliver = vi.fn<(entry: ScheduledMessage) => void>()
    const { result, rerender } = renderHook(
      ({ canDeliver }: { canDeliver: boolean }) => useNodeScheduler({ canDeliver, deliver }),
      { initialProps: { canDeliver: false } }
    )
    act(() => {
      result.current.schedule({ text: 'when ready', images: [], deliverAt: Date.now() + 1_000 })
    })
    act(() => vi.advanceTimersByTime(5_000))
    expect(deliver).not.toHaveBeenCalled()

    rerender({ canDeliver: true })
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  test('a due message the session cannot take yet does not keep the timer spinning', () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return useNodeScheduler({ canDeliver: false, deliver: vi.fn() })
    })
    act(() => {
      result.current.schedule({ text: 'when ready', images: [], deliverAt: Date.now() + 1_000 })
    })
    const before = renders
    // A real clock moves between two reads, so a re-armed zero-delay wake would set a new time and
    // render again each tick; the fake clock alone would hide that behind an unchanged state.
    const realNow = Date.now.bind(Date)
    let drift = 0
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + (drift += 1))
    for (let step = 0; step < 20; step += 1) act(() => vi.advanceTimersByTime(3_000))

    // One wake at the due time, and then nothing until the session changes.
    expect(renders - before).toBeLessThanOrEqual(2)
  })

  test('messages due together go out one per render, each seeing the session the last one left', () => {
    const deliver = vi.fn<(entry: ScheduledMessage) => void>()
    const at = Date.now() + 1_000
    const { result } = renderHook(() =>
      useNodeScheduler({
        canDeliver: true,
        deliver,
        initial: [
          { id: 'a', text: 'first', images: [], deliverAt: at },
          { id: 'b', text: 'second', images: [], deliverAt: at }
        ]
      })
    )
    act(() => vi.advanceTimersByTime(1_000))

    expect(deliver.mock.calls.map(([entry]) => entry.text)).toEqual(['first', 'second'])
    expect(result.current.messages).toEqual([])
  })

  test('a message being edited is held past its time and goes out once the edit is closed', () => {
    const deliver = vi.fn<(entry: ScheduledMessage) => void>()
    const { result } = renderHook(() => useNodeScheduler({ canDeliver: true, deliver }))
    act(() => {
      result.current.schedule({ text: 'draft', images: [], deliverAt: Date.now() + 1_000 })
    })
    const [entry] = result.current.messages
    act(() => result.current.hold(entry.id, true))
    act(() => vi.advanceTimersByTime(2_000))
    expect(deliver).not.toHaveBeenCalled()

    act(() => result.current.hold(entry.id, false))
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  test('editing rewrites the text and time; cancelling removes the message undelivered', () => {
    const deliver = vi.fn<(entry: ScheduledMessage) => void>()
    const { result } = renderHook(() => useNodeScheduler({ canDeliver: true, deliver }))
    act(() => {
      result.current.schedule({ text: 'first idea', images: [], deliverAt: Date.now() + 1_000 })
      result.current.schedule({ text: 'to cancel', images: [], deliverAt: Date.now() + 2_000 })
    })
    const [first, second] = result.current.messages
    act(() => {
      expect(result.current.edit(first.id, { text: 'better idea', deliverAt: Date.now() + 10_000 }).ok).toBe(true)
      result.current.cancel(second.id)
    })
    act(() => vi.advanceTimersByTime(5_000))
    expect(deliver).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(5_000))
    expect(deliver.mock.calls.map(([entry]) => entry.text)).toEqual(['better idea'])
  })
})

describe('overdue messages', () => {
  const overdue: ScheduledMessage = { id: 'late', text: 'missed', images: [image], deliverAt: 1, overdue: true }

  test('are never sent on their own', () => {
    const deliver = vi.fn<(entry: ScheduledMessage) => void>()
    const { result } = renderHook(() => useNodeScheduler({ canDeliver: true, deliver, initial: [overdue] }))

    expect(deliver).not.toHaveBeenCalled()
    expect(result.current.messages).toEqual([overdue])
  })

  test('go out only when Send now is chosen, and only to a session that can take them', () => {
    const deliver = vi.fn<(entry: ScheduledMessage) => void>()
    const { result, rerender } = renderHook(
      ({ canDeliver }: { canDeliver: boolean }) => useNodeScheduler({ canDeliver, deliver, initial: [overdue] }),
      { initialProps: { canDeliver: false } }
    )
    act(() => result.current.sendNow('late'))
    expect(deliver).not.toHaveBeenCalled()
    expect(result.current.messages).toEqual([overdue])

    rerender({ canDeliver: true })
    act(() => result.current.sendNow('late'))
    expect(deliver).toHaveBeenCalledWith(overdue)
    expect(result.current.messages).toEqual([])
  })

  test('can be edited while staying overdue, or cancelled', () => {
    const { result } = renderHook(() => useNodeScheduler({ canDeliver: true, deliver: vi.fn(), initial: [overdue] }))
    act(() => {
      result.current.edit('late', { text: 'missed, revised', deliverAt: overdue.deliverAt })
    })
    expect(result.current.messages).toEqual([{ ...overdue, text: 'missed, revised' }])

    act(() => result.current.cancel('late'))
    expect(result.current.messages).toEqual([])
  })
})

describe('through the conversation', () => {
  test('a due message is submitted like a composer send, and queues behind a busy agent', async () => {
    const { api, emit } = createMockAgentApi()
    window.agentApi = api
    const { result } = renderHook(() => {
      const conversation = useAgentConversation({
        id: 'scheduled-session',
        provider: 'claude',
        cwd: '/project',
        enabled: true,
        onSessionId: vi.fn(),
        onPermissionMode: vi.fn(),
        onModel: vi.fn()
      })
      const scheduler = useNodeScheduler({
        canDeliver: conversation.status === 'ready' || conversation.status === 'working',
        deliver: (entry) => conversation.submitContent(entry.text, entry.images)
      })
      return { conversation, scheduler }
    })
    await waitFor(() => expect(result.current.conversation.status).toBe('ready'))

    act(() => {
      result.current.scheduler.schedule({ text: 'while idle', images: [], deliverAt: Date.now() + 30 })
    })
    await waitFor(() => expect(api.prompt).toHaveBeenCalledWith('scheduled-session', 'while idle'))
    await waitFor(() => expect(result.current.conversation.status).toBe('working'))

    // The agent is still on that turn when the next one comes due: it joins the ordinary outbox,
    // attachments and all, rather than being steered into the running turn.
    act(() => {
      result.current.scheduler.schedule({ text: 'while busy', images: [image], deliverAt: Date.now() + 30 })
    })
    await waitFor(() => expect(result.current.scheduler.messages).toEqual([]))
    expect(result.current.conversation.queued).toEqual([
      { id: expect.any(String), text: 'while busy', images: [image] }
    ])
    expect(api.promptWhenIdle).not.toHaveBeenCalled()

    emit('scheduled-session', { type: 'status', status: 'ready' })
    await waitFor(() =>
      expect(api.prompt).toHaveBeenCalledWith('scheduled-session', [
        { type: 'text', text: 'while busy' },
        { type: 'image', data: image.data, mimeType: image.mimeType }
      ])
    )
  })

  test('scheduling from the composer takes its attachments with it', async () => {
    const { api } = createMockAgentApi()
    window.agentApi = api
    const { result } = renderHook(() =>
      useAgentConversation({
        id: 'attachments-session',
        provider: 'claude',
        cwd: '/project',
        enabled: true,
        onSessionId: vi.fn(),
        onPermissionMode: vi.fn(),
        onModel: vi.fn()
      })
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const file = new File(['hello'], 'shot.png', { type: 'image/png' })
    await act(() => result.current.addImages([file]))
    expect(result.current.attachments).toHaveLength(1)

    let taken: unknown[] = []
    act(() => {
      taken = result.current.takeAttachments()
    })
    expect(taken).toEqual([expect.objectContaining({ mimeType: 'image/png' })])
    expect(result.current.attachments).toEqual([])
    // Nothing was sent: the attachments left with the scheduled message, not with a prompt.
    act(() => result.current.submit(fakeSubmitEvent(), ''))
    expect(api.prompt).not.toHaveBeenCalled()
  })
})
