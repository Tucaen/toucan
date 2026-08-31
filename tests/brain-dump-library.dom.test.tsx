import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import BrainDumpLibraryPanel from '../src/renderer/src/BrainDumpLibraryPanel'
import { BRAIN_DUMP_WINDOW_THRESHOLD } from '../src/renderer/src/BrainDumpTopicList'
import { BRAIN_DUMP_PANEL_DEFAULT_WIDTH, BRAIN_DUMP_PANEL_MIN_WIDTH } from '../src/renderer/src/brain-dump-panel-layout'
import type { BrainDumpPanelState, WorkspaceProject } from '../src/shared/terminal'
import { createMockBrainDumpApi, topicFixture, type MockBrainDumpApi } from './dom/brain-dump-api-mock'

/**
 * The panel's list side: collections, search, project identity, windowing, keyboard navigation, and
 * the wide/narrow master-detail split. The decisions themselves live in brain-dump-topics.ts and
 * brain-dump-panel-layout.ts; this checks the panel is actually wired to them.
 */

const projects: WorkspaceProject[] = [{ id: 'ade', name: 'ADE', path: 'D:\\Development\\ADE', color: '#71a9ff' }]

function renderPanel(
  api: MockBrainDumpApi,
  overrides: { width?: number; panel?: Partial<BrainDumpPanelState> } = {}
): { rerender(width: number): void; onPanelChange: ReturnType<typeof vi.fn> } {
  const onPanelChange = vi.fn()
  const panel = (width: number): BrainDumpPanelState => ({ open: true, width, ...overrides.panel })
  const props = {
    workspaceWidth: 1920,
    projects,
    activeProjectPath: projects[0].path,
    api,
    today: '2026-08-31',
    onPanelChange,
    onOpenSessionOnCanvas: vi.fn()
  }
  const view = render(
    <BrainDumpLibraryPanel {...props} panel={panel(overrides.width ?? BRAIN_DUMP_PANEL_DEFAULT_WIDTH)} />
  )
  return {
    onPanelChange,
    rerender: (width: number) => view.rerender(<BrainDumpLibraryPanel {...props} panel={panel(width)} />)
  }
}

describe('collections and search', () => {
  let api: MockBrainDumpApi

  beforeEach(() => {
    api = createMockBrainDumpApi()
    api.collections.active.topics = [
      topicFixture({ slug: 'voice-input', title: 'Voice input', projectPath: 'd:/development/ade' }),
      topicFixture({ slug: 'panel-width', title: 'Panel width', markdown: 'clamping the docked panel' })
    ]
    api.collections.archived.topics = [
      topicFixture({ slug: 'old-idea', title: 'Old idea', collection: 'archived', outcome: 'obsolete' })
    ]
  })

  test('active topics load first and archived ones only when asked for', async () => {
    renderPanel(api)
    await screen.findByText('Voice input')
    expect(api.listCalls).toEqual(['active'])

    fireEvent.click(screen.getByRole('tab', { name: /Archived/ }))
    await screen.findByText('Old idea')
    expect(api.listCalls).toEqual(['active', 'archived'])
  })

  test('search filters without blocking input and keeps a per-collection query', async () => {
    renderPanel(api)
    await screen.findByText('Voice input')

    fireEvent.change(screen.getByLabelText('Search brain dumps'), { target: { value: 'CLAMPING' } })
    expect(screen.queryByText('Voice input')).not.toBeInTheDocument()
    expect(screen.getByText('Panel width')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /Archived/ }))
    await screen.findByText('Old idea')
    expect(screen.getByLabelText('Search brain dumps')).toHaveValue('')

    fireEvent.click(screen.getByRole('tab', { name: /Active/ }))
    expect(screen.getByLabelText('Search brain dumps')).toHaveValue('CLAMPING')
  })

  test('Ctrl+K reaches the search field while the panel is open', async () => {
    renderPanel(api)
    await screen.findByText('Voice input')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(screen.getByLabelText('Search brain dumps')).toHaveFocus()
  })

  test('each collection remembers its own selection', async () => {
    renderPanel(api)
    fireEvent.click(await screen.findByText('Panel width'))
    expect(screen.getByRole('heading', { name: 'Panel width' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /Archived/ }))
    await screen.findByText('Old idea')
    expect(screen.queryByRole('heading', { name: 'Panel width' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /Active/ }))
    expect(screen.getByRole('heading', { name: 'Panel width' })).toBeInTheDocument()
  })
})

describe('topic rows', () => {
  test('a registered project shows its name, and its absolute path stays reachable', async () => {
    const api = createMockBrainDumpApi()
    api.collections.active.topics = [topicFixture({ slug: 'a', title: 'A', projectPath: 'd:/development/ade' })]
    renderPanel(api)

    const row = await screen.findByRole('option', { name: /A/ })
    expect(within(row).getByText('ADE')).toBeInTheDocument()
    expect(within(row).getByTitle('D:\\Development\\ADE')).toBeInTheDocument()
    expect(row).toHaveAccessibleDescription(/Project path D:\\Development\\ADE/)
  })

  test('an unassigned topic says so in text, and an unregistered project explains itself', async () => {
    const api = createMockBrainDumpApi()
    api.collections.active.topics = [
      topicFixture({ slug: 'a', title: 'A' }),
      topicFixture({ slug: 'b', title: 'B', projectPath: 'D:\\Archive\\OldApp' })
    ]
    renderPanel(api)

    await screen.findByText('Unassigned')
    expect(screen.getByText('OldApp')).toBeInTheDocument()
    expect(screen.getByText('Project not in workspace')).toBeInTheDocument()
  })

  test('an archived row shows its outcome and relative date', async () => {
    const api = createMockBrainDumpApi()
    api.collections.archived.topics = [
      topicFixture({ slug: 'a', title: 'A', collection: 'archived', outcome: 'implemented', updated: '2026-08-30' })
    ]
    renderPanel(api)
    fireEvent.click(screen.getByRole('tab', { name: /Archived/ }))
    await screen.findByText('Implemented')
    expect(screen.getByText('Updated yesterday')).toBeInTheDocument()
  })
})

