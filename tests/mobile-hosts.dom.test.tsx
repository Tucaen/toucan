import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import App from '../mobile/src/App'
import { HOST_PROBE_INTERVAL_MS, HOST_RETRY_CEILING_MS } from '../mobile/src/host-status'
import { storedHostDirectory } from '../mobile/src/remote-client'
import type { RemoteWorkspaceSnapshot } from '../src/shared/remote-access'

/**
 * One phone, two hosts, rendered. The list operations are pure and covered in
 * `tests/mobile-hosts.test.ts`; what only a DOM test can state is what the reader actually gets out
 * of them: that each host's chats arrive under that host's own token, that killing one host leaves
 * the app working against the other rather than showing a broken screen, that a revoked token sends
 * exactly one host back to pairing, and that all of it survives a restart of the app.
 *
 * The hosts are `fetch` stubs keyed by origin, which is the whole point - a request that went to the
 * wrong host is a test failure here rather than a subtle bug on a phone.
 */

const WORK = 'http://work-pc:1789'
const HOME = 'http://home-pc:1789'

function snapshot(chatTitle: string): RemoteWorkspaceSnapshot {
  return {
    updatedAt: 1_000,
    projects: [{ id: 'toucan', name: 'Toucan', color: '#71a9ff' }],
    chats: [
      {
        id: `${chatTitle}-node`,
        kind: 'claude',
        title: chatTitle,
        projectId: 'toucan',
        status: 'idle',
        unread: 0
      }
    ]
  }
}

type HostState = { token: string; title: string; up: boolean }

const hosts = new Map<string, HostState>()
/** Every request, so "which host was asked, with which token" is assertable. */
let asked: { origin: string; path: string; token: string | null }[] = []

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const parsed = new URL(url)
      const origin = `${parsed.protocol}//${parsed.host}`
      const headers = new Headers((init?.headers ?? {}) as HeadersInit)
      const token = headers.get('authorization')?.replace('Bearer ', '') ?? null
      asked.push({ origin, path: parsed.pathname, token })

      const host = hosts.get(origin)
      if (!host || !host.up) return Promise.reject(new Error('ECONNREFUSED'))
      if (token !== host.token) return Promise.resolve(new Response(null, { status: 401 }))
      if (parsed.pathname === '/api/pairing') return Promise.resolve(new Response(null, { status: 204 }))
      if (parsed.pathname === '/api/workspace') {
        return Promise.resolve(new Response(JSON.stringify(snapshot(host.title)), { status: 200 }))
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    })
  )
}

function saveHosts(selectedId: string): void {
  window.localStorage.setItem(
    'toucan.hosts',
    JSON.stringify({
      hosts: [
        { id: 'h-work', name: 'Work PC', origin: WORK, token: 'work-token' },
        { id: 'h-home', name: 'Home PC', origin: HOME, token: 'home-token' }
      ],
      selectedId
    })
  )
}

