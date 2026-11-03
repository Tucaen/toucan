import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import App from '../mobile/src/App'
import AppUpdatePanel from '../mobile/src/AppUpdatePanel'
import { followRestart, RESTART_STALL_MS } from '../mobile/src/app-update-view'
import type { SavedHost } from '../mobile/src/hosts'
import type { AppUpdateSnapshot } from '../src/shared/app-update'
import type { RemoteRestartWarning } from '../src/shared/remote-app-update'

/**
 * Updating the desktop from the phone (#5): the card shows the host's own update state, checks and
 * restarts through the host, confirms busy sessions on the phone, and treats the host going quiet
 * after a restart as the restart working rather than as an error.
 */

const HOST: SavedHost = { id: 'host-1', name: 'Work PC', origin: 'http://work-pc:1789', token: 'token' }
const IDLE: AppUpdateSnapshot = { currentVersion: '0.25.8', status: { phase: 'idle' } }
const DOWNLOADED: AppUpdateSnapshot = { currentVersion: '0.25.8', status: { phase: 'downloaded', version: '0.25.9' } }
const UPDATED: AppUpdateSnapshot = { currentVersion: '0.25.9', status: { phase: 'idle' } }
const WARNING: RemoteRestartWarning = {
  title: 'Restart to update?',
  message: '1 background task still running in 1 session.',
  detail: 'Restarting to install the update stops them.\n\nBackground tasks:\n• Dev server',
  proceedLabel: 'Restart anyway'
}

const reply = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response

/** A host whose answers each test sets: the state read, the check, and the restart. */
interface StubHost {
  state: () => Response
  check: () => Response
  restart: (body: string) => Response
}

let host: StubHost
let fetchStub: Mock

const requests = (path: string): RequestInit[] =>
  fetchStub.mock.calls.filter(([url]) => String(url).endsWith(path)).map(([, init]) => init as RequestInit)

beforeEach(() => {
  host = {
    state: () => reply(200, IDLE),
    check: () => reply(200, { ...IDLE, status: { phase: 'up-to-date' } }),
    restart: () => reply(202, { restarting: true })
  }
  fetchStub = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/app-update')) return host.state()
    if (url.endsWith('/api/app-update/check')) return host.check()
    if (url.endsWith('/api/app-update/restart')) return host.restart(typeof init?.body === 'string' ? init.body : '')
    // Only the list-screen test reads it: an empty workspace, so the card is all there is to find.
    if (url.endsWith('/api/workspace')) return reply(200, { updatedAt: 1, projects: [], chats: [] })
    return reply(404, {})
  })
  vi.stubGlobal('fetch', fetchStub)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function show(offline = false): void {
  render(<AppUpdatePanel host={HOST} offline={offline} onUnauthorized={() => {}} />)
}

