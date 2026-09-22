import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { LocalFileOpenResult } from '../src/shared/local-file-link'
import MarkdownMessage from '../src/renderer/src/MarkdownMessage'
import { OpenFileContext } from '../src/renderer/src/open-file-context'

/*
 * Covers issue #85: agent replies render as GitHub-flavoured markdown with highlighted, copyable
 * code blocks. The interesting guarantees are (a) GFM constructs survive rendering, (b) the copy
 * button puts exactly the fence's contents on the clipboard, and (c) links leave the app window
 * through the shell bridge rather than navigating the renderer.
 *
 * Also covers issue #175: a link to a local artifact must reach the dispatched open action for
 * every path form an agent writes, and must say so when it cannot.
 */

interface ShellApiStub {
  copyText: ReturnType<typeof vi.fn>
  openExternal: ReturnType<typeof vi.fn>
  showItemInFolder: ReturnType<typeof vi.fn>
  openLocalFile: ReturnType<typeof vi.fn>
}

function stubShellApi(open: LocalFileOpenResult = { ok: true }): ShellApiStub {
  const stub: ShellApiStub = {
    copyText: vi.fn(),
    openExternal: vi.fn(async () => undefined),
    showItemInFolder: vi.fn(async () => undefined),
    openLocalFile: vi.fn(async () => open)
  }
  Object.defineProperty(window, 'shellApi', { value: stub, configurable: true, writable: true })
  return stub
}

afterEach(() => {
  Reflect.deleteProperty(window, 'shellApi')
})

describe('markdown transcript rendering', () => {
  test('renders a table, a task list and a highlighted TypeScript fence together', () => {
    const { container } = render(
      <MarkdownMessage
        text={[
          '| Cmd | Does |',
          '| --- | ---- |',
          '| dev | runs |',
          '',
          '- [x] shipped',
          '- [ ] pending',
          '',
          '```ts',
          'const answer: number = 42',
          '```',
          '',
          '~~gone~~ and `inline`'
        ].join('\n')}
      />
    )

    const table = container.querySelector('table')
    expect(table).not.toBeNull()
    expect(within(table as HTMLElement).getByText('Cmd')).toBeInTheDocument()
    expect(within(table as HTMLElement).getByText('runs')).toBeInTheDocument()
    // The table owns its horizontal overflow so a wide table cannot stretch the node.
    expect(table?.closest('.markdown-table-scroll')).not.toBeNull()

    const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    expect(checkboxes).toHaveLength(2)
    expect(checkboxes[0].checked).toBe(true)
    expect(checkboxes[1].checked).toBe(false)

    expect(container.querySelector('del')?.textContent).toBe('gone')
    expect(container.querySelector('.markdown-body :not(pre) > code')?.textContent).toBe('inline')

    const block = container.querySelector('.code-block')
    expect(block).not.toBeNull()
    expect(within(block as HTMLElement).getByText('ts')).toBeInTheDocument()
    // Highlighting emits token spans; unhighlighted text would leave the <code> childless.
    expect(block?.querySelectorAll('code.hljs span.hljs-keyword').length).toBeGreaterThan(0)
    expect(block?.querySelector('pre')?.textContent).toBe('const answer: number = 42')
  })

  test('copying a code block copies its contents without the fence or language label', () => {
    const api = stubShellApi()
    render(<MarkdownMessage text={'```ts\nconst a = 1\nconst b = 2\n```'} />)

    fireEvent.click(screen.getByRole('button', { name: /copy ts block/i }))

    expect(api.copyText).toHaveBeenCalledWith('const a = 1\nconst b = 2')
    expect(screen.getByText('Copied')).toBeInTheDocument()
  })

  test('an unlabelled fence still renders and copies as plain text', () => {
    const api = stubShellApi()
    const { container } = render(<MarkdownMessage text={'```\nplain body\n```'} />)

    expect(within(container.querySelector('.code-block') as HTMLElement).getByText('text')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /copy code block/i }))
    expect(api.copyText).toHaveBeenCalledWith('plain body')
  })

  test('a fence in an unbundled language degrades to plain, still-copyable text', () => {
    const { container } = render(<MarkdownMessage text={'```brainfuck\n+[->+]\n```'} />)

    expect(container.querySelector('code.hljs')?.textContent).toBe('+[->+]')
    expect(container.querySelectorAll('code.hljs span').length).toBe(0)
  })

  test('autolinks open externally instead of navigating the app window', () => {
    const api = stubShellApi()
    render(<MarkdownMessage text="see https://example.com/docs for more" />)

    const link = screen.getByRole('link', { name: 'https://example.com/docs' })
    fireEvent.click(link)

    expect(api.openExternal).toHaveBeenCalledWith('https://example.com/docs')
  })

  test('finished code blocks are not re-highlighted as later chunks stream in', () => {
    const first = '```ts\nconst a = 1\n```'
    const { container, rerender } = render(<MarkdownMessage text={`${first}\n\nintro`} />)
    const stableBlock = container.querySelector('.code-block pre')

    rerender(<MarkdownMessage text={`${first}\n\nintro text arriving`} />)

    // Same DOM node: React.memo skipped the block, so streaming does not re-tokenize it.
    expect(container.querySelector('.code-block pre')).toBe(stableBlock)
  })
})

