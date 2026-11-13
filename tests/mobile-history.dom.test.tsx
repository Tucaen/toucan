import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import HistoryScreen from '../mobile/src/HistoryScreen'
import type { SavedHost } from '../mobile/src/hosts'
import type { RemoteHistoryEntry } from '../src/shared/remote-history'
import { routeFromPathname } from '../mobile/src/routes'

const host: SavedHost = { id: 'pc', name: 'Work PC', origin: 'http://work-pc:7391', token: 'paired' }
const entry: RemoteHistoryEntry = {
  key: 'opaque-key',
  provider: 'codex',
  title: 'Fix parser',
  updatedAt: '2026-11-12T10:00:00Z',
  messageCount: 12,
  directoryLabel: 'feature/parser'
}
const workspace = {
  updatedAt: 1000,
  projects: [
    { id: 'p1', name: 'Project', color: '#71a9ff' },
    { id: 'p2', name: 'Other', color: '#71a9ff' }
  ],
  chats: []
}
const page = { entries: [entry], total: 26, hasMore: true, nextOffset: 25 }
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
let opened: ReturnType<typeof vi.fn>
let unauthorized: ReturnType<typeof vi.fn>

beforeEach(() => {
  opened = vi.fn()
  unauthorized = vi.fn()
})

function mount(fetcher: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetcher)
  return render(<HistoryScreen host={host} onBack={vi.fn()} onOpened={opened} onUnauthorized={unauthorized} />)
}

test('lists useful context, filters the current page and browses older pages/projects with paired requests', async () => {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.headers).toMatchObject({ authorization: 'Bearer paired' })
    if (url.endsWith('/api/workspace')) return reply(workspace)
    if (url.includes('projectId=p2')) return reply({ ...page, entries: [], total: 0, hasMore: false })
    if (url.endsWith('offset=25'))
      return reply({
        ...page,
        entries: [{ ...entry, key: 'older', provider: 'claude', title: 'Older conversation' }],
        hasMore: false,
        nextOffset: 50
      })
    return reply(page)
  })
  mount(fetcher)
  expect(await screen.findByText('Fix parser')).toBeVisible()
  expect(screen.getByText('feature/parser')).toBeVisible()
  expect(screen.getByText(/12 messages/)).toBeVisible()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'absent' } })
  expect(screen.getByText(/No matches on this page/)).toBeVisible()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Older' }))
  expect(await screen.findByText('Older conversation')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Older' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Newer' }))
  expect(await screen.findByText('Fix parser')).toBeVisible()
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p2' } })
  expect(await screen.findByText(/No past conversations were found/)).toBeVisible()
  expect(fetcher.mock.calls.every(([url]) => url.startsWith(host.origin))).toBe(true)
})

test('opening waits for a verified node, disables repeated taps and sends only the issued handle', async () => {
  let finish!: (response: Response) => void
  const fetcher = vi.fn((url: string) =>
    url.endsWith('/api/history/open')
      ? new Promise<Response>((resolve) => {
          finish = resolve
        })
      : Promise.resolve(reply(url.endsWith('/api/workspace') ? workspace : page))
  )
  mount(fetcher)
  const row = await screen.findByRole('button', { name: /Fix parser/ })
  fireEvent.click(row)
  fireEvent.click(row)
  expect(row).toBeDisabled()
  expect(screen.getByRole('status')).toHaveTextContent('Opening conversation')
  const posts = fetcher.mock.calls.filter(([url]) => url.endsWith('/api/history/open'))
  expect(posts).toHaveLength(1)
  expect(JSON.parse((posts[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({
    projectId: 'p1',
    key: 'opaque-key'
  })
  expect(opened).not.toHaveBeenCalled()
  act(() => finish(reply({ chatId: 'restored-node' })))
  await waitFor(() => expect(opened).toHaveBeenCalledWith('restored-node'))
})

test('an unavailable original checkout refuses without navigating; the same entry can be retried after a drop', async () => {
  let failed = true
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/api/history/open')) {
      if (failed) return reply({ error: 'The original worktree is unavailable.' }, 409)
      return reply({ chatId: 'same-node' })
    }
    return reply(url.endsWith('/api/workspace') ? workspace : page)
  })
  mount(fetcher)
  fireEvent.click(await screen.findByRole('button', { name: /Fix parser/ }))
  expect(await screen.findByRole('alert')).toHaveTextContent('original worktree is unavailable')
  expect(opened).not.toHaveBeenCalled()
  failed = false
  fireEvent.click(screen.getByRole('button', { name: /Fix parser/ }))
  await waitFor(() => expect(opened).toHaveBeenCalledWith('same-node'))
})

test('unsupported History, offline loading, retry and reconnect are explicit', async () => {
  let status = 404
  const fetcher = vi.fn(async (url: string) =>
    url.endsWith('/api/workspace')
      ? reply(workspace)
      : status === 200
        ? reply(page)
        : reply({ error: 'unavailable' }, status)
  )
  mount(fetcher)
  expect(await screen.findByRole('alert')).toHaveTextContent('History or this project is unavailable')
  status = 503
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('unavailable')
  status = 200
  fireEvent(window, new Event('online'))
  expect(await screen.findByText('Fix parser')).toBeVisible()
})

test.each(['workspace', 'list', 'open'])(
  'a revoked pairing during %s returns the selected host to pairing',
  async (at) => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/api/workspace')) return reply(workspace, at === 'workspace' ? 401 : 200)
      if (url.endsWith('/api/history/open')) return reply({}, 401)
      return reply(page, at === 'list' ? 401 : 200)
    })
    mount(fetcher)
    if (at === 'open') fireEvent.click(await screen.findByRole('button', { name: /Fix parser/ }))
    await waitFor(() => expect(unauthorized).toHaveBeenCalledTimes(1))
    expect(opened).not.toHaveBeenCalled()
  }
)

test('leaving during restore discards the late navigation; /history is reloadable', async () => {
  expect(routeFromPathname('/history')).toEqual({ screen: 'history' })
  let finish!: (response: Response) => void
  const h = mount(
    vi.fn((url: string) =>
      url.endsWith('/api/history/open')
        ? new Promise<Response>((resolve) => {
            finish = resolve
          })
        : Promise.resolve(reply(url.endsWith('/api/workspace') ? workspace : page))
    )
  )
  fireEvent.click(await screen.findByRole('button', { name: /Fix parser/ }))
  h.unmount()
  await act(async () => finish(reply({ chatId: 'late-node' })))
  expect(opened).not.toHaveBeenCalled()
})