describe('scale and keyboard', () => {
  test('a thousand topics render as a window, not a thousand rows', async () => {
    const api = createMockBrainDumpApi()
    api.collections.active.topics = Array.from({ length: 1000 }, (_, index) =>
      topicFixture({ slug: `topic-${index}`, title: `Topic ${index}` })
    )
    renderPanel(api)

    await screen.findByText('Topic 0')
    const rendered = screen.getAllByRole('option')
    expect(rendered.length).toBeGreaterThan(0)
    expect(rendered.length).toBeLessThan(BRAIN_DUMP_WINDOW_THRESHOLD * 4)
  })

  test('arrow keys walk the list and Home/End jump to its ends', async () => {
    const api = createMockBrainDumpApi()
    api.collections.active.topics = [
      topicFixture({ slug: 'a', title: 'A' }),
      topicFixture({ slug: 'b', title: 'B' }),
      topicFixture({ slug: 'c', title: 'C' })
    ]
    renderPanel(api)

    const list = await screen.findByRole('listbox')
    const selectedIndex = (): number =>
      screen.getAllByRole('option').findIndex((option) => option.getAttribute('aria-selected') === 'true')

    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(selectedIndex()).toBe(0)
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(selectedIndex()).toBe(1)
    expect(list).toHaveAttribute('aria-activedescendant', 'brain-dump-option-b')
    fireEvent.keyDown(list, { key: 'End' })
    expect(selectedIndex()).toBe(2)
    fireEvent.keyDown(list, { key: 'Home' })
    expect(selectedIndex()).toBe(0)
  })

  test('the resize separator can be driven from the keyboard within its bounds', async () => {
    const panel = renderPanel(createMockBrainDumpApi())
    const separator = screen.getByRole('separator', { name: 'Resize the brain-dump panel' })
    expect(separator).toHaveAttribute('aria-valuemin', String(BRAIN_DUMP_PANEL_MIN_WIDTH))
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(panel.onPanelChange).toHaveBeenCalledWith({ width: BRAIN_DUMP_PANEL_DEFAULT_WIDTH + 24 })
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(panel.onPanelChange).toHaveBeenLastCalledWith({ width: BRAIN_DUMP_PANEL_DEFAULT_WIDTH - 24 })
  })
})

describe('panel modes', () => {
  test('a wide panel shows list and reader together; a narrow one swaps between them', async () => {
    const api = createMockBrainDumpApi()
    api.collections.active.topics = [topicFixture({ slug: 'a', title: 'A' })]
    const view = renderPanel(api)

    fireEvent.click(await screen.findByText('A'))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'A' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Back to list/ })).not.toBeInTheDocument()

    view.rerender(BRAIN_DUMP_PANEL_MIN_WIDTH)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'A' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Back to list/ }))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'A' })).not.toBeInTheDocument()
    // Back returns to the list; it does not throw away what the user had selected.
    expect(screen.getByRole('option', { name: /A/ })).toHaveAttribute('aria-selected', 'true')
  })
})

describe('lifecycle follow-up', () => {
  test('a reopened topic offers a way back to it in Active', async () => {
    const api = createMockBrainDumpApi()
    api.collections.archived.topics = [
      topicFixture({ slug: 'a', title: 'A', collection: 'archived', outcome: 'obsolete' })
    ]
    renderPanel(api)

    fireEvent.click(screen.getByRole('tab', { name: /Archived/ }))
    fireEvent.click(await screen.findByText('A'))
    fireEvent.click(screen.getByRole('button', { name: 'Reopen topic' }))

    fireEvent.click(await screen.findByRole('button', { name: 'View in Active' }))
    await screen.findByRole('heading', { name: 'A' })
    expect(screen.getByRole('tab', { name: /Active/ })).toHaveAttribute('aria-selected', 'true')
  })
})

describe('library states', () => {
  test('an empty active collection explains how to fill it', async () => {
    renderPanel(createMockBrainDumpApi())
    await screen.findByText(/No brain dumps yet/)
  })

  test('a read failure offers a retry that reads the library again', async () => {
    const api = createMockBrainDumpApi()
    const list = api.list as ReturnType<typeof vi.fn>
    list.mockRejectedValueOnce(new Error('The library directory could not be read.'))
    renderPanel(api)

    await screen.findByText('The library directory could not be read.')
    api.collections.active.topics = [topicFixture({ slug: 'a', title: 'A' })]
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByText('A')
  })

  test('malformed topic files are reported without hiding the valid ones', async () => {
    const api = createMockBrainDumpApi()
    api.collections.active.topics = [topicFixture({ slug: 'a', title: 'A' })]
    api.collections.active.diagnostics = [
      { path: 'D:\\dumps\\active\\broken.md', code: 'malformed-topic', message: 'title is required.' }
    ]
    renderPanel(api)

    await screen.findByText('A')
    await waitFor(() => expect(screen.getByText(/could not be read/)).toBeInTheDocument())
    expect(screen.getByText('title is required.', { exact: false })).toBeInTheDocument()
  })
})