describe('local artifact links', () => {
  /*
   * A destination with literal spaces has to be angle-bracketed - CommonMark ends a bare
   * destination at the first space - which is exactly why the reported link was written that way.
   * The unbracketed forms are therefore exercised on a path without them.
   */
  const forms: [string, string, string][] = [
    [
      'an angle-bracketed path with spaces',
      '</D:/Projects/My Game/docs/art/studies.png>',
      'D:\\Projects\\My Game\\docs\\art\\studies.png'
    ],
    [
      'an angle-bracketed drive path with no leading slash',
      '<D:/Projects/My Game/docs/art/studies.png>',
      'D:\\Projects\\My Game\\docs\\art\\studies.png'
    ],
    [
      'a percent-encoded path',
      '/D:/Projects/My%20Game/docs/art/studies.png',
      'D:\\Projects\\My Game\\docs\\art\\studies.png'
    ],
    [
      'a file URL',
      'file:///D:/Projects/My%20Game/docs/art/studies.png',
      'D:\\Projects\\My Game\\docs\\art\\studies.png'
    ],
    ['a drive path with forward slashes', 'D:/Projects/game/docs/studies.png', 'D:\\Projects\\game\\docs\\studies.png'],
    ['a drive path with backslashes', 'D:\\Projects\\game\\docs\\studies.png', 'D:\\Projects\\game\\docs\\studies.png'],
    ['a leading-slash drive path', '/D:/Projects/game/docs/studies.png', 'D:\\Projects\\game\\docs\\studies.png']
  ]

  for (const [shape, destination, expected] of forms) {
    test(`${shape} opens the artifact it names`, () => {
      const api = stubShellApi()
      render(<MarkdownMessage text={`[open the comparison image here](${destination})`} />)

      fireEvent.click(screen.getByRole('link', { name: 'open the comparison image here' }))

      expect(api.openLocalFile).toHaveBeenCalledWith(expected)
      expect(api.openExternal).not.toHaveBeenCalled()
    })
  }

  test('a target that cannot be opened reports why beside the link', async () => {
    stubShellApi({ ok: false, reason: 'not-found', message: 'This file is not on disk any more.' })
    render(<MarkdownMessage text="[the image](</D:/Projects/My Game/gone.png>)" />)

    fireEvent.click(screen.getByRole('link', { name: 'the image' }))

    expect(await screen.findByRole('note')).toHaveTextContent('This file is not on disk any more.')
  })

  test('a file Toucan can render itself opens as a node on the canvas, never through the OS', () => {
    const api = stubShellApi()
    const openFileNode = vi.fn()
    render(
      <OpenFileContext.Provider value={openFileNode}>
        <MarkdownMessage text="[the plan](</D:/Projects/My Game/docs/plan.md>)" />
      </OpenFileContext.Provider>
    )

    fireEvent.click(screen.getByRole('link', { name: 'the plan' }))

    expect(openFileNode).toHaveBeenCalledWith('D:\\Projects\\My Game\\docs\\plan.md')
    expect(api.openLocalFile).not.toHaveBeenCalled()
  })

  test('a script the OS would execute is never handed to it, canvas or not', () => {
    const api = stubShellApi()
    render(<MarkdownMessage text="[the installer](</D:/Projects/My Game/setup.bat>)" />)

    fireEvent.click(screen.getByRole('link', { name: 'the installer' }))

    expect(api.openLocalFile).not.toHaveBeenCalled()
    // With no canvas behind the surface, revealing it is as far as this goes.
    expect(api.showItemInFolder).toHaveBeenCalledWith('D:\\Projects\\My Game\\setup.bat')
  })

  test('a link that resolves to nothing openable is inert text rather than a dead link', async () => {
    const api = stubShellApi()
    render(<MarkdownMessage text={'[relative](docs/plan.md) [anchor](#top) [script](javascript:alert(1))'} />)

    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('relative')).toHaveClass('markdown-inert-link')
    fireEvent.click(screen.getByText('anchor'))
    await waitFor(() => {
      expect(api.openExternal).not.toHaveBeenCalled()
      expect(api.openLocalFile).not.toHaveBeenCalled()
    })
  })

  test('a local link carries no href, so a middle-click cannot navigate the window to it', () => {
    stubShellApi()
    render(<MarkdownMessage text="[the image](</D:/Projects/My Game/studies.png>) and [docs](https://example.com)" />)

    const local = screen.getByRole('link', { name: 'the image' })
    expect(local).not.toHaveAttribute('href')
    // It is still a link to the keyboard and to a screen reader.
    expect(local).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute('href', 'https://example.com')
  })

  test('a web link is still a web link once local paths are recognized', () => {
    const api = stubShellApi()
    render(<MarkdownMessage text="[docs](https://example.com/docs)" />)

    fireEvent.click(screen.getByRole('link', { name: 'docs' }))

    expect(api.openExternal).toHaveBeenCalledWith('https://example.com/docs')
    expect(api.openLocalFile).not.toHaveBeenCalled()
  })
})

describe('hand-typed message rendering', () => {
  test('keeps the newlines a person typed as line breaks', () => {
    const { container } = render(<MarkdownMessage authored text={'first line\nsecond line\n\nnew paragraph'} />)

    const paragraphs = container.querySelectorAll('.markdown-body > p')
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0].querySelectorAll('br')).toHaveLength(1)
    expect(paragraphs[0].textContent).toBe('first line\nsecond line')
    expect(paragraphs[1].querySelectorAll('br')).toHaveLength(0)
  })

  test('leaves agent replies reflowed, and never breaks up a fence', () => {
    const { container } = render(<MarkdownMessage text={'first line\nsecond line'} />)
    expect(container.querySelectorAll('br')).toHaveLength(0)

    const authored = render(<MarkdownMessage authored text={'```\na\nb\n```'} />)
    expect(authored.container.querySelectorAll('br')).toHaveLength(0)
    expect(authored.container.querySelector('.code-block pre')?.textContent).toBe('a\nb')
  })
})
