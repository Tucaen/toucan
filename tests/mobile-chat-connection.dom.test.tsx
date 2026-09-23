import { act, render, screen } from '@testing-library/react'
import { afterEach, assert, beforeEach, describe, expect, test, vi } from 'vitest'
import { reconnectDelayMs } from '../mobile/src/chat-connection'
import type { SavedHost } from '../mobile/src/hosts'
import { useChatConnection } from '../mobile/src/use-chat-connection'
import type { RemoteWorkspaceSnapshot } from '../src/shared/remote-access'

/**
 * What the hook does when a socket drops, which is the half `tests/mobile-chat-connection.test.ts`
 * cannot reach: that file drives the pure reducer, and the reducer never sees a close.
 *
 * A closed WebSocket is ambiguous by design - the browser will not say whether the handshake was
 * refused with 401, refused with 404, or the network merely blinked - so every drop is classified
 * through one authenticated probe of `/api/workspace`, and it is the three outcomes of *that*
 * which are worth pinning: a revoked token unpairs the host and stops, a chat the desktop no
 * longer lists is said out loud without giving up, and anything else is a blip worth rejoining
 * after a bounded backoff. The fourth assertion is disposal: an unmounted screen must stop.
 */

const HOST: SavedHost = { id: 'host-1', name: 'Work PC', origin: 'http://work-pc:7391', token: 'token' }

/** The one socket a render opens, with `onclose` reachable from the test. */
class StubSocket {
  static instances: StubSocket[] = []
  static readonly OPEN = 1
  readyState = StubSocket.OPEN
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  closedByClient = false

  constructor(
    readonly url: string,
    readonly protocols?: string[]
  ) {
    StubSocket.instances.push(this)
  }

  send(): void {}

  close(): void {
    this.readyState = 3
    this.closedByClient = true
  }

  /** The socket drops with nobody having said why - which is every real drop. */
  drop(): void {
    this.readyState = 3
    this.onclose?.()
  }
}

function snapshot(chatIds: readonly string[], updatedAt = 1): RemoteWorkspaceSnapshot {
  return {
    updatedAt,
    projects: [{ id: 'toucan', name: 'Toucan', color: '#71a9ff' }],
    chats: chatIds.map((id) => ({
      id,
      kind: 'claude' as const,
      title: id,
      projectId: 'toucan',
      status: 'working' as const,
      unread: 0
    }))
  }
}

/** What the probe finds. Set per test; every call answers with the current value. */
let probe: () => Response
let probes = 0

function Probe({ onUnauthorized }: { onUnauthorized: () => void }): JSX.Element {
  const connection = useChatConnection(HOST, 'chat-1', onUnauthorized)
  return <div data-testid="phase">{connection.phase}</div>
}

function phase(): string {
  return screen.getByTestId('phase').textContent ?? ''
}

/** Lets the probe's promise chain settle without letting the backoff timer fire. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  StubSocket.instances = []
  probes = 0
  probe = () => new Response(JSON.stringify(snapshot(['chat-1'])), { status: 200 })
  vi.stubGlobal('WebSocket', StubSocket)
  vi.stubGlobal('fetch', () => {
    probes += 1
    return Promise.resolve(probe())
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('what the phone does when a chat socket drops', () => {
  test('a revoked token unpairs the host and stops, rather than retrying against a dead token', async () => {
    probe = () => new Response('{"error":"unauthorized"}', { status: 401 })
    const unauthorized = vi.fn()
    render(<Probe onUnauthorized={unauthorized} />)

    act(() => StubSocket.instances[0]!.drop())
    await settle()

    expect(unauthorized).toHaveBeenCalledTimes(1)
    // No timer was scheduled, so no amount of waiting opens a second socket.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    assert.equal(StubSocket.instances.length, 1)
  })

  test('a chat the desktop no longer lists is said out loud, and the probe keeps running', async () => {
    probe = () => new Response(JSON.stringify(snapshot(['chat-2'])), { status: 200 })
    render(<Probe onUnauthorized={vi.fn()} />)

    act(() => StubSocket.instances[0]!.drop())
    await settle()
    assert.equal(phase(), 'gone')

    // Not terminal: a desktop that restarts re-lists its chats moments later, so the rejoin has to
    // still be scheduled - and a successful one flips the state back.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(reconnectDelayMs(0))
    })
    assert.equal(StubSocket.instances.length, 2)
  })

  test('a desktop that has reported nothing yet is a restart window, not a closure', async () => {
    probe = () => new Response(JSON.stringify(snapshot([], 0)), { status: 200 })
    render(<Probe onUnauthorized={vi.fn()} />)

    act(() => StubSocket.instances[0]!.drop())
    await settle()

    assert.equal(phase(), 'connecting', 'an unreported workspace must not read as a closed chat')
  })

  test('an unreachable host is a blip: rejoin on a backoff that resets once the socket opens', async () => {
    probe = () => {
      throw new Error('Failed to fetch')
    }
    render(<Probe onUnauthorized={vi.fn()} />)

    // Three drops in a row walk the delay up; each rejoin is scheduled only after the probe answered.
    for (const attempt of [0, 1, 2]) {
      act(() => StubSocket.instances[StubSocket.instances.length - 1]!.drop())
      await settle()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(reconnectDelayMs(attempt) - 1)
      })
      assert.equal(StubSocket.instances.length, attempt + 1, `no early rejoin at attempt ${attempt}`)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      assert.equal(StubSocket.instances.length, attempt + 2)
    }

    // A socket that opens is the host being back, so the next blip starts from the short delay again.
    const rejoined = StubSocket.instances[StubSocket.instances.length - 1]!
    act(() => rejoined.onopen?.())
    act(() => rejoined.drop())
    await settle()
    const before = StubSocket.instances.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(reconnectDelayMs(0))
    })
    assert.equal(StubSocket.instances.length, before + 1, 'the backoff was reset by the successful open')
  })

  test('an unmounted screen stops: no rejoin, no probe, and the live socket is closed', async () => {
    const { unmount } = render(<Probe onUnauthorized={vi.fn()} />)
    const first = StubSocket.instances[0]!

    act(() => first.drop())
    await settle()
    const probesBeforeUnmount = probes

    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    assert.equal(StubSocket.instances.length, 1)
    assert.equal(probes, probesBeforeUnmount)
  })

  test('a live socket is closed on unmount rather than left holding the host', () => {
    const { unmount } = render(<Probe onUnauthorized={vi.fn()} />)
    const socket = StubSocket.instances[0]!
    act(() => socket.onopen?.())

    unmount()
    assert.equal(socket.closedByClient, true)
  })
})
