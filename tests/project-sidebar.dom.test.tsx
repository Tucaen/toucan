import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { ProjectSidebar, type ProjectSidebarIntents, type ProjectSidebarProps } from '../src/renderer/src/ProjectSidebar'
import type { SidebarProjectSummary } from '../src/renderer/src/project-sidebar'
import type { ProjectGroup, WorkspaceProject } from '../src/shared/workspace'

/**
 * The sidebar module on its own: it renders a projection and raises intents, so these tests mount
 * `ProjectSidebar` directly - no React Flow, no canvas, no app harness. Drag reorder and grouping
 * prove the one piece of state the module owns (the drag in flight) commits the right drop, and
 * the unread pill proves the counts come from the selectors it was handed, never re-derived.
 */

const alpha: WorkspaceProject = { id: 'alpha', name: 'Alpha', path: 'D:\\Alpha', color: '#71a9ff' }
const beta: WorkspaceProject = { id: 'beta', name: 'Beta', path: 'D:\\Beta', color: '#e69a71' }

const emptySummary: SidebarProjectSummary = { sessions: [], worktrees: [], nodeCount: 0, sessionNodeIds: [] }

function intentsSpy(): ProjectSidebarIntents {
  return {
    selectProject: vi.fn(),
    toggleCollapsed: vi.fn(),
    addProject: vi.fn(),
    addGroup: vi.fn(),
    removeProject: vi.fn(),
    locateProject: vi.fn(),
    focusNode: vi.fn(),
    openProjectSettings: vi.fn(),
    openMenu: vi.fn(),
    toggleGroup: vi.fn(),
    commitGroupRename: vi.fn(),
    cancelGroupRename: vi.fn(),
    moveProject: vi.fn(),
    moveGroup: vi.fn(),
    dragStarted: vi.fn(),
    toggleBrainDump: vi.fn(),
    toggleTicketBoard: vi.fn()
  }
}

function renderSidebar(overrides: Partial<ProjectSidebarProps> = {}): ProjectSidebarIntents {
  const intents = overrides.intents ?? intentsSpy()
  render(
    <ProjectSidebar
      projects={[alpha, beta]}
      groups={[]}
      collapsed={false}
      activeProjectId={alpha.id}
      summaries={new Map()}
      avatars={{}}
      branchRevision={0}
      renamingGroupId={null}
      unreadByNode={{}}
      countUnread={() => 0}
      describeUnread={() => ''}
      brainDumpOpen={false}
      ticketBoardOpen={false}
      canvasControls={<div data-testid="canvas-controls" />}
      {...overrides}
      intents={intents}
    />
  )
  return intents
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

describe('drag reorder', () => {
  test('a drag by the handle commits a project drop on pointerup', () => {
    const intents = renderSidebar()

    dragRow('Drag to re-order Beta', 5)

    expect(intents.dragStarted).toHaveBeenCalledTimes(1)
    expect(intents.moveProject).toHaveBeenCalledWith('beta', expect.objectContaining({ beforeProjectId: 'alpha' }))
    expect(intents.moveGroup).not.toHaveBeenCalled()
  })

  test('the drop indicator follows the pointer and Escape cancels without committing', () => {
    const intents = renderSidebar()
    layoutSidebarRows()
    pointer('pointerdown', screen.getByTitle('Drag to re-order Beta'), 0)
    pointer('pointermove', window, 5)
    expect(document.querySelector('.project-drop-indicator')).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('.project-drop-indicator')).toBeNull()
    expect(intents.moveProject).not.toHaveBeenCalled()
  })

  test('group headers commit a group drop, never a project one', () => {
    const intents = renderSidebar({
      projects: [
        { ...alpha, groupId: 'group-1' },
        { ...beta, groupId: 'group-2' }
      ],
      groups: [
        { id: 'group-1', name: 'First', collapsed: true },
        { id: 'group-2', name: 'Second', collapsed: true }
      ]
    })

    dragRow('Drag to re-order Second', 5)

    expect(intents.moveGroup).toHaveBeenCalledWith('group-2', expect.objectContaining({ beforeGroupId: 'group-1' }))
    expect(intents.moveProject).not.toHaveBeenCalled()
  })
})