beforeEach(() => {
  hosts.clear()
  hosts.set(WORK, { token: 'work-token', title: 'Fix the parser', up: true })
  hosts.set(HOME, { token: 'home-token', title: 'Rename the module', up: true })
  asked = []
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** What the selected host's list is showing, once it has arrived. */
async function chatTitle(title: string): Promise<void> {
  await waitFor(() => expect(screen.getByText(title)).toBeTruthy())
}

/** Advances fake timers and lets the fetches they started settle, inside one act. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('two hosts saved on one phone', () => {
  test('each host is driven with its own token, and switching shows its own chats', async () => {
    saveHosts('h-work')
    render(<App />)

    await chatTitle('Fix the parser')
    // The work host's chats arrived under the work host's token, and nothing was asked of the other.
    expect(asked.filter((call) => call.origin === WORK).every((call) => call.token === 'work-token')).toBe(true)
    expect(asked.some((call) => call.origin === HOME && call.token === 'home-token')).toBe(true)
    expect(asked.some((call) => call.origin === HOME && call.token === 'work-token')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /Work PC/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Home PC/ }))

    await chatTitle('Rename the module')
    // The chats the previous host reported are gone rather than left on screen under a new name.
    expect(screen.queryByText('Fix the parser')).toBeNull()
    expect(asked.some((call) => call.origin === HOME && call.path === '/api/workspace')).toBe(true)
  })

  test('killing one host leaves the app working against the other, and it reconnects on its own', async () => {
    // Fake timers because this is about the *schedule*: a host that is up is a heartbeat rather
    // than a poll, so noticing it die takes an interval, and noticing it return takes a backoff.
    // Nothing here retries by hand, which is the property under test.
    vi.useFakeTimers()
    try {
      saveHosts('h-home')
      render(<App />)
      await tick(50)
      expect(screen.getByText('Rename the module')).toBeTruthy()

      // The work PC is switched off while the reader is on the home PC.
      hosts.get(WORK)!.up = false
      fireEvent.click(screen.getByRole('button', { name: /Home PC/ }))
      const workRow = screen.getByRole('button', { name: /Work PC/ })
      expect(workRow.textContent).toMatch(/Online/)

      await tick(HOST_PROBE_INTERVAL_MS + 50)
      expect(workRow.textContent).toMatch(/Offline/)
      // Non-blocking: the other host is still there, still online, still selectable.
      expect(screen.getByRole('button', { name: /Home PC/ }).textContent).toMatch(/Online/)

      hosts.get(WORK)!.up = true
      await tick(HOST_RETRY_CEILING_MS + 50)
      expect(workRow.textContent).toMatch(/Online/)
    } finally {
      vi.useRealTimers()
    }
  })

  test('the selected host going down states the outage and keeps the last list readable', async () => {
    saveHosts('h-work')
    render(<App />)
    await chatTitle('Fix the parser')

    hosts.get(WORK)!.up = false
    await waitFor(() => expect(screen.getByText(/is not answering/)).toBeTruthy(), { timeout: 4_000 })
    // Still the chat list, not an error screen: the switcher is reachable and the last known chats
    // are still on it.
    expect(screen.getByText('Fix the parser')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Work PC/ })).toBeTruthy()
  })

  test('a revoked token flips only its own host into re-pairing', async () => {
    saveHosts('h-work')
    render(<App />)
    await chatTitle('Fix the parser')

    // The desktop regenerated its token; the phone's saved one stops being accepted.
    hosts.get(WORK)!.token = 'regenerated'
    await waitFor(() => expect(screen.getByText(/no longer accepts its pairing token/)).toBeTruthy(), {
      timeout: 4_000
    })

    // Only this host: the other one keeps its token on disk and is one tap away.
    const stored = storedHostDirectory()
    expect(stored.hosts.find((host) => host.id === 'h-work')?.token).toBe('')
    expect(stored.hosts.find((host) => host.id === 'h-home')?.token).toBe('home-token')

    fireEvent.click(screen.getByRole('button', { name: 'Other hosts' }))
    fireEvent.click(await screen.findByRole('button', { name: /Home PC/ }))
    await chatTitle('Rename the module')
  })

  test('re-pairing the revoked host restores it without touching the other', async () => {
    saveHosts('h-work')
    render(<App />)
    await chatTitle('Fix the parser')
    hosts.get(WORK)!.token = 'regenerated'
    const field = await waitFor(() => screen.getByLabelText(`Pairing token for ${WORK}`), { timeout: 4_000 })

    fireEvent.change(field, { target: { value: 'regenerated' } })
    fireEvent.click(screen.getByRole('button', { name: 'Re-pair' }))

    await chatTitle('Fix the parser')
    const stored = storedHostDirectory()
    // Same origin, so the entry was re-paired rather than duplicated - and its id survived, which
    // is what keeps this host's retained drafts addressable.
    expect(stored.hosts.length).toBe(2)
    expect(stored.hosts.find((host) => host.id === 'h-work')?.token).toBe('regenerated')
  })
})

describe('the saved host list itself', () => {
  test('survives a restart of the app', async () => {
    saveHosts('h-home')
    const first = render(<App />)
    await chatTitle('Rename the module')
    first.unmount()

    render(<App />)
    // The selection is remembered too, so a reload does not silently switch which PC is driven.
    await chatTitle('Rename the module')
    expect(screen.getByRole('button', { name: /Home PC/ })).toBeTruthy()
  })

  test('a renamed host keeps its identity, and a forgotten one is gone', async () => {
    saveHosts('h-work')
    render(<App />)
    await chatTitle('Fix the parser')

    fireEvent.click(screen.getByRole('button', { name: /Work PC/ }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Rename' })[0])
    fireEvent.change(screen.getByLabelText(`Name for ${WORK}`), { target: { value: 'Office' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(storedHostDirectory().hosts[0].name).toBe('Office'))
    expect(storedHostDirectory().hosts[0].id).toBe('h-work')

    // Forgetting is confirmed in place, because one stray tap would cost a pairing token.
    fireEvent.click(screen.getAllByRole('button', { name: 'Forget' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(storedHostDirectory().hosts.length).toBe(1))
    expect(storedHostDirectory().selectedId).toBe('h-home')
  })

  test('a device paired before there was a host list keeps that pairing', async () => {
    // The single-host slice stored a bare token and let the serving origin be implicit.
    hosts.set(window.location.origin, { token: 'legacy-token', title: 'Older pairing', up: true })
    window.localStorage.setItem('toucan.pairing-token', 'legacy-token')

    render(<App />)
    await chatTitle('Older pairing')
    const stored = storedHostDirectory()
    expect(stored.hosts).toEqual([
      { id: expect.any(String), name: 'localhost', origin: window.location.origin, token: 'legacy-token' }
    ])
    // Migrated once and then owned by the host list; the old key is not left to be read again.
    expect(window.localStorage.getItem('toucan.pairing-token')).toBeNull()
  })

  test('nothing paired at all is the pairing screen, prefilled with the host that served the page', () => {
    render(<App />)
    expect(screen.getByRole('button', { name: 'Pair' })).toBeTruthy()
    expect((screen.getByLabelText('Host address') as HTMLInputElement).value).toBe(window.location.origin)
  })

  test('an address typed the way the field invites is normalized before the host is asked', async () => {
    render(<App />)
    // The placeholder is `work-pc:1789`, and a bare authority is not a URL `fetch` resolves the way
    // the reader means - it is a scheme. Asking the host with the raw field would report the form's
    // own suggestion as an unreachable PC.
    fireEvent.change(screen.getByLabelText('Host address'), { target: { value: '  work-pc:1789  ' } })
    fireEvent.change(screen.getByLabelText('Pairing token'), { target: { value: 'work-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }))

    await chatTitle('Fix the parser')
    expect(asked.every((call) => call.origin === WORK)).toBe(true)
    expect(storedHostDirectory().hosts[0].origin).toBe(WORK)
  })

  test('a pasted deep link names the host it points at, not the path it carried', async () => {
    render(<App />)
    fireEvent.change(screen.getByLabelText('Host address'), {
      target: { value: `${WORK}/chats/some-node` }
    })
    fireEvent.change(screen.getByLabelText('Pairing token'), { target: { value: 'work-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }))

    await chatTitle('Fix the parser')
    // The API must not end up under the pasted path: `…/chats/some-node/api/pairing` would 404.
    expect(asked.every((call) => call.path.startsWith('/api/'))).toBe(true)
    expect(storedHostDirectory().hosts[0].origin).toBe(WORK)
  })

  test('a background host that stopped accepting its token leaves the directory rather than lingering', async () => {
    vi.useFakeTimers()
    try {
      saveHosts('h-home')
      render(<App />)
      await tick(50)
      expect(screen.getByText('Rename the module')).toBeTruthy()

      // Nobody is looking at the work PC when its token is regenerated. The dead token still has to
      // leave the list, or switching to that host would open a chat list that could only fail.
      hosts.get(WORK)!.token = 'regenerated'
      await tick(HOST_PROBE_INTERVAL_MS + 50)
      expect(storedHostDirectory().hosts.find((host) => host.id === 'h-work')?.token).toBe('')
      expect(storedHostDirectory().hosts.find((host) => host.id === 'h-home')?.token).toBe('home-token')
    } finally {
      vi.useRealTimers()
    }
  })
})
