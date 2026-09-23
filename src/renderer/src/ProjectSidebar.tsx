import {
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  FolderPlus,
  GitBranch,
  GripVertical,
  Plus,
  Settings,
  X
} from 'lucide-react'
import { useCallback, useRef, useState, type ReactNode } from 'react'
import type { ProjectGroup, WorkspaceProject } from '../../shared/workspace'
import type { TerminalNodeStatus } from './canvas-workspace'
import ProjectBranchChip from './ProjectBranchChip'
import { ProjectAvatar } from './ProjectAvatar'
import type { ProjectMenuPage, ProjectMenuTarget } from './ProjectRowMenu'
import { projectSettingsTitle } from './WorkspaceDialogs'
import SessionKindIcon from './SessionKindIcon'
import { SidebarTerminalLiveness } from './TerminalLivenessPresentation'
import { terminalLivenessLabels } from './terminal-liveness'
import { groupDropTarget, projectDropTarget, sidebarRegions, type MeasuredRow } from './project-order'
import { sidebarSummaryFor, type SidebarProjectSummary } from './project-sidebar'

const statusLabels: Record<TerminalNodeStatus, string> = {
  dormant: 'Saved',
  starting: 'Starting',
  idle: 'Idle',
  working: 'Working',
  result: 'Result',
  attention: 'Attention',
  stalled: 'Stalled',
  exited: terminalLivenessLabels.exited
}

export type ProjectDrop = NonNullable<ReturnType<typeof projectDropTarget>>
export type GroupDrop = NonNullable<ReturnType<typeof groupDropTarget>>

/**
 * What the sidebar may ask of the workspace. Every gesture is an intent; the sidebar owns only
 * its drag and holds no workspace state, so closing the canvas context menu, re-ordering
 * `projects`, and everything else these reach stays the canvas's business.
 */
export interface ProjectSidebarIntents {
  selectProject: (projectId: string) => void
  toggleCollapsed: () => void
  addProject: () => void
  addGroup: () => void
  removeProject: (projectId: string) => void
  locateProject: (projectId: string) => void
  focusNode: (nodeId: string) => void
  openProjectSettings: (projectId: string) => void
  /** The row menu at a pointer or anchor position; `page` jumps straight to a submenu. */
  openMenu: (anchor: { x: number; y: number }, target: ProjectMenuTarget, page?: ProjectMenuPage) => void
  toggleGroup: (groupId: string) => void
  commitGroupRename: (groupId: string, name: string) => void
  cancelGroupRename: () => void
  moveProject: (projectId: string, drop: ProjectDrop) => void
  moveGroup: (groupId: string, drop: GroupDrop) => void
  /** A drag is starting: anything floating (the row menu) should close. */
  dragStarted: () => void
  toggleBrainDump: () => void
  toggleTicketBoard: () => void
}

export interface ProjectSidebarProps {
  projects: readonly WorkspaceProject[]
  groups: readonly ProjectGroup[]
  collapsed: boolean
  activeProjectId: string | undefined
  /** Per-project canvas summaries; see `project-sidebar.ts` for how they are derived. */
  summaries: ReadonlyMap<string, SidebarProjectSummary>
  avatars: Readonly<Record<string, string>>
  /** Bumped after Toucan itself checks a branch out, so the rows re-read at once. */
  branchRevision: number
  /** The group whose name is being edited inline, owned by the workspace - the row menu sets it too. */
  renamingGroupId: string | null
  unreadByNode: Readonly<Record<string, number>>
  countUnread: (nodeIds?: readonly string[]) => number
  describeUnread: (nodeIds?: readonly string[]) => string
  brainDumpOpen: boolean
  ticketBoardOpen: boolean
  intents: ProjectSidebarIntents
  /** The canvas zoom/tile controls: they steer React Flow, so the canvas supplies them. */
  canvasControls: ReactNode
}

/**
 * The project sidebar: grouped, draggable project rows with their per-project node lists, the
 * global panel entries and the footer chrome. It renders a projection of the workspace and raises
 * intents; the one piece of state it owns is the drag in flight.
 */
