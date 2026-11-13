import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from '../mobile/src/App'

// The real history browser and router; chat transport has its own socket integration coverage.
vi.mock('../mobile/src/ChatScreen', () => ({
  default: ({ chatId, onBack }: { chatId: string; onBack(): void }) => (
    <main>
      <h1>Conversation {chatId}</h1>
      <button onClick={onBack}>Back to History</button>
    </main>
  )
}))

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  window.localStorage.clear()
  window.localStorage.setItem(
    'toucan.hosts',
    JSON.stringify({ selectedId: 'pc', hosts: [{ id: 'pc', name: 'PC', origin: 'http://pc:7391', token: 'paired' }] })
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/api/pairing')) return new Response(null, { status: 204 })
      if (url.endsWith('/api/workspace'))
        return Response.json({ updatedAt: 1, projects: [{ id: 'p1', name: 'Project', color: '#71a9ff' }], chats: [] })
      if (url.endsWith('/api/history/open')) return Response.json({ chatId: 'restored-node' })
      if (url.includes('/api/history?'))
        return Response.json({
          entries: [
            {
              key: 'key',
              provider: 'claude',
              title: 'Past conversation',
              directoryLabel: 'Project',
              updatedAt: '',
              messageCount: 2
            }
          ],
          total: 1,
          hasMore: false,
          nextOffset: 25
        })
      return new Response(null, { status: 404 })
    })
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

test('the paired home reaches History, opens its verified chat and Back returns to History', async () => {
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'History' }))
  expect(window.location.pathname).toBe('/history')
  fireEvent.click(await screen.findByRole('button', { name: /Past conversation/ }))
  expect(await screen.findByRole('heading', { name: 'Conversation restored-node' })).toBeVisible()
  expect(window.location.pathname).toBe('/chats/restored-node')
  fireEvent.click(screen.getByRole('button', { name: 'Back to History' }))
  expect(await screen.findByRole('heading', { name: 'History' })).toBeVisible()
  expect(await screen.findByText('Past conversation')).toBeVisible()
})

test('a reloaded History URL opens without a desktop visit and has a route back to chats', async () => {
  window.history.replaceState(null, '', '/history')
  render(<App />)
  expect(await screen.findByText('Past conversation')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Back to chats' }))
  await waitFor(() => expect(window.location.pathname).toBe('/'))
  expect(await screen.findByRole('button', { name: 'New chat' })).toBeVisible()
})
