import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import App from '../src/renderer/src/App'
import { TICKET_BOARD_DEFAULT_WIDTH, TICKET_BOARD_MAX_WIDTH } from '../src/renderer/src/ticket-board-layout'
import type { WorkspaceState } from '../src/shared/terminal'
import { createMockBrainDumpApi } from './dom/brain-dump-api-mock'
import {
  cardFixture,
  createMockGithubIssuesApi,
  createMockTicketsApi,
  type MockGithubIssuesApi,
  type MockTicketsApi
} from './dom/tickets-api-mock'

/**
 * The board inside the real workspace: its sidebar entry, its shortcut, the columns it derives
 * from the active project's files, and the rule that separates it from every optimistic board -
 * a card moves when the files say it moved, not when the pointer was released.
 */

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const project = { id: 'toucan', name: 'Toucan', path: 'D:\\Development\\Toucan', color: '#71a9ff' }
const other = { id: 'atlas', name: 'Atlas', path: 'D:\\Development\\Atlas', color: '#8ad1a0' }

function savedWorkspace(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    version: 3,
    projects: [project, other],
    activeProjectId: project.id,
    sidebarCollapsed: false,
    nodes: [],
    worktrees: [],
    ...overrides
  }
}

let tickets: MockTicketsApi
let github: MockGithubIssuesApi
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
    getInitialProject: vi.fn(async () => ({ name: project.name, path: project.path })),
    openExternal: vi.fn(),
    showItemInFolder: vi.fn(),
    copyText: vi.fn()
  })
  define('usageApi', { rateLimits: vi.fn(async () => ({})) })
  define('worktreeApi', { discover: vi.fn(async () => ({ worktrees: [], claims: [] })) })
  define('conversationApi', { setTitle: vi.fn(async () => null) })
  define('agentApi', { onEvent: () => () => undefined })
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
  define('brainDumpApi', createMockBrainDumpApi())
  define('ticketsApi', tickets)
  define('githubIssuesApi', github)
}

function setWindowWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
}

async function renderApp(state: WorkspaceState = savedWorkspace()): Promise<void> {
  installWindowApis(state)
  render(<App />)
  await screen.findByText('Add project')
}

async function openBoard(state?: WorkspaceState): Promise<void> {
  await renderApp(state)
  fireEvent.click(screen.getByRole('button', { name: /^Tickets/ }))
  await screen.findByRole('heading', { name: 'Tickets' })
}

const column = (label: string): HTMLElement => screen.getByRole('region', { name: new RegExp(`^${label},`) })

const COLUMN_WIDTH = 260

/** jsdom measures nothing, so the drag maths is given the layout the board would have had. */
function layoutColumns(): void {
  document.querySelectorAll<HTMLElement>('.ticket-column').forEach((element, index) => {
    element.getBoundingClientRect = (): DOMRect =>
      ({
        top: 0,
        bottom: 600,
        left: index * COLUMN_WIDTH,
        right: index * COLUMN_WIDTH + COLUMN_WIDTH,
        width: COLUMN_WIDTH,
        height: 600,
        x: index * COLUMN_WIDTH,
        y: 0,
        toJSON: () => ({})
      }) as DOMRect
  })
}

/** jsdom has no `PointerEvent`, and the board only ever reads the coordinates off one. */
function pointer(type: string, target: EventTarget, clientX: number): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 100 })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  act(() => {
    target.dispatchEvent(event)
  })
}

function dragCard(cardTitle: string, toColumnIndex: number, options: { cancel?: boolean } = {}): void {
  layoutColumns()
  pointer('pointerdown', screen.getByTitle(`Move ${cardTitle} to another column`), 10)
  pointer('pointermove', window, toColumnIndex * COLUMN_WIDTH + 20)
  if (options.cancel) {
    fireEvent.keyDown(window, { key: 'Escape' })
    return
  }
  pointer('pointerup', window, toColumnIndex * COLUMN_WIDTH + 20)
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  setWindowWidth(1920)
  tickets = createMockTicketsApi()
  github = createMockGithubIssuesApi()
  tickets.projects.set(project.path, {
    cards: [
      cardFixture({ id: 'ticket-board', title: 'Ticket board', status: 'in-progress', updated: '2026-09-03' }),
      cardFixture({ id: 'file-node', title: 'File node', blockedBy: ['shared-frontmatter', 'ghost'] }),
      cardFixture({ id: 'shared-frontmatter', title: 'Shared frontmatter', status: 'done', updated: '2026-09-02' })
    ],
    diagnostics: []
  })
})

