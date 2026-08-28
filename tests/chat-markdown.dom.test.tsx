import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import MarkdownMessage from '../src/renderer/src/MarkdownMessage'

/*
 * Covers issue #85: agent replies render as GitHub-flavoured markdown with highlighted, copyable
 * code blocks. The interesting guarantees are (a) GFM constructs survive rendering, (b) the copy
 * button puts exactly the fence's contents on the clipboard, and (c) links leave the app window
 * through the shell bridge rather than navigating the renderer.
 */

function stubTerminalApi(): { copyText: ReturnType<typeof vi.fn>; openExternal: ReturnType<typeof vi.fn> } {
  const stub = { copyText: vi.fn(), openExternal: vi.fn(async () => undefined) }
  Object.defineProperty(window, 'terminalApi', { value: stub, configurable: true, writable: true })
  return stub
}

afterEach(() => {
  Reflect.deleteProperty(window, 'terminalApi')
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
    const api = stubTerminalApi()
    render(<MarkdownMessage text={'```ts\nconst a = 1\nconst b = 2\n```'} />)

    fireEvent.click(screen.getByRole('button', { name: /copy ts block/i }))

    expect(api.copyText).toHaveBeenCalledWith('const a = 1\nconst b = 2')
    expect(screen.getByText('Copied')).toBeInTheDocument()
  })

  test('an unlabelled fence still renders and copies as plain text', () => {
    const api = stubTerminalApi()
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
    const api = stubTerminalApi()
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
