import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import BrainDumpLibraryPanel from '../src/renderer/src/BrainDumpLibraryPanel'
import { BRAIN_DUMP_PANEL_DEFAULT_WIDTH } from '../src/renderer/src/brain-dump-panel-layout'
import type { WorkspaceProject } from '../src/shared/workspace'
import { createMockBrainDumpApi, topicFixture, type MockBrainDumpApi } from './dom/brain-dump-api-mock'

/**
 * Correcting a topic's project after the fact: the chip in the reader is the control, the menu
 * offers only registered projects plus Unassigned, and an archived snapshot offers nothing at all.
 */

const projects: WorkspaceProject[] = [
  { id: 'toucan', name: 'Toucan', path: 'D:\\Development\\Toucan', color: '#71a9ff' },
  { id: 'hek', name: 'HEK', path: 'D:\\Development\\Hek', color: '#ffb86b' }
]

function renderPanel(api: MockBrainDumpApi): void {
  render(
    <BrainDumpLibraryPanel
      workspaceWidth={1920}
      projects={projects}
      activeProjectPath={projects[0].path}
      panel={{ open: true, width: BRAIN_DUMP_PANEL_DEFAULT_WIDTH }}
      api={api}
      today="2026-08-31"
      onPanelChange={vi.fn()}
      onOpenSessionOnCanvas={vi.fn()}
    />
  )
}

async function openTopic(api: MockBrainDumpApi, title: string): Promise<void> {
  renderPanel(api)
  fireEvent.click(await screen.findByText(title))
}

describe('assigning a project to an existing topic', () => {
  let api: MockBrainDumpApi

  beforeEach(() => {
    api = createMockBrainDumpApi()
    api.collections.active.topics = [topicFixture({ slug: 'voice-input', title: 'Voice input' })]
  })

  test('an unassigned topic is filed through the chip and the row follows', async () => {
    await openTopic(api, 'Voice input')
    const trigger = screen.getByRole('button', { name: /Unassigned/ })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(trigger)
    const menu = screen.getByRole('listbox', { name: 'File this topic under a project' })
    expect(
      within(menu)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['Unassigned', expect.stringContaining('Toucan'), expect.stringContaining('HEK')])
    // Unassigned is where the topic already is, so it is the option marked as current.
    expect(within(menu).getByRole('option', { name: 'Unassigned' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(within(menu).getByRole('option', { name: /HEK/ }))
    await waitFor(() => expect(api.assignProject).toHaveBeenCalledWith('voice-input', 'D:\\Development\\Hek'))
    expect(screen.queryByRole('listbox', { name: 'File this topic under a project' })).toBeNull()
    await screen.findByRole('button', { name: /HEK/ })
    expect(screen.getByRole('status').textContent).toContain('Voice input is now filed under HEK.')
  })

  test('an already-assigned topic can be corrected, and picking the same project writes nothing', async () => {
    api.collections.active.topics = [
      topicFixture({ slug: 'voice-input', title: 'Voice input', projectPath: 'D:\\Development\\Toucan' })
    ]
    await openTopic(api, 'Voice input')

    fireEvent.click(screen.getByRole('button', { name: /Toucan/ }))
    const menu = screen.getByRole('listbox', { name: 'File this topic under a project' })
    expect(within(menu).getByRole('option', { name: /Toucan/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(within(menu).getByRole('option', { name: /Toucan/ }))
    expect(api.assignProject).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Toucan/ }))
    fireEvent.click(
      within(screen.getByRole('listbox', { name: 'File this topic under a project' })).getByRole('option', {
        name: 'Unassigned'
      })
    )
    await waitFor(() => expect(api.assignProject).toHaveBeenCalledWith('voice-input', undefined))
    await screen.findByRole('button', { name: /Unassigned/ })
  })

  test('a failed assignment is reported in place and the chip keeps the project it had', async () => {
    api.assignProject = vi.fn(async () => ({ ok: false as const, code: 'write-failed', message: 'Disk is read-only.' }))
    await openTopic(api, 'Voice input')

    fireEvent.click(screen.getByRole('button', { name: /Unassigned/ }))
    fireEvent.click(
      within(screen.getByRole('listbox', { name: 'File this topic under a project' })).getByRole('option', {
        name: /Toucan/
      })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('Disk is read-only.')
    expect(screen.getByRole('button', { name: /Unassigned/ })).toBeTruthy()

    // Reopening the menu is a fresh attempt, so the stale failure does not follow it.
    fireEvent.click(screen.getByRole('button', { name: /Unassigned/ }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('the chip in a list row selects that topic and opens its picker', async () => {
    api.collections.active.topics = [
      topicFixture({ slug: 'voice-input', title: 'Voice input' }),
      topicFixture({ slug: 'canvas', title: 'Canvas' })
    ]
    renderPanel(api)
    await screen.findByText('Canvas')

    const canvasRow = screen.getByRole('option', { name: /Canvas/ })
    fireEvent.click(within(canvasRow).getByText('Unassigned'))

    expect(canvasRow).toHaveAttribute('aria-selected', 'true')
    const menu = await screen.findByRole('listbox', { name: 'File this topic under a project' })
    fireEvent.click(within(menu).getByRole('option', { name: /Toucan/ }))
    await waitFor(() => expect(api.assignProject).toHaveBeenCalledWith('canvas', 'D:\\Development\\Toucan'))
  })

  test('an archived topic reports its project without offering to change it', async () => {
    api.collections.archived.topics = [
      topicFixture({
        slug: 'shipped',
        title: 'Shipped',
        collection: 'archived',
        outcome: 'implemented',
        archived: '2026-08-30',
        projectPath: 'D:\\Development\\Toucan'
      })
    ]
    renderPanel(api)
    fireEvent.click(screen.getByRole('tab', { name: /Archived/ }))
    fireEvent.click(await screen.findByText('Shipped'))

    expect(screen.queryByRole('button', { name: /Toucan/ })).toBeNull()
    expect(screen.getAllByText('Toucan').length).toBeGreaterThan(0)
  })
})
