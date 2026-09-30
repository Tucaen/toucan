import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationSettingsDialog } from '../src/renderer/src/OrchestrationSettingsDialog'
import type { OrchestrationConfigFile } from '../src/shared/orchestration-routing'
import type {
  OrchestrationSettingsApi,
  OrchestrationSettingsSaveRequest,
  OrchestrationSettingsState
} from '../src/shared/orchestration-settings'

// The orchestration settings panel (#39): a user tab and a project-override tab over the files #36
// routes with. The files stay the source of truth, so the panel follows edits made elsewhere.

const USER_PATH = 'C:\\userData\\orchestration-config.json'
const PROJECT_PATH = 'C:\\userData\\orchestration-config\\toucan--0123abcd.json'
const project = { name: 'Toucan', path: 'D:\\Development\\toucan' }

function mockApi(files: { user?: OrchestrationConfigFile | string; project?: OrchestrationConfigFile | string }) {
  const listeners = new Set<() => void>()
  const fileState = (path: string, file: OrchestrationConfigFile | string | undefined) =>
    file === undefined
      ? { path, exists: false }
      : typeof file === 'string'
        ? { path, exists: true, error: file }
        : { path, exists: true, file }
  const state = (projectPath?: string): OrchestrationSettingsState => ({
    user: fileState(USER_PATH, files.user),
    ...(projectPath ? { project: fileState(PROJECT_PATH, files.project) } : {}),
    models: [
      { id: 'haiku', name: 'Haiku 4.5' },
      { id: 'sonnet', name: 'Sonnet 5.5' },
      { id: 'opus', name: 'Opus 5.5' }
    ],
    efforts: { opus: ['low', 'medium', 'high', 'max'] }
  })
  const save = vi.fn(async (request: OrchestrationSettingsSaveRequest) => {
    files[request.scope] = request.file
    return state(request.projectPath)
  })
  const api: OrchestrationSettingsApi = {
    state: async (projectPath) => state(projectPath),
    save,
    onChange: (callback) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    }
  }
  window.orchestrationSettingsApi = api
  /** Another process edits a file on disk. */
  const edit = (scope: 'user' | 'project', file: OrchestrationConfigFile | string) => {
    files[scope] = file
    act(() => listeners.forEach((listener) => listener()))
  }
  return { save, edit }
}

const tier = (name: string) => within(screen.getByRole('group', { name: `${name} tier` }))

async function choose(scope: ReturnType<typeof tier>, trigger: RegExp, option: RegExp): Promise<void> {
  fireEvent.click(scope.getByRole('button', { name: trigger }))
  fireEvent.click(await screen.findByRole('option', { name: option }))
}

afterEach(() => Reflect.deleteProperty(window, 'orchestrationSettingsApi'))

describe('orchestration settings', () => {
  it('edits the user file: a model and effort per tier from the chat node list', async () => {
    const { save } = mockApi({})
    render(<OrchestrationSettingsDialog project={project} onClose={() => {}} />)
    expect(await screen.findByRole('dialog', { name: 'Orchestration settings' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'User' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(USER_PATH)).toBeVisible()

    await choose(tier('high'), /Opus 5\.5/, /Sonnet 5\.5/)
    await choose(tier('frontier'), /max/, /^high/)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0]![0]).toEqual({
      scope: 'user',
      file: {
        tiers: {
          low: { model: 'haiku' },
          medium: { model: 'sonnet' },
          high: { model: 'sonnet' },
          frontier: { model: 'opus', effort: 'high' }
        },
        implementationSkill: '/implement'
      }
    })
  })

  it('shows a mapped model the list no longer offers as missing', async () => {
    mockApi({ user: { tiers: { medium: { model: 'sonnet-4' } } } })
    render(<OrchestrationSettingsDialog onClose={() => {}} />)
    await screen.findByRole('dialog')
    expect(tier('medium').getByRole('button', { name: /sonnet-4.*missing/i })).toBeVisible()
    expect(tier('medium').getByText(/no longer offers/i)).toBeVisible()
    expect(tier('low').queryByText(/no longer offers/i)).toBeNull()
  })

  it('shows the ticket contract beside the implementation skill', async () => {
    mockApi({})
    render(<OrchestrationSettingsDialog onClose={() => {}} />)
    const skill = await screen.findByRole('textbox', { name: 'Implementation skill' })
    expect(skill).toHaveValue('/implement')
    expect(skill).toHaveAccessibleDescription(/implement, test, review and commit.*push.*merge.*leave the worktree/i)
  })

  it('edits the project override: tiers inherit from the user file until overridden', async () => {
    const { save } = mockApi({ user: { tiers: { high: { model: 'sonnet' } } } })
    render(<OrchestrationSettingsDialog project={project} onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Project: Toucan' }))
    expect(screen.getByText(PROJECT_PATH)).toBeVisible()
    expect(tier('high').getByRole('button', { name: /Inherited.*Sonnet 5\.5/ })).toBeVisible()

    await choose(tier('high'), /Inherited/, /Opus 5\.5/)
    fireEvent.change(screen.getByRole('textbox', { name: 'Implementation skill' }), { target: { value: '/tdd' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0]![0]).toEqual({
      scope: 'project',
      projectPath: project.path,
      file: { tiers: { high: { model: 'opus' } }, implementationSkill: '/tdd' }
    })
  })

  it('has no project tab to edit without an active project', async () => {
    mockApi({})
    render(<OrchestrationSettingsDialog onClose={() => {}} />)
    expect(await screen.findByRole('tab', { name: /Project/ })).toBeDisabled()
  })

  it('follows edits another process makes to the files', async () => {
    const { edit } = mockApi({})
    render(<OrchestrationSettingsDialog project={project} onClose={() => {}} />)
    await screen.findByRole('dialog')
    edit('user', { tiers: { low: { model: 'opus' } }, implementationSkill: '/tdd' })
    await waitFor(() => expect(tier('low').getByRole('button', { name: /Opus 5\.5/ })).toBeVisible())
    expect(screen.getByRole('textbox', { name: 'Implementation skill' })).toHaveValue('/tdd')
  })

  it('keeps an unsaved edit when the file changes underneath, and says so', async () => {
    const { edit } = mockApi({})
    render(<OrchestrationSettingsDialog onClose={() => {}} />)
    const skill = await screen.findByRole('textbox', { name: 'Implementation skill' })
    fireEvent.change(skill, { target: { value: '/mine' } })
    edit('user', { implementationSkill: '/theirs' })
    expect(await screen.findByText(/changed on disk/i)).toBeVisible()
    expect(skill).toHaveValue('/mine')
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
    await waitFor(() => expect(skill).toHaveValue('/theirs'))
  })

  it('will not overwrite a file that does not parse', async () => {
    mockApi({ user: `the orchestration configuration ${USER_PATH} is not valid JSON` })
    render(<OrchestrationSettingsDialog onClose={() => {}} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/not valid JSON/)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('closes on Escape through the modal policy', async () => {
    mockApi({})
    const onClose = vi.fn()
    render(<OrchestrationSettingsDialog onClose={onClose} />)
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
