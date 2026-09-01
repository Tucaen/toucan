import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import BrainDumpLibraryPanel from '../src/renderer/src/BrainDumpLibraryPanel'
import { BRAIN_DUMP_PANEL_DEFAULT_WIDTH } from '../src/renderer/src/brain-dump-panel-layout'
import type { WorkspaceProject } from '../src/shared/terminal'
import { createMockBrainDumpApi, topicFixture, type MockBrainDumpApi } from './dom/brain-dump-api-mock'

/**
 * Reading a topic: Markdown through the shared transcript pipeline, the four link behaviors a
 * topic can contain, and the one-way Archive flow with its pending, success, and failure states.
 */

const projects: WorkspaceProject[] = [{ id: 'ade', name: 'ADE', path: 'D:\\Development\\ADE', color: '#71a9ff' }]

function renderPanel(api: MockBrainDumpApi, onPanelChange = vi.fn()): void {
  render(
    <BrainDumpLibraryPanel
      workspaceWidth={1920}
      projects={projects}
      activeProjectPath={projects[0].path}
      panel={{ open: true, width: BRAIN_DUMP_PANEL_DEFAULT_WIDTH }}
      api={api}
      today="2026-08-31"
      onPanelChange={onPanelChange}
      onOpenSessionOnCanvas={vi.fn()}
    />
  )
}

describe('links inside a topic', () => {
  let api: MockBrainDumpApi
  let openExternal: ReturnType<typeof vi.fn>
  let showItemInFolder: ReturnType<typeof vi.fn>

  beforeEach(() => {
    openExternal = vi.fn()
    showItemInFolder = vi.fn()
    Object.defineProperty(window, 'terminalApi', {
      configurable: true,
      value: { openExternal, showItemInFolder }
    })
    api = createMockBrainDumpApi()
    api.collections.active.topics = [
      topicFixture({
        slug: 'hub',
        title: 'Hub',
        markdown: [
          '# Hub',
          '',
          'Related: [[voice-input]] and [[never-written]].',
          '',
          'Docs at [the site](https://example.com/docs) and the file [notes](file:///D:/notes.md).',
          '',
          'A [relative one](./elsewhere.md) goes nowhere.',
          '',
          '```ts',
          'const highlighted = true',
          '```'
        ].join('\n')
      }),
      topicFixture({ slug: 'voice-input', title: 'Voice input' })
    ]
  })

  test('topic markdown renders through the shared GFM and code-block pipeline', async () => {
    renderPanel(api)
    fireEvent.click(await screen.findByText('Hub'))
    expect(screen.getByRole('heading', { name: 'Hub', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Copy ts block/ })).toBeInTheDocument()
  })

  test('a resolved reference selects that topic, and a missing one refuses to navigate', async () => {
    renderPanel(api)
    fireEvent.click(await screen.findByText('Hub'))

    await waitFor(() => expect(screen.getByText('Missing topic')).toBeInTheDocument())
    const missing = screen.getByRole('note')
    expect(missing).toHaveTextContent('never-written')
    expect(within(missing).queryByRole('link')).toBeNull()

    fireEvent.click(screen.getByRole('link', { name: 'voice-input' }))
    await screen.findByRole('heading', { name: 'Voice input' })
  })

  test('a reference in the other collection switches collections to show it', async () => {
    api.collections.active.topics = [topicFixture({ slug: 'hub', title: 'Hub', markdown: 'See [[old-idea]].' })]
    api.collections.archived.topics = [
      topicFixture({ slug: 'old-idea', title: 'Old idea', collection: 'archived', outcome: 'obsolete' })
    ]
    renderPanel(api)
    fireEvent.click(await screen.findByText('Hub'))

    fireEvent.click(await screen.findByRole('link', { name: 'old-idea' }))
    await screen.findByRole('heading', { name: 'Old idea' })
    expect(screen.getByRole('tab', { name: /Archived/ })).toHaveAttribute('aria-selected', 'true')
  })

  test('web links open in the browser and local files only ever reveal in Explorer', async () => {
    renderPanel(api)
    fireEvent.click(await screen.findByText('Hub'))

    fireEvent.click(screen.getByRole('link', { name: 'the site' }))
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs')

    fireEvent.click(screen.getByRole('link', { name: 'notes' }))
    expect(showItemInFolder).toHaveBeenCalledWith('D:\\notes.md')
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  test('a link ADE cannot act on safely is not a link at all', async () => {
    renderPanel(api)
    fireEvent.click(await screen.findByText('Hub'))
    expect(screen.queryByRole('link', { name: 'relative one' })).toBeNull()
    expect(screen.getByText('relative one')).toBeInTheDocument()
  })
})

describe('archive lifecycle', () => {
  test('archiving requires an outcome, moves the topic, and announces the result', async () => {
    const api = createMockBrainDumpApi()
    api.collections.active.topics = [topicFixture({ slug: 'a', title: 'A' }), topicFixture({ slug: 'b', title: 'B' })]
    renderPanel(api)

    fireEvent.click(await screen.findByText('A'))
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/stay readable and searchable/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByLabelText('Resolved'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.archive).toHaveBeenCalledWith('a', 'resolved')
    expect(screen.queryByText('A')).not.toBeInTheDocument()
    // Selection lands on the neighbouring row rather than nowhere.
    expect(screen.getByRole('heading', { name: 'B' })).toBeInTheDocument()
    expect(screen.getByRole('status', { name: '' }).textContent).toMatch(/archived as resolved/)
  })

  test('a failed archive keeps the topic and the dialog, and offers a real retry', async () => {
    const api = createMockBrainDumpApi()
    api.collections.active.topics = [topicFixture({ slug: 'a', title: 'A' })]
    const archive = api.archive as ReturnType<typeof vi.fn>
    archive.mockResolvedValueOnce({ ok: false, code: 'write-failed', message: 'The topic could not be moved.' })
    renderPanel(api)

    fireEvent.click(await screen.findByText('A'))
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Archive' }))

    await screen.findByText('The topic could not be moved.')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /A/ })).toBeInTheDocument()

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  test('Escape closes the dialog first and returns focus to Archive', async () => {
    const api = createMockBrainDumpApi()
    api.collections.active.topics = [topicFixture({ slug: 'a', title: 'A' })]
    const onPanelChange = vi.fn()
    renderPanel(api, onPanelChange)

    fireEvent.click(await screen.findByText('A'))
    const archiveButton = screen.getByRole('button', { name: 'Archive' })
    archiveButton.focus()
    fireEvent.click(archiveButton)
    expect(screen.getByLabelText('Implemented')).toHaveFocus()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Archive' })).toHaveFocus()
    expect(onPanelChange).not.toHaveBeenCalledWith({ open: false })
  })

  test('an archived topic is a read-only snapshot', async () => {
    const api = createMockBrainDumpApi()
    api.collections.archived.topics = [
      topicFixture({ slug: 'a', title: 'A', collection: 'archived', outcome: 'obsolete' })
    ]
    renderPanel(api)

    fireEvent.click(screen.getByRole('tab', { name: /Archived/ }))
    fireEvent.click(await screen.findByText('A'))
    expect(screen.getByRole('heading', { name: 'A' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /archive|reopen/i })).not.toBeInTheDocument()
  })
})
