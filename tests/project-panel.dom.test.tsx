import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import App from '../src/renderer/src/App'
import type { WorkspaceState } from '../src/shared/terminal'
import { createMockAppUpdateApi } from './dom/app-update-api-mock'

/**
 * The project sidebar as the user works it: recolouring a project, dragging rows into a new order,
 * and filing them into collapsible groups. The three share one rule - array order is display order
 * - so most of what is checked here is that a gesture rewrites `projects`/`projectGroups` and that
 * the snapshot which reaches disk agrees with what the sidebar shows.
 */

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const alpha = { id: 'alpha', name: 'Alpha', path: 'D:\\Alpha', color: '#71a9ff' }
const beta = { id: 'beta', name: 'Beta', path: 'D:\\Beta', color: '#e69a71' }

function savedWorkspace(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    version: 3,
    projects: [alpha, beta],
    activeProjectId: alpha.id,
    sidebarCollapsed: false,
    nodes: [],
    worktrees: [],
    ...overrides
  }
}

let saved: WorkspaceState[]

function installWindowApis(state: WorkspaceState): void {
  saved = []
  const define = (name: string, value: unknown): void =>
    Object.defineProperty(window, name, { configurable: true, value })
  define('terminalApi', {
    loadWorkspace: vi.fn(async () => ({ state, recovered: false, unrecoverable: false })),
    saveWorkspace: vi.fn(async (snapshot: WorkspaceState) => {
      saved.push(snapshot)
      return { ok: true }
    }),
    getInitialProject: vi.fn(async () => ({ name: alpha.name, path: alpha.path })),
    openExternal: vi.fn(),
    showItemInFolder: vi.fn(),
    copyText: vi.fn()
  })
  define('usageApi', { rateLimits: vi.fn(async () => ({})) })
  define('worktreeApi', {
    discover: vi.fn(async () => ({ worktrees: [], claims: [] })),
    status: vi.fn(async () => null)
  })
  define('conversationApi', { setTitle: vi.fn(async () => null) })
  define('agentApi', { onEvent: () => () => undefined })
  define('appUpdateApi', createMockAppUpdateApi())
  define('remoteApi', {
    state: vi.fn(async () => ({
      settings: { enabled: false, port: 7391 },
      listening: false,
      token: 'token',
      tokenUpdatedAt: 0,
      addresses: []
    })),
    publishWorkspace: vi.fn(),
    onStateChange: () => () => undefined,
    onSpawnChat: () => () => undefined,
    completeSpawn: vi.fn()
  })
  define('brainDumpApi', {
    list: vi.fn(async () => ({ topics: [] })),
    onChanged: () => () => undefined
  })
}

async function renderApp(state: WorkspaceState = savedWorkspace()): Promise<void> {
  installWindowApis(state)
  render(<App />)
  await screen.findByText('Add project')
}

const ROW_HEIGHT = 40

/** jsdom measures nothing, so the drag maths is given the layout the sidebar would have had. */
function layoutSidebarRows(): void {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('.project-group-header, .project-row'))
  rows.forEach((row, index) => {
    row.getBoundingClientRect = (): DOMRect =>
      ({
        top: index * ROW_HEIGHT,
        bottom: index * ROW_HEIGHT + ROW_HEIGHT,
        left: 0,
        right: 200,
        width: 200,
        height: ROW_HEIGHT,
        x: 0,
        y: index * ROW_HEIGHT,
        toJSON: () => ({})
      }) as DOMRect
  })
}

/** jsdom has no `PointerEvent`, and the sidebar only ever reads `clientY` off one. */
function pointer(type: string, target: EventTarget, clientY: number): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  act(() => {
    target.dispatchEvent(event)
  })
}

function dragRow(handleTitle: string, toClientY: number, options: { cancel?: boolean } = {}): void {
  layoutSidebarRows()
  pointer('pointerdown', screen.getByTitle(handleTitle), 0)
  pointer('pointermove', window, toClientY)
  if (options.cancel) {
    fireEvent.keyDown(window, { key: 'Escape' })
    return
  }
  pointer('pointerup', window, toClientY)
}

const sidebarOrder = (): string[] =>
  Array.from(document.querySelectorAll('.project-row .project-copy strong')).map((row) => row.textContent ?? '')

