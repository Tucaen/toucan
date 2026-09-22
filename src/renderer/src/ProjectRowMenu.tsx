import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { computeNodePickerMenuPosition } from './node-picker-menu-position'
import { Check, ChevronLeft, FolderMinus, FolderPlus, GitBranch, Palette, PencilLine, Play, Trash2 } from 'lucide-react'
import { runnableCommands } from '../../shared/project-run-commands'
import type { ProjectGroup, WorkspaceProject } from '../../shared/workspace'
import ProjectColorPicker from './ProjectColorPicker'
import {
  describeBranchChoiceBlocker,
  type GitBranchListResult,
  type GitCheckoutResult,
  type GitLocalBranch
} from '../../shared/git-branch'

/**
 * The right-click menu on a sidebar row. It portals to `<body>` for the same reason every other
 * floating menu in Toucan does - the sidebar clips overflow, so a CSS-anchored menu would be cut
 * off at the first project row - and it is positioned in viewport coordinates at the pointer.
 *
 * The colour picker is a second page of this same menu rather than a menu of its own: one portal,
 * one Escape, one outside click, so a half-open colour popover can never outlive its row. The
 * branch switcher is a third page for the same reason, and the row's branch chip opens the menu
 * straight onto it.
 */

export type ProjectMenuTarget = { kind: 'project'; project: WorkspaceProject } | { kind: 'group'; group: ProjectGroup }

export type ProjectMenuPage = 'root' | 'colour' | 'groups' | 'branches'

export interface ProjectRowMenuProps {
  x: number
  y: number
  target: ProjectMenuTarget
  /** The page to open on; the branch chip opens straight onto the switcher. */
  initialPage?: ProjectMenuPage
  groups: readonly ProjectGroup[]
  onClose(): void
  onListBranches(projectPath: string): Promise<GitBranchListResult>
  /** Resolves with git's refusal rather than throwing, so the page can show it beside the list. */
  onSwitchBranch(project: WorkspaceProject, branch: string): Promise<GitCheckoutResult>
  /** How many sessions are mid-turn in the project checkout itself; any at all blocks a switch. */
  workingSessions(projectId: string): number
  onColorChange(projectId: string, color: string): void
  /** `undefined` takes the project back to the top level. */
  onMoveToGroup(projectId: string, groupId: string | undefined): void
  onCreateGroup(projectId: string): void
  /** Starts one of the project's saved run commands; each call is its own terminal node. */
  onRunCommand(projectId: string, commandId: string): void
  onRenameGroup(groupId: string): void
  onDeleteGroup(groupId: string): void
}

export default function ProjectRowMenu(props: ProjectRowMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState<ProjectMenuPage>(props.initialPage ?? 'root')

  /*
   * The pointer is the anchor, and the menu changes height when it turns into the colour or group
   * page - so it is re-measured and re-clamped per page, or a right-click near the bottom of the
   * window would push the swatch row off-screen.
   */
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    const menu = menuRef.current?.getBoundingClientRect()
    setPosition(
      computeNodePickerMenuPosition(
        { top: props.y, bottom: props.y, left: props.x, right: props.x },
        { width: menu?.width || 220, height: menu?.height ?? 0 },
        { width: window.innerWidth, height: window.innerHeight },
        { align: 'start', gap: 0 }
      )
    )
  }, [page, props.x, props.y])

  const { onClose } = props
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const project = props.target.kind === 'project' ? props.target.project : null
  const group = props.target.kind === 'group' ? props.target.group : null

  const back = (
    <button type="button" role="menuitem" className="project-menu-back" onClick={() => setPage('root')}>
      <span className="menu-icon">
        <ChevronLeft aria-hidden="true" />
      </span>
      <span>
        <strong>Back</strong>
      </span>
    </button>
  )

  const body = ((): JSX.Element => {
    if (project && page === 'colour') {
      return (
        <>
          {back}
          <ProjectColorPicker
            color={project.color}
            onPick={(color) => {
              props.onColorChange(project.id, color)
              props.onClose()
            }}
          />
        </>
      )
    }

    if (project && page === 'branches') {
      return (
        <>
          {back}
          <BranchPage
            project={project}
            workingSessions={props.workingSessions(project.id)}
            listBranches={props.onListBranches}
            switchBranch={props.onSwitchBranch}
            onSwitched={props.onClose}
          />
        </>
      )
    }

    if (project && page === 'groups') {
      return (
        <>
          {back}
          {props.groups
            .filter((candidate) => candidate.id !== project.groupId)
            .map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  props.onMoveToGroup(project.id, candidate.id)
                  props.onClose()
                }}
              >
                <span className="menu-icon">
                  <FolderPlus aria-hidden="true" />
                </span>
                <span>
                  <strong>{candidate.name}</strong>
                </span>
              </button>
            ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              props.onCreateGroup(project.id)
              props.onClose()
            }}
          >
            <span className="menu-icon">
              <FolderPlus aria-hidden="true" />
            </span>
            <span>
              <strong>New group…</strong>
              <small>Name it in the sidebar</small>
            </span>
          </button>
          {project.groupId && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                props.onMoveToGroup(project.id, undefined)
                props.onClose()
              }}
            >
              <span className="menu-icon">
                <FolderMinus aria-hidden="true" />
              </span>
              <span>
                <strong>Remove from group</strong>
              </span>
            </button>
          )}
        </>
      )
    }

    if (group) {
      return (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              props.onRenameGroup(group.id)
              props.onClose()
            }}
          >
            <span className="menu-icon">
              <PencilLine aria-hidden="true" />
            </span>
            <span>
              <strong>Rename group…</strong>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              props.onDeleteGroup(group.id)
              props.onClose()
            }}
          >
            <span className="menu-icon">
              <Trash2 aria-hidden="true" />
            </span>
            <span>
              <strong>Delete group</strong>
              <small>Its projects return to the top level</small>
            </span>
          </button>
        </>
      )
    }

    /*
     * Starting a project is a many-times-a-day action, so its commands sit flat on the root page
     * rather than behind a submenu page the way colours and groups do: right-click, click, running.
     * A project with nothing runnable shows no section at all - an empty "Run" heading would only
     * be a promise the menu cannot keep - and the rule below closes the section rather than a
     * second heading, so the menu's existing entries read exactly as they did before.
     */
    const commands = project ? runnableCommands(project.runCommands) : []

    return (
      <>
        {project && commands.length > 0 && (
          <>
            <p className="project-menu-section">Run</p>
            {commands.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  props.onRunCommand(project.id, entry.id)
                  props.onClose()
                }}
              >
                <span className="menu-icon">
                  <Play aria-hidden="true" />
                </span>
                <span>
                  <strong>{entry.name}</strong>
                  {/* Trimmed, so the menu shows the line that will actually be typed. */}
                  <small className="project-menu-command">{entry.command.trim()}</small>
                </span>
              </button>
            ))}
            <div className="project-menu-divider" role="separator" />
          </>
        )}
        {project && (
          <button type="button" role="menuitem" onClick={() => setPage('branches')}>
            <span className="menu-icon">
              <GitBranch aria-hidden="true" />
            </span>
            <span>
              <strong>Switch branch…</strong>
              <small>Checks out another local branch</small>
            </span>
          </button>
        )}
        <button type="button" role="menuitem" onClick={() => setPage('colour')}>
          <span className="menu-icon">
            <Palette aria-hidden="true" />
          </span>
          <span>
            <strong>Change colour…</strong>
          </span>
        </button>
        <button type="button" role="menuitem" onClick={() => setPage('groups')}>
          <span className="menu-icon">
            <FolderPlus aria-hidden="true" />
          </span>
          <span>
            <strong>Move to group…</strong>
          </span>
        </button>
      </>
    )
  })()

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu project-row-menu"
      role="menu"
      aria-label={project ? `${project.name} options` : `${group?.name} options`}
      style={{
        position: 'fixed',
        left: position?.left ?? props.x,
        top: position?.top ?? props.y,
        visibility: position ? 'visible' : 'hidden'
      }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <p>{project?.name ?? group?.name}</p>
      {body}
    </div>,
    document.body
  )
}

