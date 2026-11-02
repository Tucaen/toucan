import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import ChatMarkdown from '../mobile/src/ChatMarkdown'
import type { HostEndpoint } from '../mobile/src/hosts'

/**
 * Links in phone chat prose: a local image opens full-screen from the host that holds it, a web
 * link leaves the app in a new tab, and everything else is inert text instead of a reload.
 */

const HOST: HostEndpoint = { origin: 'http://work-pc:1789', token: 'token' }

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  URL.createObjectURL = vi.fn(() => 'blob:shot')
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('local image links', () => {
  test('tapping one fetches it with the token and shows it full-screen', async () => {
    fetchMock.mockResolvedValue(new Response(new Blob(['png']), { status: 200 }))
    render(<ChatMarkdown host={HOST} text={'See [the shot](<D:\\proj\\shots\\one.png>).'} />)

    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /the shot/ }))

    const image = await screen.findByRole('img', { name: 'one.png' })
    expect(image.getAttribute('src')).toBe('blob:shot')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://work-pc:1789/api/file?path=D%3A%5Cproj%5Cshots%5Cone.png')
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer token')

    fireEvent.click(screen.getByRole('button', { name: 'Close image' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:shot')
  })

  test('a file URL link, the form agents are told to write, is a tap target with spaces decoded (#3)', async () => {
    fetchMock.mockResolvedValue(new Response(new Blob(['png']), { status: 200 }))
    render(<ChatMarkdown host={HOST} text={'See [before.png](file:///C:/Users/me/My%20Shots/before.png).'} />)

    fireEvent.click(screen.getByRole('button', { name: /before\.png/ }))

    await screen.findByRole('img', { name: 'before.png' })
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'http://work-pc:1789/api/file?path=C%3A%5CUsers%5Cme%5CMy%20Shots%5Cbefore.png'
    )
  })

  test("a markdown image is a tap target too, and the host's refusal is shown", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'This image is not on the desktop any more.' }), { status: 404 })
    )
    render(<ChatMarkdown host={HOST} text={'![Login screen](D:/proj/login.png)'} />)

    fireEvent.click(screen.getByRole('button', { name: /Login screen/ }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('This image is not on the desktop any more.')
    )
  })
})

describe('other links', () => {
  test('a web link opens in a new tab instead of replacing the app', () => {
    render(<ChatMarkdown host={HOST} text={'[docs](https://example.com/x)'} />)
    const link = screen.getByRole('link', { name: 'docs' })
    expect(link.getAttribute('href')).toBe('https://example.com/x')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  test('relative paths, other local files and private schemes are inert text', () => {
    render(
      <ChatMarkdown
        host={HOST}
        text={'[rel](docs/x.png) [md](D:/proj/notes.md) [js](javascript:alert(1)) [unc](\\\\srv\\s\\x.png)'}
      />
    )
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.getByText('md').getAttribute('title')).toBe('Only images can be opened on the phone.')
  })
})