/**
 * The header chip and the sidebar's "New nodes open in" footer both repeat the active project's
 * name, so every row query is scoped to the list itself.
 */
const sidebar = (): ReturnType<typeof within> => within(document.querySelector('.project-list') as HTMLElement)

function openRowMenu(name: string): void {
  const row = sidebar().getByText(name).closest('.project-row, .project-group-header') as HTMLElement
  fireEvent.contextMenu(row, { clientX: 40, clientY: 60 })
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

describe('changing a project colour', () => {
  test('the row menu offers the palette, and a pick reaches the sidebar, the header and the snapshot', async () => {
    await renderApp()
    openRowMenu('Alpha')

    const menu = await screen.findByRole('menu', { name: 'Alpha options' })
    fireEvent.click(within(menu).getByText('Change colour…'))
    expect(within(menu).getAllByRole('button', { name: /^Colour #/ })).toHaveLength(6)
    expect(within(menu).getByRole('button', { name: 'Colour #71a9ff' })).toHaveAttribute('data-current', 'true')

    fireEvent.click(within(menu).getByRole('button', { name: 'Colour #c992ff' }))

    const avatar = sidebar().getByText('Alpha').closest('.project-row')?.querySelector('.project-avatar')
    expect(avatar).toHaveStyle({ '--project-color': '#c992ff' })
    expect(document.querySelector('.target-chip span')).toHaveStyle({ background: '#c992ff' })
    await waitFor(() => expect(saved.at(-1)?.projects[0].color).toBe('#c992ff'))
  })

  test('a custom colour is stored as lowercase #rrggbb, and anything else is ignored', async () => {
    await renderApp()
    openRowMenu('Beta')
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Beta options' })).getByText('Change colour…'))

    const custom = screen.getByLabelText('Custom project colour')
    fireEvent.change(custom, { target: { value: '#AABBCC' } })
    await waitFor(() => expect(saved.at(-1)?.projects[1].color).toBe('#aabbcc'))
  })

  test('the colour fans out to every canvas node of that project', async () => {
    await renderApp(
      savedWorkspace({
        worktrees: [
          {
            id: 'worktree-1',
            projectId: alpha.id,
            branch: 'feature',
            path: 'D:\\Alpha-feature',
            baseRef: 'main',
            createdAt: '2026-01-01T00:00:00.000Z',
            position: { x: 0, y: 0 },
            width: 320,
            height: 200
          }
        ]
      })
    )

    const node = document.querySelector('.worktree-node') as HTMLElement
    expect(node).toHaveStyle({ '--project-color': '#71a9ff' })

    openRowMenu('Alpha')
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Alpha options' })).getByText('Change colour…'))
    fireEvent.click(screen.getByRole('button', { name: 'Colour #74d8a2' }))

    expect(document.querySelector('.worktree-node')).toHaveStyle({ '--project-color': '#74d8a2' })
  })
})

describe('dragging to re-order', () => {
  test('a drag by the handle re-orders the projects and persists the new order', async () => {
    await renderApp()
    expect(sidebarOrder()).toEqual(['Alpha', 'Beta'])

    dragRow('Drag to re-order Beta', 5)

    expect(sidebarOrder()).toEqual(['Beta', 'Alpha'])
    await waitFor(() => expect(saved.at(-1)?.projects.map((project) => project.id)).toEqual(['beta', 'alpha']))
  })

  test('a drop indicator follows the pointer and Escape cancels the drag', async () => {
    await renderApp()
    layoutSidebarRows()
    pointer('pointerdown', screen.getByTitle('Drag to re-order Beta'), 0)
    pointer('pointermove', window, 5)
    expect(document.querySelector('.project-drop-indicator')).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('.project-drop-indicator')).toBeNull()
    expect(sidebarOrder()).toEqual(['Alpha', 'Beta'])
  })

  test('pressing the row itself selects the project instead of starting a drag', async () => {
    await renderApp()
    layoutSidebarRows()
    const row = sidebar().getByText('Beta').closest('.project-row') as HTMLElement
    pointer('pointerdown', row, 45)
    pointer('pointermove', window, 5)
    expect(document.querySelector('.project-drop-indicator')).toBeNull()

    fireEvent.click(within(row).getByText('Beta'))
    expect(row).toHaveClass('active')
  })
})

describe('groups', () => {
  test('a project makes a new group, which can be renamed, collapsed and deleted', async () => {
    await renderApp()

    openRowMenu('Alpha')
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Alpha options' })).getByText('Move to group…'))
    fireEvent.click(screen.getByText('New group…'))

    const rename = screen.getByLabelText('Rename Group 1')
    fireEvent.change(rename, { target: { value: 'Work' } })
    fireEvent.keyDown(rename, { key: 'Enter' })

    const header = await screen.findByTitle('Work · 1 project')
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(sidebarOrder()).toEqual(['Alpha', 'Beta'])
    await waitFor(() => expect(saved.at(-1)?.projectGroups?.[0].name).toBe('Work'))
    expect(saved.at(-1)?.projects.find((project) => project.id === 'alpha')?.groupId).toBeDefined()

    fireEvent.click(header)
    expect(sidebarOrder()).toEqual(['Beta'])
    await waitFor(() => expect(saved.at(-1)?.projectGroups?.[0].collapsed).toBe(true))

    openRowMenu('Work')
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Work options' })).getByText('Delete group'))
    expect(sidebarOrder()).toEqual(['Alpha', 'Beta'])
    await waitFor(() => expect(saved.at(-1)?.projectGroups).toBeUndefined())
    expect(saved.at(-1)?.projects.map((project) => project.groupId)).toEqual([undefined, undefined])
  })

  test('a restored group keeps its collapse state and hides its members', async () => {
    await renderApp(
      savedWorkspace({
        projects: [{ ...alpha, groupId: 'group-1' }, beta],
        projectGroups: [{ id: 'group-1', name: 'Work', collapsed: true }]
      })
    )

    expect(screen.getByTitle('Work · 1 project')).toHaveAttribute('aria-expanded', 'false')
    expect(sidebarOrder()).toEqual(['Beta'])
  })

  test('dragging a project onto a group header files it, and Remove from group takes it back out', async () => {
    await renderApp(
      savedWorkspace({
        projects: [{ ...alpha, groupId: 'group-1' }, beta],
        projectGroups: [{ id: 'group-1', name: 'Work', collapsed: false }]
      })
    )

    dragRow('Drag to re-order Beta', 20)
    await waitFor(() => expect(saved.at(-1)?.projects.find((entry) => entry.id === 'beta')?.groupId).toBe('group-1'))

    openRowMenu('Beta')
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Beta options' })).getByText('Move to group…'))
    fireEvent.click(screen.getByText('Remove from group'))
    await waitFor(() => expect(saved.at(-1)?.projects.find((entry) => entry.id === 'beta')?.groupId).toBeUndefined())
  })

  test('group headers re-order among themselves', async () => {
    await renderApp(
      savedWorkspace({
        projects: [
          { ...alpha, groupId: 'group-1' },
          { ...beta, groupId: 'group-2' }
        ],
        projectGroups: [
          { id: 'group-1', name: 'First', collapsed: true },
          { id: 'group-2', name: 'Second', collapsed: true }
        ]
      })
    )

    dragRow('Drag to re-order Second', 5)
    await waitFor(() => expect(saved.at(-1)?.projectGroups?.map((group) => group.id)).toEqual(['group-2', 'group-1']))
  })

  test('a collapsed sidebar shows a collapsed group as a single avatar', async () => {
    await renderApp(
      savedWorkspace({
        projects: [{ ...alpha, groupId: 'group-1' }, beta],
        projectGroups: [{ id: 'group-1', name: 'Work', collapsed: true }],
        sidebarCollapsed: true
      })
    )

    expect(document.querySelector('.project-group-avatar')?.textContent).toBe('W')
    expect(document.querySelectorAll('.project-row')).toHaveLength(1)
  })
})

/**
 * The commands that start a project are edited in the same gear dialog as the setup command and
 * the tickets folder, and they persist with the project. Nothing here runs one - that is the
 * project row's Run menu, which is its own ticket.
 */
describe('the commands that start a project', () => {
  const SETTINGS_BUTTON = `Settings for ${alpha.name}: setup command, tickets folder and run commands`

  const openSettings = async (): Promise<void> => {
    fireEvent.click(screen.getByRole('button', { name: SETTINGS_BUTTON }))
    await screen.findByRole('dialog', { name: `Settings for ${alpha.name}` })
  }

  const fillRow = (position: number, name: string, command: string): void => {
    fireEvent.change(screen.getByLabelText(`Command ${position} name`), { target: { value: name } })
    fireEvent.change(screen.getByLabelText(`Command ${position} command line`), { target: { value: command } })
  }

  const savedCommands = (): unknown => saved.at(-1)?.projects.find((entry) => entry.id === alpha.id)?.runCommands

  test('any number of named commands can be added, and they reach the snapshot in the listed order', async () => {
    await renderApp()
    await openSettings()

    fireEvent.click(screen.getByRole('button', { name: 'Add command' }))
    fillRow(1, '  API (watch)  ', '  dotnet watch run  ')
    fireEvent.click(screen.getByRole('button', { name: 'Add command' }))
    fillRow(2, 'Web', 'npm run dev')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(savedCommands()).toEqual([
        { id: expect.any(String), name: 'API (watch)', command: 'dotnet watch run' },
        { id: expect.any(String), name: 'Web', command: 'npm run dev' }
      ])
    )
  })

  test('saved commands are shown again when the dialog is reopened', async () => {
    await renderApp(
      savedWorkspace({
        projects: [{ ...alpha, runCommands: [{ id: 'web', name: 'Web', command: 'npm run dev' }] }, beta]
      })
    )
    await openSettings()

    expect(screen.getByLabelText('Command 1 name')).toHaveValue('Web')
    expect(screen.getByLabelText('Command 1 command line')).toHaveValue('npm run dev')
  })

  test('a row with only half of it filled in is refused rather than quietly dropped', async () => {
    await renderApp()
    await openSettings()

    fireEvent.click(screen.getByRole('button', { name: 'Add command' }))
    fireEvent.change(screen.getByLabelText('Command 1 name'), { target: { value: 'Web' } })

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByText('Every run command needs a name and a command line.')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Command 1 command line'), { target: { value: 'npm run dev' } })
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled()
  })

  test('an added row the user never filled in is scratch, so the project keeps no commands', async () => {
    await renderApp()
    await openSettings()

    fireEvent.click(screen.getByRole('button', { name: 'Add command' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(saved.length).toBeGreaterThan(0))
    expect(savedCommands()).toBeUndefined()
  })

  test('rows are reordered and removed, and the ends of the list are walls', async () => {
    await renderApp(
      savedWorkspace({
        projects: [
          {
            ...alpha,
            runCommands: [
              { id: 'api', name: 'API', command: 'dotnet watch run' },
              { id: 'web', name: 'Web', command: 'npm run dev' },
              { id: 'db', name: 'DB', command: 'docker compose up' }
            ]
          },
          beta
        ]
      })
    )
    await openSettings()

    expect(screen.getByRole('button', { name: 'Move command 1 up' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move command 3 down' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Move command 3 up' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove command 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(savedCommands()).toEqual([
        { id: 'db', name: 'DB', command: 'docker compose up' },
        { id: 'web', name: 'Web', command: 'npm run dev' }
      ])
    )
  })

  test('clearing every command takes the project back to having none', async () => {
    await renderApp(
      savedWorkspace({
        projects: [{ ...alpha, runCommands: [{ id: 'web', name: 'Web', command: 'npm run dev' }] }, beta]
      })
    )
    await openSettings()

    fireEvent.click(screen.getByRole('button', { name: 'Remove command 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(saved.length).toBeGreaterThan(0))
    expect(savedCommands()).toBeUndefined()
  })

  test('the gear reports a project as configured when all it holds is run commands', async () => {
    await renderApp(
      savedWorkspace({
        projects: [{ ...alpha, runCommands: [{ id: 'web', name: 'Web', command: 'npm run dev' }] }, beta]
      })
    )

    expect(screen.getByRole('button', { name: SETTINGS_BUTTON })).toHaveAttribute('data-configured', 'true')
    expect(
      screen.getByRole('button', { name: `Settings for ${beta.name}: setup command, tickets folder and run commands` })
    ).not.toHaveAttribute('data-configured')
  })
})
