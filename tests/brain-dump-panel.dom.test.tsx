import { readFileSync } from 'node:fs'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test } from 'vitest'
import { projectSettingsTitle } from '../src/renderer/src/WorkspaceDialogs'
import {
  BRAIN_DUMP_PANEL_DEFAULT_WIDTH,
  BRAIN_DUMP_PANEL_MAX_WIDTH,
  BRAIN_DUMP_PANEL_MIN_WIDTH
} from '../src/renderer/src/brain-dump-panel-layout'
import type { WorkspaceState } from '../src/shared/terminal'
import { createMockBrainDumpApi, topicFixture, type MockBrainDumpApi } from './dom/brain-dump-api-mock'
import {
  DEFAULT_PROJECT as project,
  renderApp as renderAppHarness,
  savedWorkspace,
  setWindowWidth
} from './dom/app-harness'

const styles = readFileSync('src/renderer/src/styles.css', 'utf8')

/**
 * The panel inside the real workspace: its sidebar entry, its global shortcut, the fact that
 * opening/resizing/closing it only narrows the canvas rather than replacing it, and the persisted
 * width surviving a restart into a smaller window.
 */

let api: MockBrainDumpApi
let saved: WorkspaceState[]

async function renderApp(state: WorkspaceState = savedWorkspace(), windowWidth?: number): Promise<void> {
  saved = (await renderAppHarness({ state, windowWidth, apis: { brainDumpApi: api } })).saved
}

beforeEach(() => {
  api = createMockBrainDumpApi()
  api.collections.active.topics = [topicFixture({ slug: 'voice-input', title: 'Voice input' })]
})

describe('the sidebar entry', () => {
  test('centers the project settings icon within its square button', async () => {
    await renderApp()
    const setup = screen.getByTitle(projectSettingsTitle(project))
    const stylesheet = document.createElement('style')
    stylesheet.textContent = styles
    document.head.append(stylesheet)

    expect(getComputedStyle(setup).padding).toBe('0px')

    stylesheet.remove()
  })

  test('the library is a global control, separate from the project rows', async () => {
    await renderApp()
    const entry = screen.getByRole('button', { name: /Brain dumps/ })
    expect(entry).toHaveAttribute('aria-pressed', 'false')
    expect(entry.closest('.project-section')).toBeNull()

    fireEvent.click(entry)
    await screen.findByRole('heading', { name: 'Brain dumps' })
    expect(screen.getByRole('button', { name: /Brain dumps/ })).toHaveAttribute('aria-pressed', 'true')
  })

  test('a collapsed sidebar keeps the control reachable and labelled', async () => {
    await renderApp()
    fireEvent.click(screen.getByTitle('Collapse projects'))
    const entry = screen.getByTitle('Open brain-dump library')
    expect(entry).toHaveAccessibleName(/brain-dump library/i)
  })

  test('Ctrl+Shift+B toggles the panel from anywhere in the workspace', async () => {
    await renderApp()
    fireEvent.keyDown(window, { key: 'B', ctrlKey: true, shiftKey: true })
    await screen.findByRole('heading', { name: 'Brain dumps' })

    fireEvent.keyDown(window, { key: 'B', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Brain dumps' })).toBeNull())
  })
})

describe('the canvas beside the panel', () => {
  test('opening, resizing, and closing the panel never remounts the canvas', async () => {
    await renderApp()
    const canvas = document.querySelector('.react-flow')
    expect(canvas).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Brain dumps/ }))
    await screen.findByRole('heading', { name: 'Brain dumps' })
    expect(document.querySelector('.react-flow')).toBe(canvas)

    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize the brain-dump panel' }), { key: 'ArrowLeft' })
    expect(document.querySelector('.react-flow')).toBe(canvas)

    fireEvent.click(screen.getByRole('button', { name: 'Close the brain-dump library' }))
    expect(document.querySelector('.react-flow')).toBe(canvas)
  })

  test('the panel takes layout width beside the canvas instead of overlaying it', async () => {
    await renderApp()
    fireEvent.click(screen.getByRole('button', { name: /Brain dumps/ }))
    const panel = (await screen.findByRole('heading', { name: 'Brain dumps' })).closest('aside')
    expect(panel).toHaveStyle({ width: `${BRAIN_DUMP_PANEL_DEFAULT_WIDTH}px` })
    expect(panel?.parentElement).toBe(document.querySelector('.canvas-region')?.parentElement)
  })
})

describe('persisted panel state', () => {
  test('a workspace saved before the library existed opens with the panel closed', async () => {
    await renderApp(savedWorkspace())
    expect(screen.queryByRole('heading', { name: 'Brain dumps' })).toBeNull()
    await waitFor(() => expect(saved.length).toBeGreaterThan(0))
    expect(saved.at(-1)?.brainDumpPanel).toEqual({ open: false, width: BRAIN_DUMP_PANEL_DEFAULT_WIDTH })
  })

  test('a reopened panel restores its width, its state, and its unsent draft', async () => {
    await renderApp(
      savedWorkspace({
        brainDumpPanel: { open: true, width: 820, draft: 'unsent thought', provider: 'claude' }
      })
    )
    const panel = (await screen.findByRole('heading', { name: 'Brain dumps' })).closest('aside')
    expect(panel).toHaveStyle({ width: '820px' })

    fireEvent.click(screen.getByRole('button', { name: 'Write a brain dump' }))
    expect(screen.getByLabelText('Brain dump')).toHaveValue('unsent thought')
    expect(screen.getByLabelText('Provider')).toHaveValue('claude')
  })

  test('a width saved on a wider monitor is clamped into a smaller window', async () => {
    await renderApp(savedWorkspace({ brainDumpPanel: { open: true, width: BRAIN_DUMP_PANEL_MAX_WIDTH } }), 900)
    const panel = (await screen.findByRole('heading', { name: 'Brain dumps' })).closest('aside')
    expect(panel).toHaveStyle({ width: '630px' })
  })

  test('shrinking the window while the panel is open narrows it rather than the canvas', async () => {
    await renderApp(savedWorkspace({ brainDumpPanel: { open: true, width: BRAIN_DUMP_PANEL_MAX_WIDTH } }))
    await screen.findByRole('heading', { name: 'Brain dumps' })

    setWindowWidth(560)
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    const panel = screen.getByRole('heading', { name: 'Brain dumps' }).closest('aside')
    expect(panel).toHaveStyle({ width: `${BRAIN_DUMP_PANEL_MIN_WIDTH}px` })
  })

  test('the width the user drags to is what gets persisted', async () => {
    await renderApp(savedWorkspace({ brainDumpPanel: { open: true, width: BRAIN_DUMP_PANEL_DEFAULT_WIDTH } }))
    await screen.findByRole('heading', { name: 'Brain dumps' })
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize the brain-dump panel' }), { key: 'ArrowLeft' })

    await waitFor(() =>
      expect(saved.at(-1)?.brainDumpPanel).toMatchObject({ open: true, width: BRAIN_DUMP_PANEL_DEFAULT_WIDTH + 24 })
    )
  })
})