describe('reaching the board', () => {
  test('the sidebar entry is a global control that opens the board', async () => {
    await renderApp()
    const entry = screen.getByRole('button', { name: /^Tickets/ })
    expect(entry).toHaveAttribute('aria-pressed', 'false')
    expect(entry.closest('.project-section')).toBeNull()

    fireEvent.click(entry)
    await screen.findByRole('heading', { name: 'Tickets' })
    expect(screen.getByRole('button', { name: /^Tickets/ })).toHaveAttribute('aria-pressed', 'true')
  })

  test('Ctrl+Shift+K toggles the board from anywhere in the workspace', async () => {
    await renderApp()
    fireEvent.keyDown(window, { key: 'K', ctrlKey: true, shiftKey: true })
    await screen.findByRole('heading', { name: 'Tickets' })

    fireEvent.keyDown(window, { key: 'K', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Tickets' })).toBeNull())
  })

  test('the board docks beside the canvas rather than overlaying it', async () => {
    await openBoard()
    const panel = screen.getByRole('heading', { name: 'Tickets' }).closest('aside')
    expect(panel).toHaveStyle({ width: `${TICKET_BOARD_DEFAULT_WIDTH}px` })
    expect(panel?.parentElement).toBe(document.querySelector('.canvas-region')?.parentElement)
  })
})

describe('the columns', () => {
  test('every shipped status has a column and each card lands in its own', async () => {
    await openBoard()
    await screen.findByText('Ticket board')
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      'Open',
      'In progress',
      'Blocked',
      'Done'
    ])
    expect(within(column('Open')).getByText('File node')).toBeInTheDocument()
    expect(within(column('In progress')).getByText('Ticket board')).toBeInTheDocument()
    // Done is collapsed by default, so its card is counted but not listed.
    expect(within(column('Done')).queryByText('Shared frontmatter')).toBeNull()
    expect(within(column('Done')).getByText('1')).toBeInTheDocument()
  })

  test('Done opens on request and offers everything it is withholding', async () => {
    tickets.projects.set(project.path, {
      cards: [
        cardFixture({ id: 'recent', title: 'Recently closed', status: 'done', updated: '2026-09-01' }),
        cardFixture({ id: 'ancient', title: 'Long closed', status: 'done', updated: '2026-01-01' })
      ],
      diagnostics: []
    })
    await openBoard()
    await waitFor(() => expect(within(column('Done')).getByText('2')).toBeInTheDocument())
    expect(screen.queryByText('Recently closed')).toBeNull()

    fireEvent.click(screen.getByTitle('Expand the Done column'))
    expect(screen.getByText('Recently closed')).toBeInTheDocument()
    // Older than the 30-day cutoff: counted, withheld, and reachable through the toggle.
    expect(screen.queryByText('Long closed')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show all (1 older)' }))
    expect(screen.getByText('Long closed')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show recent only' }))
    expect(screen.queryByText('Long closed')).toBeNull()
  })

  test('a blocker chip shows whether the ticket it names is finished or unknown', async () => {
    await openBoard()
    await screen.findByText('File node')
    expect(screen.getByTitle('shared-frontmatter is done')).toBeInTheDocument()
    expect(screen.getByTitle('ghost is not a ticket in this folder')).toBeInTheDocument()
  })

  test('a file that could not be read is listed rather than dropped', async () => {
    tickets.projects.set(project.path, {
      cards: [],
      diagnostics: [
        {
          path: 'D:\\Development\\Toucan\\docs\\tickets\\Broken.md',
          code: 'malformed-ticket',
          message: 'title is required.'
        }
      ]
    })
    await openBoard()
    expect(await screen.findByText('1 ticket file(s) could not be read')).toBeInTheDocument()
    expect(screen.getByText(/title is required/)).toBeInTheDocument()
  })

  test('expanding a card renders its Markdown body in place', async () => {
    tickets.projects.set(project.path, {
      cards: [cardFixture({ id: 'file-node', title: 'File node', body: '\n## Acceptance\n\nRenders Markdown.\n' })],
      diagnostics: []
    })
    await openBoard()
    const title = await screen.findByRole('button', { name: 'File node' })
    expect(title).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(title)
    expect(await screen.findByRole('heading', { name: 'Acceptance' })).toBeInTheDocument()
    expect(screen.getByText('Renders Markdown.')).toBeInTheDocument()

    fireEvent.click(title)
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Acceptance' })).toBeNull())
  })
})

describe('moving a card', () => {
  test('a drag onto a column writes the status and shows the card where the files now put it', async () => {
    await openBoard()
    await screen.findByText('File node')

    dragCard('File node', 1)

    await waitFor(() => expect(within(column('In progress')).getByText('File node')).toBeInTheDocument())
    expect(tickets.setStatus).toHaveBeenCalledWith(project.path, 'file-node', 'in-progress')
    // The re-read is what put it there: the board asked the source again after the write.
    expect(tickets.listCalls.filter((path) => path === project.path).length).toBeGreaterThan(1)
  })

  test('Escape during a drag leaves the card where it was and writes nothing', async () => {
    await openBoard()
    await screen.findByText('File node')

    dragCard('File node', 1, { cancel: true })

    expect(tickets.setStatus).not.toHaveBeenCalled()
    expect(within(column('Open')).getByText('File node')).toBeInTheDocument()
  })

  test('a refused write leaves the board alone and says why', async () => {
    tickets.setStatus = vi.fn(async () => ({ ok: false as const, code: 'write-failed', message: 'EPERM: denied.' }))
    await openBoard()
    await screen.findByText('File node')

    dragCard('File node', 1)

    expect(await screen.findByRole('alert')).toHaveTextContent('EPERM: denied.')
    expect(within(column('Open')).getByText('File node')).toBeInTheDocument()
  })

  test('the grip moves a card between neighbouring columns without a pointer', async () => {
    await openBoard()
    await screen.findByText('File node')

    fireEvent.keyDown(screen.getByTitle('Move File node to another column'), { key: 'ArrowRight' })

    await waitFor(() => expect(tickets.setStatus).toHaveBeenCalledWith(project.path, 'file-node', 'in-progress'))
  })
})

describe('following the project and the disk', () => {
  test('an edit made outside Toucan reaches the board without a restart', async () => {
    await openBoard()
    await screen.findByText('Ticket board')

    tickets.projects.get(project.path)!.cards.push(cardFixture({ id: 'diff-node', title: 'Diff node' }))
    act(() => tickets.publishChange(project.path))

    expect(await within(column('Open')).findByText('Diff node')).toBeInTheDocument()
  })

  test('switching projects re-lists rather than showing the previous project’s tickets', async () => {
    tickets.projects.set(other.path, {
      cards: [cardFixture({ id: 'atlas-only', title: 'Atlas only' })],
      diagnostics: []
    })
    await openBoard()
    await screen.findByText('Ticket board')

    const list = document.querySelector('.project-list')!
    fireEvent.click(within(list as HTMLElement).getByText('Atlas'))

    expect(await screen.findByText('Atlas only')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Ticket board')).toBeNull())
    expect(tickets.listCalls).toContain(other.path)
  })
})

describe('persisted panel state', () => {
  test('a workspace saved before the board existed opens with it closed', async () => {
    await renderApp()
    expect(screen.queryByRole('heading', { name: 'Tickets' })).toBeNull()
    await waitFor(() => expect(saved.length).toBeGreaterThan(0))
    expect(saved.at(-1)?.ticketBoardPanel).toEqual({ open: false, width: TICKET_BOARD_DEFAULT_WIDTH })
  })

  test('a reopened board restores its width, clamped into the current window', async () => {
    setWindowWidth(1000)
    await renderApp(savedWorkspace({ ticketBoardPanel: { open: true, width: TICKET_BOARD_MAX_WIDTH } }))
    const panel = (await screen.findByRole('heading', { name: 'Tickets' })).closest('aside')
    expect(panel).toHaveStyle({ width: '700px' })
  })

  test('resizing with the separator persists the new width', async () => {
    await openBoard()
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize the ticket board' }), { key: 'ArrowLeft' })
    await waitFor(() => expect(saved.at(-1)?.ticketBoardPanel?.width).toBe(TICKET_BOARD_DEFAULT_WIDTH + 24))
  })
})

describe('GitHub as a second source', () => {
  const issue = (overrides: Partial<ReturnType<typeof cardFixture>> = {}): ReturnType<typeof cardFixture> =>
    cardFixture({
      sourceId: 'github',
      id: '147',
      title: 'GitHub issues as a second source',
      url: 'https://github.com/tucaen/toucan/issues/147',
      ...overrides
    })

  test('a project with no GitHub remote is not offered the source at all', async () => {
    await openBoard()
    await waitFor(() => expect(github.availability).toHaveBeenCalledWith(project.path))
    expect(screen.queryByRole('button', { name: 'GitHub' })).toBeNull()
    expect(github.list).not.toHaveBeenCalled()
  })

  test('an available source is offered, off, and costs no listing until it is switched on', async () => {
    github.setAvailability({ available: true, detail: 'tucaen/toucan' })
    github.setListing({ available: true, cards: [issue()], diagnostics: [] })
    await openBoard()

    const toggle = await screen.findByRole('button', { name: 'GitHub' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(github.list).not.toHaveBeenCalled()
    expect(screen.queryByText('GitHub issues as a second source')).toBeNull()

    fireEvent.click(toggle)
    await screen.findByText('GitHub issues as a second source')
    expect(github.listCalls).toEqual([project.path])
    // Files stay on the same board: the sources are additive, never exclusive.
    expect(within(column('In progress')).getByText('Ticket board')).toBeTruthy()
  })

  test('the choice is remembered per project, not for every project on the board', async () => {
    github.setAvailability({ available: true })
    await openBoard()
    fireEvent.click(await screen.findByRole('button', { name: 'GitHub' }))
    await waitFor(() => expect(saved.at(-1)?.ticketBoardPanel?.enabledSources).toEqual({ [project.path]: ['github'] }))

    const list = document.querySelector('.project-list') as HTMLElement
    fireEvent.click(within(list).getByText('Atlas'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'GitHub' })).toHaveAttribute('aria-pressed', 'false'))
  })

  test('a restored choice lists GitHub without the user asking again', async () => {
    github.setAvailability({ available: true })
    github.setListing({ available: true, cards: [issue()], diagnostics: [] })
    await renderApp(
      savedWorkspace({
        ticketBoardPanel: {
          open: true,
          width: TICKET_BOARD_DEFAULT_WIDTH,
          enabledSources: { [project.path]: ['github'] }
        }
      })
    )
    await screen.findByText('GitHub issues as a second source')
  })

  test('a GitHub card cannot be dragged, because nothing would be written back', async () => {
    github.setAvailability({ available: true })
    github.setListing({ available: true, cards: [issue()], diagnostics: [] })
    await openBoard()
    fireEvent.click(await screen.findByRole('button', { name: 'GitHub' }))
    await screen.findByText('GitHub issues as a second source')

    expect(screen.queryByTitle('Move GitHub issues as a second source to another column')).toBeNull()
    expect(screen.getByTitle('Move Ticket board to another column')).toBeTruthy()
  })

  test('a GitHub card opens its issue in the browser instead of a folder', async () => {
    github.setAvailability({ available: true })
    github.setListing({ available: true, cards: [issue()], diagnostics: [] })
    await openBoard()
    fireEvent.click(await screen.findByRole('button', { name: 'GitHub' }))
    await screen.findByText('GitHub issues as a second source')

    fireEvent.click(screen.getByRole('button', { name: 'Open 147 in the browser' }))
    expect(window.terminalApi.openExternal).toHaveBeenCalledWith('https://github.com/tucaen/toucan/issues/147')
    expect(tickets.revealCalls).toEqual([])
  })

  test('a source that stops working says so on the board rather than emptying a column', async () => {
    github.setAvailability({ available: true })
    github.setListing({ available: false, reason: 'gh: please run gh auth login' })
    await openBoard()
    fireEvent.click(await screen.findByRole('button', { name: 'GitHub' }))
    await screen.findByText(/gh auth login/)
    // The files are still the board; only GitHub failed.
    expect(within(column('In progress')).getByText('Ticket board')).toBeTruthy()
  })
})

describe('remembered GitHub choices', () => {
  test('the toggle names the repository the probe found', async () => {
    github.setAvailability({ available: true, detail: 'tucaen/toucan' })
    await openBoard()
    expect(await screen.findByTitle('Show tucaen/toucan tickets')).toBeTruthy()
  })

  test('a choice for a project that no longer exists is dropped rather than kept for good', async () => {
    github.setAvailability({ available: true })
    await renderApp(
      savedWorkspace({
        ticketBoardPanel: {
          open: true,
          width: TICKET_BOARD_DEFAULT_WIDTH,
          enabledSources: { [project.path]: ['github'], 'D:\Development\Gone': ['github'] }
        }
      })
    )
    await screen.findByRole('heading', { name: 'Tickets' })
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize the ticket board' }), { key: 'ArrowLeft' })
    await waitFor(() => expect(saved.at(-1)?.ticketBoardPanel?.enabledSources).toEqual({ [project.path]: ['github'] }))
  })
})