/**
 * The local branches of the project checkout, read when the page opens rather than kept fresh:
 * a menu is open for seconds, and the list is re-read on every open. A refused checkout stays
 * on the page with git's message, so the user can read why before picking something else.
 */
function BranchPage({
  project,
  workingSessions,
  listBranches,
  switchBranch,
  onSwitched
}: {
  project: WorkspaceProject
  workingSessions: number
  listBranches(projectPath: string): Promise<GitBranchListResult>
  switchBranch(project: WorkspaceProject, branch: string): Promise<GitCheckoutResult>
  onSwitched(): void
}): JSX.Element {
  const [listing, setListing] = useState<GitBranchListResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setListing(null)
    void listBranches(project.path).then(
      (result) => {
        if (active) setListing(result)
      },
      (failure: unknown) => {
        if (active) setListing({ ok: false, branches: [], message: describeFailure(failure) })
      }
    )
    return () => {
      active = false
    }
  }, [listBranches, project.path])

  const pick = async (branch: GitLocalBranch): Promise<void> => {
    setBusy(branch.name)
    setError(null)
    try {
      const result = await switchBranch(project, branch.name)
      if (result.ok) onSwitched()
      else setError(result.message ?? `Could not check out ${branch.name}`)
    } catch (failure) {
      setError(describeFailure(failure))
    } finally {
      setBusy(null)
    }
  }

  if (!listing) return <p className="project-menu-note">Reading branches…</p>
  if (!listing.ok) return <p className="project-menu-note">{listing.message ?? 'Could not read branches'}</p>
  if (listing.branches.length === 0) return <p className="project-menu-note">No local branches</p>

  return (
    <>
      <p className="project-menu-section">Local branches</p>
      {workingSessions > 0 && (
        <p className="project-menu-note" data-tone="warning">
          {describeBranchChoiceBlocker({ name: '', current: false }, { workingSessions })}
        </p>
      )}
      <div className="project-branch-list">
        {listing.branches.map((branch) => {
          const blocker = describeBranchChoiceBlocker(branch, { workingSessions })
          return (
            <button
              key={branch.name}
              type="button"
              role="menuitemradio"
              aria-checked={branch.current}
              disabled={Boolean(blocker) || busy !== null}
              title={blocker ?? `Check out ${branch.name}`}
              data-current={branch.current ? 'true' : undefined}
              onClick={() => void pick(branch)}
            >
              <span className="menu-icon project-branch-mark">{branch.current && <Check aria-hidden="true" />}</span>
              <span>
                <strong className="project-branch-label">
                  {busy === branch.name ? `Checking out ${branch.name}…` : branch.name}
                </strong>
                {branch.worktreePath && !branch.current && <small className="project-menu-command">{blocker}</small>}
              </span>
            </button>
          )
        })}
      </div>
      {error && (
        <p className="project-menu-note" data-tone="error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

function describeFailure(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}
