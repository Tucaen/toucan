import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { projectSettingsTitle } from '../src/renderer/src/WorkspaceDialogs'
import type { ProjectAvatarSetResult } from '../src/shared/project-avatar'
import type { WorkspaceState } from '../src/shared/workspace'
import { renderApp as renderAppHarness, savedWorkspace as harnessWorkspace } from './dom/app-harness'

/**
 * Custom project avatars, end to end through the renderer: a stored avatar renders as an image
 * inside the fixed sidebar chip, choosing one through the settings dialog bumps `avatarVersion`
 * into the persisted snapshot, removing one falls back to the letter, and a refused pick is shown
 * where it happened.
 */

vi.mock('@xterm/xterm', async () => (await import('./dom/xterm-mock')).xtermModule())
vi.mock('@xterm/addon-fit', async () => (await import('./dom/xterm-mock')).fitAddonModule())

const AVATAR_URL = 'data:image/png;base64,QVZBVEFS'

const alpha = { id: 'alpha', name: 'Alpha', path: 'D:\\Alpha', color: '#71a9ff', avatarVersion: 1 }
const beta = { id: 'beta', name: 'Beta', path: 'D:\\Beta', color: '#e69a71' }

const savedWorkspace = (): WorkspaceState => harnessWorkspace({ projects: [alpha, beta], activeProjectId: alpha.id })

let saved: WorkspaceState[]

function avatarApiMock(chooseResult: ProjectAvatarSetResult = { status: 'set', version: 2 }): {
  choose: ReturnType<typeof vi.fn>
  read: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
} {
  return {
    choose: vi.fn(async () => chooseResult),
    read: vi.fn(async () => AVATAR_URL),
    remove: vi.fn(async () => undefined)
  }
}

async function renderApp(api = avatarApiMock()): Promise<typeof api> {
  saved = (await renderAppHarness({ state: savedWorkspace(), apis: { projectAvatarApi: api } })).saved
  return api
}

function alphaChipImage(): HTMLImageElement | null {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('.project-row'))
  const row = rows.find((candidate) => candidate.textContent?.includes('Alpha'))
  return row?.querySelector<HTMLImageElement>('.project-avatar-image') ?? null
}

async function openAlphaSettings(): Promise<void> {
  fireEvent.click(await screen.findByTitle(projectSettingsTitle(alpha)))
  await screen.findByText(`Settings for ${alpha.name}`)
}

describe('custom project avatars', () => {
  test('a project with a stored avatar renders it inside the sidebar chip', async () => {
    const api = await renderApp()
    await waitFor(() => expect(alphaChipImage()?.src).toBe(AVATAR_URL))
    expect(api.read).toHaveBeenCalledWith(alpha.id)
    // Beta has no avatarVersion, so nothing was read for it and its letter stays.
    expect(api.read).toHaveBeenCalledTimes(1)
  })

  test('choosing an image applies immediately and persists the bumped version', async () => {
    const api = await renderApp()
    await openAlphaSettings()
    fireEvent.click(screen.getByText('Choose image…'))
    await waitFor(() => expect(api.choose).toHaveBeenCalledWith(alpha.id))
    // The bumped version re-reads the stored file and reaches the persisted snapshot.
    await waitFor(() => expect(api.read).toHaveBeenCalledTimes(2))
    await waitFor(() => {
      const snapshot = saved.at(-1)
      const project = snapshot?.projects.find((candidate) => candidate.id === alpha.id)
      expect(project?.avatarVersion).toBe(2)
    })
  })

  test('removing the image returns the letter chip and clears the persisted version', async () => {
    const api = await renderApp()
    await waitFor(() => expect(alphaChipImage()).not.toBeNull())
    await openAlphaSettings()
    fireEvent.click(screen.getByText('Remove image'))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith(alpha.id))
    await waitFor(() => expect(alphaChipImage()).toBeNull())
    await waitFor(() => {
      const project = saved.at(-1)?.projects.find((candidate) => candidate.id === alpha.id)
      expect(project?.avatarVersion).toBeUndefined()
    })
  })

  test('a refused pick reports its message inside the dialog', async () => {
    await renderApp(avatarApiMock({ status: 'refused', message: 'That file could not be read as an image.' }))
    await openAlphaSettings()
    fireEvent.click(screen.getByText('Choose image…'))
    await screen.findByText('That file could not be read as an image.')
  })
})
