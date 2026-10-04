import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationSettingsDialog } from '../src/renderer/src/OrchestrationSettingsDialog'
import type { OrchestrationConfigFile } from '../src/shared/orchestration-routing'
import type {
  OrchestrationSettingsApi,
  OrchestrationSettingsSaveRequest,
  OrchestrationSettingsState
} from '../src/shared/orchestration-settings'

// The orchestration settings panel (#39/#45): provider and scope tabs over the files routing reads.
// The files stay the source of truth, so the panel follows edits made elsewhere.

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
    catalogues: {
      claude: {
        models: [
          { id: 'haiku', name: 'Haiku 4.5' },
          { id: 'sonnet', name: 'Sonnet 5.5' },
          { id: 'opus', name: 'Opus 5.5' }
        ],
        efforts: { opus: ['low', 'medium', 'high', 'max'] }
      },
      codex: {
        models: [
          { id: 'gpt-mini', name: 'GPT Mini' },
          { id: 'gpt-frontier', name: 'GPT Frontier' }
        ],
        efforts: { 'gpt-frontier': ['medium', 'high', 'xhigh'] }
      }
    }
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
        claude: {
          tiers: {
            high: { model: 'sonnet' },
            frontier: { model: 'opus', effort: 'high' }
          }
        }
      }
    })
  })

  it('shows a mapped model the list no longer offers as missing', async () => {
    mockApi({ user: { claude: { tiers: { medium: { model: 'sonnet-4' } } } } })
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
    const { save } = mockApi({ user: { claude: { tiers: { high: { model: 'sonnet' } } } } })
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
      file: { claude: { tiers: { high: { model: 'opus' } }, implementationSkill: '/tdd' } }
    })
  })

  it('makes the active provider explicit and edits Codex only from the Codex catalogue', async () => {
    const { save } = mockApi({ user: { claude: { implementationSkill: '/claude-implement' } } })
    render(<OrchestrationSettingsDialog project={project} onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('tab', { name: 'Codex' }))
    expect(screen.getByRole('tab', { name: 'Codex' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/Codex routing is not usable yet.*low, medium, high, frontier/i)).toBeVisible()

    fireEvent.click(tier('low').getByRole('button', { name: 'Choose a model' }))
    expect(await screen.findByRole('option', { name: 'GPT Mini' })).toBeVisible()
    expect(screen.queryByRole('option', { name: /Sonnet/ })).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: 'GPT Mini' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0]![0]).toEqual({
      scope: 'user',
      file: {
        claude: { implementationSkill: '/claude-implement' },
        codex: { tiers: { low: { model: 'gpt-mini' } } }
      }
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
    edit('user', { claude: { tiers: { low: { model: 'opus' } }, implementationSkill: '/tdd' } })
    await waitFor(() => expect(tier('low').getByRole('button', { name: /Opus 5\.5/ })).toBeVisible())
    expect(screen.getByRole('textbox', { name: 'Implementation skill' })).toHaveValue('/tdd')
  })

  it('keeps an unsaved edit when the file changes underneath, and says so', async () => {
    const { edit } = mockApi({})
    render(<OrchestrationSettingsDialog onClose={() => {}} />)
    const skill = await screen.findByRole('textbox', { name: 'Implementation skill' })
    fireEvent.change(skill, { target: { value: '/mine' } })
    edit('user', { claude: { implementationSkill: '/theirs' } })
    expect(await screen.findByText(/changed on disk/i)).toBeVisible()
    expect(skill).toHaveValue('/mine')
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
    await waitFor(() => expect(skill).toHaveValue('/theirs'))
  })

  it('flags an unsaved edit only when its own file changed', async () => {
    const { edit } = mockApi({})
    render(<OrchestrationSettingsDialog project={project} onClose={() => {}} />)
    const skill = await screen.findByRole('textbox', { name: 'Implementation skill' })
    fireEvent.change(skill, { target: { value: '/mine' } })
    edit('project', { claude: { implementationSkill: '/other-file' } })
    await waitFor(() => expect(screen.queryByText(/changed on disk/i)).toBeNull())
    // Saving the other tab and the watcher's echo of it leave this draft alone too.
    fireEvent.click(screen.getByRole('tab', { name: 'Project: Toucan' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Implementation skill' }), { target: { value: '/tdd' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled())
    edit('project', { claude: { implementationSkill: '/tdd' } })
    fireEvent.click(screen.getByRole('tab', { name: 'User' }))
    expect(screen.getByRole('textbox', { name: 'Implementation skill' })).toHaveValue('/mine')
    expect(screen.queryByText(/changed on disk/i)).toBeNull()
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