describe('the update card', () => {
  test('shows the running version and checks through the host', async () => {
    show()
    expect(await screen.findByText('Toucan 0.25.8')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(await screen.findByText('Toucan 0.25.8 is the latest version.')).toBeTruthy()
    expect(requests('/api/app-update/check')).toHaveLength(1)
    expect(requests('/api/app-update/check')[0].headers).toMatchObject({ authorization: 'Bearer token' })
  })

  test('a download in progress is shown without a button to press', async () => {
    host.state = () => reply(200, { currentVersion: '0.25.8', status: { phase: 'available', version: '0.25.9' } })
    show()
    expect(await screen.findByText('Toucan 0.25.9 is downloading…')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  test('a failed check or download is shown, and the check can be repeated', async () => {
    host.state = () => reply(200, { currentVersion: '0.25.8', status: { phase: 'error', message: 'offline' } })
    host.check = () => reply(200, { currentVersion: '0.25.8', status: { phase: 'error', message: 'feed 404' } })
    show()
    expect(await screen.findByText('Update check failed: offline')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(await screen.findByText('Update check failed: feed 404')).toBeTruthy()
  })

  test('a host refusing the check is reported in its own words', async () => {
    host.check = () => reply(503, { error: 'This host does not update from here.' })
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Check for updates' }))
    expect((await screen.findByRole('alert')).textContent).toBe('This host does not update from here.')
  })

  test('a host without the update routes gets no card', async () => {
    host.state = () => reply(404, {})
    const { container } = render(<AppUpdatePanel host={HOST} offline={false} onUnauthorized={() => {}} />)
    await waitFor(() => expect(requests('/api/app-update')).toHaveLength(1))
    expect(container.innerHTML).toBe('')
  })

  test('an offline host is offered no button', async () => {
    host.state = () => reply(200, DOWNLOADED)
    show(true)
    const restart = await screen.findByRole('button', { name: 'Restart to update' })
    expect((restart as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('on the chat list', () => {
  test('the selected host gets its update card beside the list', async () => {
    host.state = () => reply(200, DOWNLOADED)
    window.localStorage.setItem('toucan.hosts', JSON.stringify({ selectedId: HOST.id, hosts: [HOST] }))
    window.history.replaceState(null, '', '/')
    render(<App />)
    const card = await screen.findByLabelText('Toucan update')
    expect(card.textContent).toContain('Toucan 0.25.9 is downloaded')
    window.localStorage.clear()
  })
})

describe('restarting into the update from the phone', () => {
  test('with nothing busy, the button restarts without a further prompt', async () => {
    host.state = () => reply(200, DOWNLOADED)
    show()
    expect(await screen.findByText('Toucan 0.25.9 is downloaded (running 0.25.8).')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }))
    expect(await screen.findByText(/Restarting Work PC into Toucan 0\.25\.9/)).toBeTruthy()
    expect(requests('/api/app-update/restart').map((init) => init.body)).toEqual(['{}'])
  })

  test('busy sessions are named on the phone and only a confirmation restarts', async () => {
    host.state = () => reply(200, DOWNLOADED)
    host.restart = (body) =>
      body.includes('confirmed')
        ? reply(202, { restarting: true })
        : reply(409, { restarting: false, confirm: WARNING })
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Restart to update' }))

    expect(await screen.findByRole('heading', { name: 'Restart to update?' })).toBeTruthy()
    expect(screen.getByText(/• Dev server/)).toBeTruthy()
    expect(screen.getByText('1 background task still running in 1 session.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Restart anyway' }))
    expect(await screen.findByText(/Restarting Work PC into Toucan 0\.25\.9/)).toBeTruthy()
    expect(requests('/api/app-update/restart').map((init) => init.body)).toEqual(['{}', '{"confirmed":true}'])
  })

  test('cancelling the warning leaves the update waiting and restarts nothing', async () => {
    host.state = () => reply(200, DOWNLOADED)
    host.restart = () => reply(409, { restarting: false, confirm: WARNING })
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Restart to update' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('button', { name: 'Restart to update' })).toBeTruthy()
    expect(requests('/api/app-update/restart')).toHaveLength(1)
  })

  test('the host going away during the restart is waited out, then the new version is reported', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    host.state = () => reply(200, DOWNLOADED)
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Restart to update' }))
    expect(await screen.findByText(/Restarting Work PC/)).toBeTruthy()

    host.state = () => {
      throw new TypeError('Failed to fetch')
    }
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(screen.getByText(/Restarting Work PC/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()

    host.state = () => reply(200, UPDATED)
    await act(() => vi.advanceTimersByTimeAsync(3_000))
    expect(await screen.findByText('Updated to Toucan 0.25.9.')).toBeTruthy()
    expect(screen.getByText('Toucan 0.25.9')).toBeTruthy()
  })

  test('a restart request that never got an answer reads as the restart, not as an error', async () => {
    host.state = () => reply(200, DOWNLOADED)
    host.restart = () => {
      throw new TypeError('Failed to fetch')
    }
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Restart to update' }))
    expect(await screen.findByText(/Restarting Work PC/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('following a restart', () => {
  const restarting = { stage: 'restarting' as const, from: '0.25.8', to: '0.25.9', since: 0, hostGone: false }

  test('a failed poll marks the host gone and keeps waiting', () => {
    expect(followRestart(restarting, { ok: false }, 1_000)).toEqual({
      restart: { ...restarting, hostGone: true },
      notice: null,
      problem: null
    })
  })

  test('a host that came back on its old version restarted without updating', () => {
    const back = followRestart({ ...restarting, hostGone: true }, { ok: true, snapshot: DOWNLOADED }, 1_000)
    expect(back.restart).toEqual({ stage: 'none' })
    expect(back.problem).toMatch(/still on Toucan 0\.25\.8/)
  })

  test('a host that never left keeps the restart pending until the stall bound, then says so', () => {
    expect(followRestart(restarting, { ok: true, snapshot: DOWNLOADED }, 1_000).restart).toBe(restarting)
    const stalled = followRestart(restarting, { ok: true, snapshot: DOWNLOADED }, RESTART_STALL_MS + 1)
    expect(stalled.restart).toEqual({ stage: 'none' })
    expect(stalled.problem).toMatch(/has not restarted/)
  })
})
