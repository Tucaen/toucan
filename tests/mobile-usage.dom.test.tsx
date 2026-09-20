import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import App from '../mobile/src/App'
import ChatScreen from '../mobile/src/ChatScreen'
import type { SavedHost } from '../mobile/src/hosts'
import type { AgentEvent, ProviderUsageReport } from '../src/shared/agent'
import { foldAgentEvent, initialAgentTranscriptState } from '../src/shared/agent-transcript'
import type { RemoteChatSummary, RemoteWorkspaceSnapshot } from '../src/shared/remote-access'
import type { RemoteChatServerMessage } from '../src/shared/remote-chat'

/**
 * Usage on the phone, rendered (issue #195). The maths has its own pure tests either side of this;
 * what only a DOM test can show is the half the ticket is actually about - that the answers reach
 * the two screens at all, that the *reset moment* is visible text rather than a tooltip a phone
 * cannot open, and that nothing here offers a refresh, because a forced read would boot a provider
 * CLI process on the desktop at whatever rate a paired client asked for.
 */

const HOST: SavedHost = { id: 'host-1', name: 'Work PC', origin: 'http://work-pc:1789', token: 'token' }

const SUMMARY: RemoteChatSummary = {
  id: 'chat-1',
  kind: 'claude',
  title: 'Fix the parser',
  projectId: 'toucan',
  status: 'idle',
  unread: 0
}

// The wall clock, because the screens derive their readouts against it: a fixed epoch would put
// every reset moment in the past, and "resets in 1h 30m" would render as "resets in now".
const NOW = Date.now()

const USAGE: ProviderUsageReport = {
  claude: {
    status: { fiveHour: { usedPercent: 40, resetsAt: NOW + 90 * 60_000 }, weekly: { usedPercent: 93 } },
    readAt: NOW - 30_000,
    stale: false
  }
}

const WORKSPACE: RemoteWorkspaceSnapshot = {
  updatedAt: NOW,
  projects: [{ id: 'toucan', name: 'Toucan', color: '#c992ff' }],
  chats: [SUMMARY]
}

class StubSocket {
  static instances: StubSocket[] = []
  static readonly OPEN = 1
  readyState = StubSocket.OPEN
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null

  constructor(
    readonly url: string,
    readonly protocols?: string[]
  ) {
    StubSocket.instances.push(this)
  }

  send(raw: string): void {
    this.sent.push(raw)
  }

  close(): void {
    this.readyState = 3
  }
}

function snapshotFrame(events: readonly AgentEvent[]): RemoteChatServerMessage {
  return {
    type: 'snapshot',
    state: events.reduce((state, event) => foldAgentEvent(state, event, NOW), initialAgentTranscriptState())
  }
}

/** Answers the two reads the list screen makes, so only the usage body varies between tests. */
function stubHost(usage: ProviderUsageReport): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.endsWith('/api/usage')) {
      return { ok: true, status: 200, json: async () => usage } as unknown as Response
    }
    if (url.endsWith('/api/workspace')) {
      return { ok: true, status: 200, json: async () => WORKSPACE } as unknown as Response
    }
    return { ok: true, status: 204, json: async () => ({}) } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock as unknown as ReturnType<typeof vi.fn>
}