export function ProjectSidebar({
  projects,
  groups,
  collapsed,
  activeProjectId,
  summaries,
  avatars,
  branchRevision,
  renamingGroupId,
  unreadByNode,
  countUnread,
  describeUnread,
  brainDumpOpen,
  ticketBoardOpen,
  intents,
  canvasControls
}: ProjectSidebarProps): JSX.Element {
  /**
   * A drag in flight on a sidebar row. Rows are measured once at `pointerdown` - nothing in the
   * list moves until the drop - and the new order is committed on `pointerup` only, because every
   * change to `projects` re-serialises the whole workspace.
   */
  const [sidebarDrag, setSidebarDrag] = useState<{
    kind: 'project' | 'group'
    id: string
    indicator: { top: number; left: number; width: number } | null
  } | null>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const sidebarRowsRef = useRef(new Map<string, HTMLElement>())

  const registerSidebarRow = useCallback((key: string, element: HTMLElement | null): void => {
    if (element) sidebarRowsRef.current.set(key, element)
    else sidebarRowsRef.current.delete(key)
  }, [])

  const measureSidebarRows = useCallback((): MeasuredRow[] => {
    const measured: MeasuredRow[] = []
    const push = (kind: MeasuredRow['kind'], id: string, groupId?: string): void => {
      const element = sidebarRowsRef.current.get(`${kind}:${id}`)
      if (!element) return
      const rect = element.getBoundingClientRect()
      measured.push({ kind, id, ...(groupId ? { groupId } : {}), top: rect.top, bottom: rect.bottom })
    }
    for (const region of sidebarRegions(projects, groups)) {
      if (region.group) push('group-header', region.group.id)
      if (region.group?.collapsed) continue
      for (const project of region.projects) push('project', project.id, region.group?.id)
    }
    return measured
  }, [groups, projects])

  /**
   * The one drag gesture, shared by project rows and group headers. It only ever starts on the
   * grab handle, so clicking a row or one of its action buttons still does what it always did.
   */
  const startSidebarDrag = useCallback(
    (kind: 'project' | 'group', id: string, event: React.PointerEvent<HTMLElement>): void => {
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.setPointerCapture?.(event.pointerId)
      intents.dragStarted()

      const rows = measureSidebarRows()
      const sidebar = sidebarRef.current?.getBoundingClientRect()
      const frame = { left: sidebar?.left ?? 0, width: sidebar?.width ?? 0 }
      let target: ReturnType<typeof projectDropTarget> | ReturnType<typeof groupDropTarget> = null
      setSidebarDrag({ kind, id, indicator: null })

      const move = (pointer: PointerEvent): void => {
        target =
          kind === 'project' ? projectDropTarget(rows, pointer.clientY, id) : groupDropTarget(rows, pointer.clientY, id)
        setSidebarDrag({
          kind,
          id,
          indicator: target ? { top: target.indicatorY, ...frame } : null
        })
      }
      const finish = (commit: boolean): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', release)
        window.removeEventListener('keydown', cancel)
        setSidebarDrag(null)
        if (!commit || !target) return
        if (kind === 'project' && 'beforeProjectId' in target) {
          intents.moveProject(id, target)
        } else if (kind === 'group' && 'beforeGroupId' in target) {
          intents.moveGroup(id, target)
        }
      }
      const release = (): void => finish(true)
      const cancel = (key: KeyboardEvent): void => {
        if (key.key === 'Escape') finish(false)
      }

      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', release)
      window.addEventListener('keydown', cancel)
    },
    [intents, measureSidebarRows]
  )

  return (
    <aside ref={sidebarRef} className={`project-sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-heading">
        {!collapsed && <span>Projects</span>}
        <button
          type="button"
          className="sidebar-toggle"
          title={collapsed ? 'Expand projects' : 'Collapse projects'}
          onClick={(event) => {
            event.stopPropagation()
            intents.toggleCollapsed()
          }}
        >
          {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronLeft aria-hidden="true" />}
        </button>
      </div>

      <div className="project-list" data-dragging={sidebarDrag ? 'true' : undefined}>
        {sidebarRegions(projects, groups).map((region) => {
          const group = region.group
          return (
            <div className="project-region" key={group?.id ?? 'ungrouped'} data-group={group?.id}>
              {group && (
                <div
                  className="project-group-header"
                  ref={(element) => registerSidebarRow(`group-header:${group.id}`, element)}
                  data-expanded={group.collapsed ? undefined : 'true'}
                  data-dragging={sidebarDrag?.kind === 'group' && sidebarDrag.id === group.id ? 'true' : undefined}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    intents.openMenu({ x: event.clientX, y: event.clientY }, { kind: 'group', group })
                  }}
                >
                  <span
                    className="project-drag-handle"
                    title={`Drag to re-order ${group.name}`}
                    onPointerDown={(event) => startSidebarDrag('group', group.id, event)}
                  >
                    <GripVertical aria-hidden="true" />
                  </span>
                  {renamingGroupId === group.id ? (
                    <input
                      className="project-group-rename"
                      autoFocus
                      defaultValue={group.name}
                      aria-label={`Rename ${group.name}`}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') intents.commitGroupRename(group.id, event.currentTarget.value)
                        if (event.key === 'Escape') {
                          event.stopPropagation()
                          intents.cancelGroupRename()
                        }
                      }}
                      onBlur={(event) => intents.commitGroupRename(group.id, event.currentTarget.value)}
                    />
                  ) : (
                    <button
                      type="button"
                      className="project-group-toggle"
                      aria-expanded={!group.collapsed}
                      title={`${group.name} · ${region.projects.length} project${
                        region.projects.length === 1 ? '' : 's'
                      }`}
                      onClick={(event) => {
                        event.stopPropagation()
                        intents.toggleGroup(group.id)
                      }}
                    >
                      <span className="project-group-chevron" aria-hidden="true">
                        <ChevronDown />
                      </span>
                      {collapsed ? (
                        <span className="project-avatar project-group-avatar">
                          {group.name.slice(0, 1).toUpperCase()}
                        </span>
                      ) : (
                        <>
                          <strong>{group.name}</strong>
                          <span className="project-group-count">{region.projects.length}</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              )}
              {!group?.collapsed &&
                region.projects.map((project) => {
                  const summary = sidebarSummaryFor(summaries, project.id)
                  // Summed from the same records as the header chip and the nodes, never re-derived.
                  const projectUnread = countUnread(summary.sessionNodeIds)
                  const selected = project.id === activeProjectId
                  return (
                    <div className="project-section" key={project.id}>
                      <div
                        className={`project-row ${selected ? 'active' : ''}`}
                        ref={(element) => registerSidebarRow(`project:${project.id}`, element)}
                        data-dragging={
                          sidebarDrag?.kind === 'project' && sidebarDrag.id === project.id ? 'true' : undefined
                        }
                        onContextMenu={(event) => {
                          event.preventDefault()
                          intents.openMenu({ x: event.clientX, y: event.clientY }, { kind: 'project', project })
                        }}
                      >
                        <span
                          className="project-drag-handle"
                          title={`Drag to re-order ${project.name}`}
                          onPointerDown={(event) => startSidebarDrag('project', project.id, event)}
                        >
                          <GripVertical aria-hidden="true" />
                        </span>
                        <button
                          type="button"
                          className="project-select"
                          title={collapsed ? `${project.name}\n${project.path}` : undefined}
                          onClick={(event) => {
                            event.stopPropagation()
                            intents.selectProject(project.id)
                          }}
                        >
                          <ProjectAvatar project={project} avatarUrl={avatars[project.id] ?? null}>
                            {projectUnread > 0 && (
                              <span
                                className="unread-badge project-unread"
                                title={describeUnread(summary.sessionNodeIds)}
                              >
                                {projectUnread}
                              </span>
                            )}
                          </ProjectAvatar>
                          {!collapsed && (
                            <span className="project-copy">
                              <strong title={project.path}>{project.name}</strong>
                            </span>
                          )}
                        </button>
                        {!collapsed && (
                          <div className="project-actions">
                            <button
                              type="button"
                              className="project-setup"
                              title={projectSettingsTitle(project)}
                              data-configured={
                                project.setupCommand || project.ticketsDirectory || project.runCommands?.length
                                  ? 'true'
                                  : undefined
                              }
                              onClick={(event) => {
                                event.stopPropagation()
                                intents.openProjectSettings(project.id)
                              }}
                            >
                              <Settings aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="project-locate"
                              title={
                                summary.nodeCount > 0 ? `Show ${project.name} nodes` : 'No nodes on the canvas yet'
                              }
                              disabled={summary.nodeCount === 0}
                              onClick={(event) => {
                                event.stopPropagation()
                                intents.locateProject(project.id)
                              }}
                            >
                              {summary.nodeCount}
                            </button>
                            <button
                              type="button"
                              className="project-remove"
                              title={
                                summary.nodeCount > 0 ? 'Delete this project’s nodes first' : `Remove ${project.name}`
                              }
                              disabled={summary.nodeCount > 0}
                              onClick={(event) => {
                                event.stopPropagation()
                                intents.removeProject(project.id)
                              }}
                            >
                              <X aria-hidden="true" />
                            </button>
                          </div>
                        )}
                        {!collapsed && (
                          <div className="project-branch-line">
                            <ProjectBranchChip
                              directory={project.path}
                              revision={branchRevision}
                              onOpen={(anchor) =>
                                intents.openMenu(
                                  { x: anchor.left, y: anchor.bottom + 4 },
                                  { kind: 'project', project },
                                  'branches'
                                )
                              }
                            />
                          </div>
                        )}
                      </div>

                      {!collapsed && summary.worktrees.length > 0 && (
                        <div className="project-node-list project-worktree-list">
                          {summary.worktrees.map((worktree) => (
                            <button
                              type="button"
                              className={`project-node-row ${worktree.selected ? 'selected' : ''}`}
                              key={worktree.id}
                              title={`Focus worktree ${worktree.branch}\n${worktree.path}`}
                              onClick={(event) => {
                                event.stopPropagation()
                                intents.focusNode(worktree.id)
                              }}
                            >
                              <span className="project-node-kind">
                                <GitBranch aria-hidden="true" />
                              </span>
                              <span className="project-node-name">{worktree.branch}</span>
                              <span className="project-node-state" data-status="worktree">
                                {worktree.attachedNodeCount}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}

                      {!collapsed && summary.sessions.length > 0 && (
                        <div className="project-node-list">
                          {summary.sessions.map((session) => {
                            const nodeUnread = unreadByNode[session.id] ?? 0
                            return (
                              <button
                                type="button"
                                className={`project-node-row ${session.selected ? 'selected' : ''}`}
                                key={session.id}
                                data-kind={session.kind}
                                data-unread={nodeUnread > 0 ? 'true' : undefined}
                                title={[
                                  `Focus ${session.label} · ${statusLabels[session.status]}`,
                                  nodeUnread > 0 ? describeUnread([session.id]) : null
                                ]
                                  .filter(Boolean)
                                  .join('\n')}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  intents.focusNode(session.id)
                                }}
                              >
                                <span className="project-node-kind">
                                  <SessionKindIcon kind={session.kind} />
                                </span>
                                <span className="project-node-name">{session.label}</span>
                                {nodeUnread > 0 && <span className="unread-badge">{nodeUnread}</span>}
                                {session.kind === 'terminal' && session.terminalLiveness !== undefined && (
                                  <SidebarTerminalLiveness liveness={session.terminalLiveness} />
                                )}
                                <span className="project-node-state" data-status={session.status}>
                                  <span className="node-status-indicator" />
                                  {statusLabels[session.status]}
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
            </div>
          )
        })}
      </div>

      {sidebarDrag?.indicator && (
        <div
          className="project-drop-indicator"
          aria-hidden="true"
          style={{
            position: 'fixed',
            top: sidebarDrag.indicator.top,
            left: sidebarDrag.indicator.left,
            width: sidebarDrag.indicator.width
          }}
        />
      )}

      {/* The sidebar's chrome, below the scrolling project list: global destinations,
      the create actions, and the canvas controls. One block with one alignment and one
      border language so the footer reads as chrome rather than as four loose widgets.
      The canvas controls live here rather than floating on the canvas because a
      floating group overlaps auto-laid-out nodes. */}
      <div className="sidebar-footer">
        <div className="sidebar-footer-group">
          <button
            type="button"
            className="sidebar-global-entry"
            aria-pressed={brainDumpOpen}
            title={collapsed ? 'Open brain-dump library' : 'Brain dumps (Ctrl+Shift+B)'}
            onClick={(event) => {
              event.stopPropagation()
              intents.toggleBrainDump()
            }}
          >
            <span className="sidebar-global-icon" aria-hidden="true">
              <BookOpen />
            </span>
            {!collapsed && <span>Brain dumps</span>}
            {collapsed && <span className="visually-hidden">Open brain-dump library</span>}
          </button>

          <button
            type="button"
            className="sidebar-global-entry"
            aria-pressed={ticketBoardOpen}
            title={collapsed ? 'Open the ticket board' : 'Tickets (Ctrl+Shift+K)'}
            onClick={(event) => {
              event.stopPropagation()
              intents.toggleTicketBoard()
            }}
          >
            <span className="sidebar-global-icon" aria-hidden="true">
              <ClipboardList />
            </span>
            {!collapsed && <span>Tickets</span>}
            {collapsed && <span className="visually-hidden">Open the ticket board</span>}
          </button>
        </div>

        <div className="sidebar-add-row">
          <button
            type="button"
            className="add-project"
            title="Add project folder"
            onClick={(event) => {
              event.stopPropagation()
              intents.addProject()
            }}
          >
            <Plus aria-hidden="true" />
            {!collapsed && 'Add project'}
          </button>
          <button
            type="button"
            className="add-project add-project-group"
            title="New group"
            aria-label="New group"
            onClick={(event) => {
              event.stopPropagation()
              intents.addGroup()
            }}
          >
            <FolderPlus aria-hidden="true" />
          </button>
        </div>

        {canvasControls}
      </div>
    </aside>
  )
}
