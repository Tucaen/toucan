import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import App from '../src/renderer/src/App'
import { TICKET_BOARD_DEFAULT_WIDTH, TICKET_BOARD_MAX_WIDTH } from '../src/renderer/src/ticket-board-layout'
import { TICKET_DETAIL_DEFAULT_WIDTH } from '../src/renderer/src/ticket-board-panes'
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

const stateRow = (label: string): HTMLElement => screen.getByRole('tab', { name: new RegExp(`^${label},`) })

/**
 * The tickets pane only ever shows one state, so looking inside another means choosing it - which
 * is exactly what a user does. Returns the pane, so the assertions below read as they did.
 */
const column = (label: string): HTMLElement => {
  fireEvent.click(stateRow(label))
  return screen.getByRole('tabpanel', { name: `${label} tickets` })
}

const detail = (): HTMLElement => screen.getByRole('region', { name: 'Ticket detail' })

const issue = (overrides: Partial<ReturnType<typeof cardFixture>> = {}): ReturnType<typeof cardFixture> =>
  cardFixture({
    sourceId: 'github',
    id: '147',
    title: 'GitHub issues as a second source',
    url: 'https://github.com/tucaen/toucan/issues/147',
    ...overrides
  })

/** Every card action sits behind the card's own menu, so the test opens it the way a user would. */
async function chooseCardAction(cardId: string, action: RegExp | string): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${cardId}` }))
  const menu = await screen.findByRole('menu', { name: `Actions for ${cardId}` })
  fireEvent.click(within(menu).getByRole('menuitem', { name: action }))
}

const STATE_ROW_HEIGHT = 32

/** jsdom measures nothing, so the drag maths is given the layout the state list would have had. */
function layoutStates(): void {
  document.querySelectorAll<HTMLElement>('.ticket-state-row').forEach((element, index) => {
    const top = index * STATE_ROW_HEIGHT
    element.getBoundingClientRect = (): DOMRect =>
      ({
        top,
        bottom: top + STATE_ROW_HEIGHT,
        left: 0,
        right: 140,
        width: 140,
        height: STATE_ROW_HEIGHT,
        x: 0,
        y: top,
        toJSON: () => ({})
      }) as DOMRect
  })
}

/** jsdom has no `PointerEvent`, and the board only ever reads the coordinates off one. */
function pointer(type: string, target: EventTarget, clientY: number): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 60, clientY })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  act(() => {
    target.dispatchEvent(event)
  })
}

/** The drop target is a state row now, so a drag runs down the state list rather than across. */
function dragCard(cardTitle: string, toStateIndex: number, options: { cancel?: boolean } = {}): void {
  layoutStates()
  pointer('pointerdown', screen.getByTitle(`Move ${cardTitle} to another state`), 500)
  pointer('pointermove', window, toStateIndex * STATE_ROW_HEIGHT + 10)
  if (options.cancel) {
    fireEvent.keyDown(window, { key: 'Escape' })
    return
  }
  pointer('pointerup', window, toStateIndex * STATE_ROW_HEIGHT + 10)
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

describe('the three panes', () => {
  test('every shipped status is a state row, and the pane shows the one that is selected', async () => {
    await openBoard()
    await screen.findByText('File node')
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Open1',
      'In progress1',
      'Blocked0',
      'Done1'
    ])
    // The first state with tickets opens the board; the others are one click away.
    expect(stateRow('Open')).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByText('Ticket board')).toBeNull()

    expect(within(column('In progress')).getByText('Ticket board')).toBeInTheDocument()
    expect(screen.queryByText('File node')).toBeNull()
  })

  test('Done still lists the recent ones only, and offers everything it is withholding', async () => {
    tickets.projects.set(project.path, {
      cards: [
        cardFixture({ id: 'recent', title: 'Recently closed', status: 'done', updated: '2026-09-01' }),
        cardFixture({ id: 'ancient', title: 'Long closed', status: 'done', updated: '2026-01-01' })
      ],
      diagnostics: []
    })
    await openBoard()
    await waitFor(() => expect(within(stateRow('Done')).getByText('2')).toBeInTheDocument())
    expect(screen.getByText('Recently closed')).toBeInTheDocument()
    // Older than the 30-day cutoff: counted, withheld, and reachable through the toggle.
    expect(screen.queryByText('Long closed')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show all (1 older)' }))
    expect(screen.getByText('Long closed')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show recent only' }))
    expect(screen.queryByText('Long closed')).toBeNull()
  })

  test('a state nobody has filled is still a row, so there is somewhere to drop a card', async () => {
    await openBoard()
    await screen.findByText('File node')
    expect(within(column('Blocked')).getByText('No tickets in Blocked.')).toBeInTheDocument()
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

  test('selecting a ticket renders its Markdown in the detail pane, not inside the card', async () => {
    tickets.projects.set(project.path, {
      cards: [cardFixture({ id: 'file-node', title: 'File node', body: '\n## Acceptance\n\nRenders Markdown.\n' })],
      diagnostics: []
    })
    await openBoard()
    expect(screen.queryByRole('region', { name: 'Ticket detail' })).toBeNull()

    fireEvent.click(await screen.findByRole('button', { name: 'File node' }))

    const body = await screen.findByRole('heading', { name: 'Acceptance' })
    // The whole point of the redesign: the body wraps at the pane, not at a 200px card.
    expect(detail().contains(body)).toBe(true)
    expect(body.closest('.ticket-card')).toBeNull()
    expect(within(detail()).getByText('Renders Markdown.')).toBeInTheDocument()
  })

  test('a ticket stays open after it changes state, and the state list follows it', async () => {
    await openBoard()
    fireEvent.click(await screen.findByRole('button', { name: 'File node' }))
    expect(within(detail()).getByRole('heading', { name: 'File node' })).toBeInTheDocument()

    dragCard('File node', 3)

    await waitFor(() => expect(stateRow('Done')).toHaveAttribute('aria-selected', 'true'))
    expect(within(detail()).getByRole('heading', { name: 'File node' })).toBeInTheDocument()
  })

  test('a ticket that is deleted out from under the detail closes it rather than showing a ghost', async () => {
    await openBoard()
    fireEvent.click(await screen.findByRole('button', { name: 'File node' }))
    await screen.findByRole('region', { name: 'Ticket detail' })

    const listing = tickets.projects.get(project.path)!
    listing.cards = listing.cards.filter((card) => card.id !== 'file-node')
    act(() => tickets.publishChange(project.path))

    await waitFor(() => expect(screen.queryByRole('region', { name: 'Ticket detail' })).toBeNull())
  })

  test('a ticket deleted after it was moved leaves the board on the state it moved to', async () => {
    await openBoard()
    fireEvent.click(await screen.findByRole('button', { name: 'File node' }))

    dragCard('File node', 3)
    await waitFor(() => expect(stateRow('Done')).toHaveAttribute('aria-selected', 'true'))

    const listing = tickets.projects.get(project.path)!
    listing.cards = listing.cards.filter((card) => card.id !== 'file-node')
    act(() => tickets.publishChange(project.path))

    // The state the user is reading in outlives the ticket that took them there.
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Ticket detail' })).toBeNull())
    expect(stateRow('Done')).toHaveAttribute('aria-selected', 'true')
  })
})

describe('a board too narrow for three panes', () => {
  test('the detail replaces the list, and a back affordance returns to it with focus', async () => {
    await renderApp(savedWorkspace({ ticketBoardPanel: { open: true, width: 520 } }))
    fireEvent.click(await screen.findByRole('button', { name: 'File node' }))

    await screen.findByRole('region', { name: 'Ticket detail' })
    expect(screen.queryByRole('tabpanel', { name: 'Open tickets' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^Back to Open/ }))
    const list = await screen.findByRole('tabpanel', { name: 'Open tickets' })
    expect(screen.queryByRole('region', { name: 'Ticket detail' })).toBeNull()
    // The way out only re-mounts the list on the next render, so focus has to wait for it.
    expect(list.contains(document.activeElement)).toBe(true)
  })

  test('a wide board shows both, with a divider between them', async () => {
    await openBoard()
    fireEvent.click(await screen.findByRole('button', { name: 'File node' }))

    await screen.findByRole('region', { name: 'Ticket detail' })
    expect(screen.getByRole('tabpanel', { name: 'Open tickets' })).toBeInTheDocument()
    expect(screen.getByRole('separator', { name: 'Resize the ticket detail' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Back to/ })).toBeNull()
  })

  test('the divider resizes the detail, and the width is remembered', async () => {
    await openBoard()
    fireEvent.click(await screen.findByRole('button', { name: 'File node' }))
    const divider = await screen.findByRole('separator', { name: 'Resize the ticket detail' })

    fireEvent.keyDown(divider, { key: 'ArrowLeft' })

    await waitFor(() => expect(saved.at(-1)?.ticketBoardPanel?.detailWidth).toBe(TICKET_DETAIL_DEFAULT_WIDTH + 24))
  })
})

describe('moving around the board with the keyboard', () => {
  test('Up and Down walk the state list, Right steps into the tickets', async () => {
    await openBoard()
    await screen.findByText('File node')

    fireEvent.keyDown(stateRow('Open'), { key: 'ArrowDown' })
    await waitFor(() => expect(stateRow('In progress')).toHaveAttribute('aria-selected', 'true'))
    expect(screen.getByText('Ticket board')).toBeInTheDocument()

    fireEvent.keyDown(stateRow('In progress'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Ticket board' }))
  })

  test('Up and Down walk the tickets, and Left goes back to the states', async () => {
    tickets.projects.set(project.path, {
      cards: [
        cardFixture({ id: 'first', title: 'First ticket', updated: '2026-09-03' }),
        cardFixture({ id: 'second', title: 'Second ticket', updated: '2026-09-02' })
      ],
      diagnostics: []
    })
    await openBoard()
    const first = await screen.findByRole('button', { name: 'First ticket' })
    fireEvent.click(first)

    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Second ticket' }))
    expect(within(detail()).getByRole('heading', { name: 'Second ticket' })).toBeInTheDocument()

    fireEvent.keyDown(screen.getByRole('button', { name: 'Second ticket' }), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(stateRow('Open'))
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

    fireEvent.keyDown(screen.getByTitle('Move File node to another state'), { key: 'ArrowRight' })

    await waitFor(() => expect(tickets.setStatus).toHaveBeenCalledWith(project.path, 'file-node', 'in-progress'))
  })
})

describe('following the project and the disk', () => {
  test('an edit made outside Toucan reaches the board without a restart', async () => {
    await openBoard()
    await screen.findByText('File node')

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
    await screen.findByText('File node')

    const list = document.querySelector('.project-list')!
    fireEvent.click(within(list as HTMLElement).getByText('Atlas'))

    expect(await screen.findByText('Atlas only')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('File node')).toBeNull())
    expect(tickets.listCalls).toContain(other.path)
  })

  test('reopening the board re-lists, so a source with no watcher catches up on what changed', async () => {
    github.setAvailability({ available: true })
    github.setListing({ available: true, cards: [issue()], diagnostics: [] })
    await openBoard()
    fireEvent.click(await screen.findByRole('button', { name: 'GitHub' }))
    await screen.findByText('GitHub issues as a second source')
    const listedBefore = github.listCalls.length

    fireEvent.click(screen.getByRole('button', { name: 'Close the ticket board' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Tickets' })).toBeNull())
    github.setListing({
      available: true,
      cards: [issue({ id: '148', title: 'Editing inside the file node' })],
      diagnostics: []
    })

    fireEvent.click(screen.getByRole('button', { name: /^Tickets/ }))
    expect(await screen.findByText('Editing inside the file node')).toBeInTheDocument()
    expect(github.listCalls.length).toBe(listedBefore + 1)
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

    expect(screen.queryByTitle('Move GitHub issues as a second source to another state')).toBeNull()
    // A file card in the same list still has its grip: only GitHub refuses the write.
    expect(screen.getByTitle('Move File node to another state')).toBeTruthy()
  })

  test('a GitHub card opens its issue in the browser instead of a folder', async () => {
    github.setAvailability({ available: true })
    github.setListing({ available: true, cards: [issue()], diagnostics: [] })
    await openBoard()
    fireEvent.click(await screen.findByRole('button', { name: 'GitHub' }))
    await screen.findByText('GitHub issues as a second source')

    await chooseCardAction('147', 'Open 147 in the browser')
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

describe('deleting tickets', () => {
  test('a card is only deleted through a confirmation, and the board waits for the re-read', async () => {
    await openBoard()
    await screen.findByText('File node')

    await chooseCardAction('file-node', 'Delete file-node')
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Delete “File node”?')).toBeTruthy()
    expect(tickets.removeCalls).toEqual([])

    // Cancel is not a deletion, and it leaves the card exactly where it was.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(tickets.removeCalls).toEqual([])
    expect(screen.getByText('File node')).toBeTruthy()

    await chooseCardAction('file-node', 'Delete file-node')
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByText('File node')).toBeNull())
    expect(tickets.removeCalls).toEqual([[project.path, 'file-node']])
    // Disk is truth here too: the card left because the re-read no longer listed it.
    expect(tickets.listCalls.filter((path) => path === project.path).length).toBeGreaterThan(1)
  })

  test('a git checkout is told the file stays recoverable', async () => {
    await openBoard()
    await screen.findByText('File node')
    await chooseCardAction('file-node', 'Delete file-node')
    expect(within(await screen.findByRole('dialog')).getByText(/Git history keeps it/)).toBeTruthy()
  })

  test('a project that is not a checkout is told the deletion is final', async () => {
    tickets.setGitRepository(false)
    await openBoard()
    await screen.findByText('File node')
    await chooseCardAction('file-node', 'Delete file-node')
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/not a git checkout, so this is final/)).toBeTruthy()
    expect(within(dialog).queryByText(/Git history keeps it/)).toBeNull()
  })

  test('the Done column sweeps only tickets past the cutoff, naming every one it would delete', async () => {
    tickets.projects.set(project.path, {
      cards: [
        cardFixture({ id: 'closed-long-ago', title: 'Closed long ago', status: 'done', updated: '2026-01-05' }),
        cardFixture({ id: 'also-long-ago', title: 'Also long ago', status: 'done', updated: '2026-02-05' }),
        cardFixture({ id: 'closed-recently', title: 'Closed recently', status: 'done', updated: '2026-09-01' }),
        cardFixture({ id: 'still-open', title: 'Still open', status: 'open', updated: '2026-01-05' })
      ],
      diagnostics: []
    })
    await openBoard()
    await screen.findByText('Still open')
    column('Done')

    fireEvent.click(screen.getByRole('button', { name: 'Delete done tickets older than 30 days' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Delete 2 done tickets?')).toBeTruthy()
    expect(within(dialog).getByText('also-long-ago')).toBeTruthy()
    expect(within(dialog).getByText('closed-long-ago')).toBeTruthy()
    expect(within(dialog).queryByText('closed-recently')).toBeNull()
    expect(within(dialog).queryByText('still-open')).toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // One call per slug, and only for the slugs the confirmation listed.
    expect(tickets.removeCalls).toEqual([
      [project.path, 'also-long-ago'],
      [project.path, 'closed-long-ago']
    ])
    expect(within(column('Open')).getByText('Still open')).toBeTruthy()
    // Only the two past the cutoff went; the recent one is what Done still lists.
    expect(within(stateRow('Done')).getByText('1')).toBeTruthy()
    expect(within(column('Done')).getByText('Closed recently')).toBeTruthy()
  })

  test('a GitHub card offers no Delete, because its issues are not Toucan’s to destroy', async () => {
    github.setAvailability({ available: true })
    github.setListing({ available: true, cards: [issue()], diagnostics: [] })
    await openBoard()
    fireEvent.click(await screen.findByRole('button', { name: 'GitHub' }))
    await screen.findByText('GitHub issues as a second source')

    fireEvent.click(screen.getByRole('button', { name: 'Actions for 147' }))
    const issueMenu = await screen.findByRole('menu', { name: 'Actions for 147' })
    expect(within(issueMenu).queryByRole('menuitem', { name: 'Delete 147' })).toBeNull()
    expect(within(issueMenu).getByRole('menuitem', { name: 'Open 147 in the browser' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Actions for file-node' }))
    const fileMenu = await screen.findByRole('menu', { name: 'Actions for file-node' })
    expect(within(fileMenu).getByRole('menuitem', { name: 'Delete file-node' })).toBeTruthy()
    // One menu at a time: opening the file card's closed the issue's.
    expect(screen.queryByRole('menu', { name: 'Actions for 147' })).toBeNull()
  })

  test('a deletion that fails keeps the confirmation open with a retry and the card on the board', async () => {
    tickets.remove = vi.fn(async () => ({ ok: false as const, code: 'delete-failed', message: 'EPERM: denied' }))
    await openBoard()
    await screen.findByText('File node')

    await chooseCardAction('file-node', 'Delete file-node')
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(/EPERM: denied/)).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.getByText('File node')).toBeTruthy()
  })
})