beforeEach(() => {
  StubSocket.instances = []
  Element.prototype.scrollIntoView = () => {}
  vi.stubGlobal('WebSocket', StubSocket)
  window.localStorage.clear()
  window.localStorage.setItem(
    'toucan.hosts',
    JSON.stringify({ selectedId: HOST.id, hosts: [{ ...HOST, revoked: false }] })
  )
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('account usage on the chat list', () => {
  test('each provider becomes a card naming itself and every window it reported', async () => {
    stubHost(USAGE)
    render(<App />)

    const panel = await screen.findByLabelText('Account usage')
    expect(panel.textContent).toContain('Claude')
    expect(panel.textContent).toContain('5h')
    expect(panel.textContent).toContain('40%')
    expect(panel.textContent).toContain('7d')
    expect(panel.textContent).toContain('93%')
  })

  test('when the window resets is visible text, since a phone cannot open a tooltip', async () => {
    stubHost(USAGE)
    render(<App />)

    const panel = await screen.findByLabelText('Account usage')
    expect(panel.textContent).toMatch(/resets in \d+h \d+m/)
  })

  test('the card dates its own reading, which is all a surface with no refresh can do', async () => {
    stubHost(USAGE)
    render(<App />)

    const panel = await screen.findByLabelText('Account usage')
    expect(panel.textContent).toMatch(/Updated \d/)
  })

  test('nothing on the panel is a control: a forced read is the desktop chip’s alone', async () => {
    stubHost(USAGE)
    render(<App />)

    const panel = await screen.findByLabelText('Account usage')
    expect(panel.querySelectorAll('button')).toHaveLength(0)
  })

  test('a host with no reading to give shows no panel rather than an empty one', async () => {
    stubHost({})
    render(<App />)

    await screen.findByText('Fix the parser')
    expect(screen.queryByLabelText('Account usage')).not.toBeInTheDocument()
  })

  test('the poll is a plain read of /api/usage, never a forced one', async () => {
    const fetchMock = stubHost(USAGE)
    render(<App />)

    await screen.findByLabelText('Account usage')
    const usageCalls = fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes('/api/usage'))
    expect(usageCalls.length).toBeGreaterThan(0)
    for (const url of usageCalls) expect(url).toBe('http://work-pc:1789/api/usage')
  })

  test('a reading kept through a failed poll is marked rather than presented as the present', async () => {
    const stale: ProviderUsageReport = { claude: { ...USAGE.claude!, stale: true } }
    stubHost(stale)
    render(<App />)

    const panel = await screen.findByLabelText('Account usage')
    expect(panel.textContent).toMatch(/Last read failed/)
    expect((panel.querySelector('.provider-usage-card') as HTMLElement).dataset.stale).toBe('true')
  })
})

describe('this conversation’s own usage', () => {
  function openChat(usage: ProviderUsageReport, events: readonly AgentEvent[]): void {
    render(
      <ChatScreen
        host={HOST}
        chatId="chat-1"
        summary={SUMMARY}
        rateLimits={usage}
        onBack={() => {}}
        onUnauthorized={() => {}}
      />
    )
    const socket = StubSocket.instances[0]
    act(() => {
      socket.onopen?.()
      socket.onmessage?.({ data: JSON.stringify(snapshotFrame(events)) })
    })
  }

  const IDLE: AgentEvent = { type: 'status', status: 'idle' }

  beforeEach(() => {
    stubHost(USAGE)
  })

  test('context fill, cost and the nearest account window all reach the phone', async () => {
    openChat(USAGE, [IDLE, { type: 'usage', used: 48_000, size: 200_000, cost: { amount: 1.5, currency: 'USD' } }])

    const row = await screen.findByLabelText('Usage')
    expect(row.textContent).toContain('24%')
    expect(row.textContent).toContain('48.0k / 200k')
    expect(row.textContent).toContain('$1.50')
    // The 7d window is at 93% and the 5h at 40%, so the one that will actually stop the next turn
    // is the one the row spends its room on.
    expect(row.textContent).toContain('7d')
    expect(row.textContent).toContain('93%')
  })

  test('a conversation with nothing to report and no plan to name takes no room at all', () => {
    openChat({}, [IDLE])
    // Not merely empty-looking: the row is absent, so a session that has said nothing does not
    // reserve a band of a screen this size. Reaching a limit is still worth the row on its own -
    // that is the case below - but a conversation with neither has nothing to be a row about.
    expect(screen.queryByLabelText('Usage')).not.toBeInTheDocument()
  })

  test('the account window says when it resets, the one thing a tooltip would have hidden', async () => {
    openChat(USAGE, [IDLE, { type: 'usage', used: 10_000, size: 200_000 }])

    const row = await screen.findByLabelText('Usage')
    // The surfaced window is the 7d one, which reported no reset moment - so the note dates the
    // reading without inventing a reset. The 5h window's own reset lives on the list screen.
    expect(row.textContent).toMatch(/Updated \d/)
  })

  test('a window with a reset moment names it here rather than in a title', async () => {
    const soon: ProviderUsageReport = {
      claude: {
        status: { fiveHour: { usedPercent: 96, resetsAt: NOW + 90 * 60_000 } },
        readAt: NOW,
        stale: false
      }
    }
    openChat(soon, [IDLE, { type: 'usage', used: 10_000, size: 200_000 }])

    const row = await screen.findByLabelText('Usage')
    expect(row.textContent).toMatch(/5h resets in 1h 29m|5h resets in 1h 30m/)
  })

  test('a kept reading is dated and dimmed, never shown as the present', async () => {
    const stale: ProviderUsageReport = { claude: { ...USAGE.claude!, stale: true } }
    openChat(stale, [IDLE, { type: 'usage', used: 10_000, size: 200_000 }])

    const row = await screen.findByLabelText('Usage')
    // With no refresh anywhere on this device, an undated frozen percentage is the one way this
    // surface could actively mislead: the host's own admission has to reach the conversation too.
    expect(row.textContent).toMatch(/Last read failed/)
    expect((row.querySelector('.chat-usage-limit') as HTMLElement).dataset.stale).toBe('true')
  })

  test('a provider that has refused outright says so beside the figure', async () => {
    const refused: ProviderUsageReport = {
      claude: { status: { weekly: { usedPercent: 100 }, rejected: true }, readAt: NOW, stale: false }
    }
    openChat(refused, [IDLE, { type: 'usage', used: 10_000, size: 200_000 }])

    const row = await screen.findByLabelText('Usage')
    expect(row.textContent).toContain('Limit reached')
    expect((row.querySelector('.chat-usage-limit') as HTMLElement).dataset.level).toBe('critical')
  })

  test('a plan close to biting is worth the row even before the session reports any usage', async () => {
    openChat(USAGE, [IDLE])
    const row = await screen.findByLabelText('Usage')
    expect(row.textContent).toContain('7d')
    expect(row.textContent).toContain('93%')
  })

  test('a filling context warns in text, because there is no tooltip to put it in', async () => {
    openChat({}, [IDLE, { type: 'usage', used: 160_000, size: 200_000 }])

    const row = await screen.findByLabelText('Usage')
    expect(row.textContent).toContain('compacting soon')
    expect((row.querySelector('.usage-window') as HTMLElement).dataset.level).toBe('warning')
  })

  test('only this chat’s provider is read, never whichever plan happens to be worse', async () => {
    const both: ProviderUsageReport = {
      ...USAGE,
      codex: { status: { weekly: { usedPercent: 99 } }, readAt: NOW, stale: false }
    }
    openChat(both, [IDLE, { type: 'usage', used: 10_000, size: 200_000 }])

    const row = await screen.findByLabelText('Usage')
    // This is a Claude chat; Codex being nearly out is not what will stop it.
    expect(row.textContent).not.toContain('99%')
    expect(row.textContent).toContain('93%')
  })

  test('a reloaded deep link reads its own usage at once and its plan once the host names it', async () => {
    render(
      <ChatScreen
        host={HOST}
        chatId="chat-1"
        summary={null}
        rateLimits={USAGE}
        onBack={() => {}}
        onUnauthorized={() => {}}
      />
    )
    const socket = StubSocket.instances[0]
    act(() => {
      socket.onopen?.()
      socket.onmessage?.({
        data: JSON.stringify(snapshotFrame([{ type: 'usage', used: 20_000, size: 200_000 }]))
      })
    })

    const row = await screen.findByLabelText('Usage')
    // The session half needs nothing but the socket, so it is there whatever the workspace read
    // is doing - which is the point: a deep link opened from a notification is still readable.
    expect(row.textContent).toContain('10%')
    // The plan half waits on that read to say which provider this chat runs on, rather than
    // guessing one: which plan is nearly out is exactly what a reader would act on.
    await waitFor(() => expect(row.textContent).toContain('93%'))
  })
})