describe('grouping', () => {
  const groups: ProjectGroup[] = [{ id: 'group-1', name: 'Work', collapsed: false }]
  const grouped = [{ ...alpha, groupId: 'group-1' }, beta]

  test('dragging a project onto a group header commits a drop naming the group', () => {
    const intents = renderSidebar({ projects: grouped, groups })

    dragRow('Drag to re-order Beta', 20)

    expect(intents.moveProject).toHaveBeenCalledWith('beta', expect.objectContaining({ groupId: 'group-1' }))
  })

  test('a collapsed group hides its members and the toggle raises the intent', () => {
    const intents = renderSidebar({
      projects: grouped,
      groups: [{ id: 'group-1', name: 'Work', collapsed: true }]
    })

    const rows = Array.from(document.querySelectorAll('.project-row .project-copy strong')).map(
      (row) => row.textContent
    )
    expect(rows).toEqual(['Beta'])

    const header = screen.getByTitle('Work · 1 project')
    expect(header).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(header)
    expect(intents.toggleGroup).toHaveBeenCalledWith('group-1')
  })

  test('the inline rename field commits on Enter and cancels on Escape', () => {
    const intents = renderSidebar({ projects: grouped, groups, renamingGroupId: 'group-1' })

    const rename = screen.getByLabelText('Rename Work')
    fireEvent.change(rename, { target: { value: 'Deep Work' } })
    fireEvent.keyDown(rename, { key: 'Enter' })
    expect(intents.commitGroupRename).toHaveBeenCalledWith('group-1', 'Deep Work')

    fireEvent.keyDown(rename, { key: 'Escape' })
    expect(intents.cancelGroupRename).toHaveBeenCalled()
  })
})

describe('the unread pill', () => {
  const summaries = new Map<string, SidebarProjectSummary>([
    [
      alpha.id,
      {
        sessions: [
          {
            id: 'node-1',
            label: 'Fix the tests',
            kind: 'claude',
            selected: false,
            status: 'idle',
            terminalLiveness: undefined
          },
          {
            id: 'node-2',
            label: 'Quiet chat',
            kind: 'codex',
            selected: false,
            status: 'idle',
            terminalLiveness: undefined
          }
        ],
        worktrees: [],
        nodeCount: 2,
        sessionNodeIds: ['node-1', 'node-2']
      }
    ]
  ])

  test('the project pill and the node badge come from the selectors, with the description as tooltip', () => {
    renderSidebar({
      summaries,
      unreadByNode: { 'node-1': 2 },
      countUnread: (nodeIds) => (nodeIds?.includes('node-1') ? 3 : 0),
      describeUnread: (nodeIds) => (nodeIds?.length === 1 ? '2 unread on this chat' : '3 unread in Alpha')
      // The pill describes the whole project's nodes, the badge only its own row's.
    })

    const pill = document.querySelector('.project-unread')
    expect(pill?.textContent).toBe('3')
    expect(pill).toHaveAttribute('title', '3 unread in Alpha')

    const row = screen.getByText('Fix the tests').closest('.project-node-row')
    expect(row).toHaveAttribute('data-unread', 'true')
    expect(within(row as HTMLElement).getByText('2', { selector: '.unread-badge' })).toBeTruthy()
    expect(row?.getAttribute('title')).toContain('2 unread on this chat')
  })

  test('no unread records means no pill and no badge', () => {
    renderSidebar({ summaries })

    expect(document.querySelector('.project-unread')).toBeNull()
    expect(document.querySelector('.unread-badge')).toBeNull()
    expect(document.querySelector('.project-node-row')).toHaveAttribute('title', 'Focus Fix the tests · Idle')
  })

  test('a focus click on a session row raises the focus intent', () => {
    const intents = renderSidebar({ summaries })

    fireEvent.click(screen.getByText('Fix the tests'))
    expect(intents.focusNode).toHaveBeenCalledWith('node-1')
  })
})
