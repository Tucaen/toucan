import { useCallback, useEffect, useState } from 'react'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import { ChevronDown, ChevronRight, GitBranch } from 'lucide-react'
import type { TerminalKind } from '../../shared/terminal'
import type { WorktreeStatus } from '../../shared/worktree'
import {
  DEFAULT_WORKTREE_SIZE,
  MIN_WORKTREE_SIZE,
  WORKTREE_CHROME_HEIGHT,
  type WorktreeCanvasNode
} from './canvas-workspace'
import NodeBorderResizer from './NodeBorderResizer'
import NodeFitAction from './NodeFitAction'
import SessionKindIcon from './SessionKindIcon'
import WorktreeCanvas from './WorktreeCanvas'

/** Git state moves only when something else on the canvas moves it, so this can be lazy. */
const STATUS_POLL_MS = 10_000

function describeStatus(status: WorktreeStatus | null): {
  text: string
  kind: 'clean' | 'dirty' | 'ahead' | 'missing' | 'unknown'
} {
  if (!status) return { text: 'Checking…', kind: 'unknown' }
  if (status.message) return { text: status.message, kind: 'unknown' }
  if (!status.exists) return { text: 'Directory is missing', kind: 'missing' }

  const parts: string[] = []
  if (status.changedFiles > 0) parts.push(`${status.changedFiles} changed`)
  if (status.untrackedFiles > 0) parts.push(`${status.untrackedFiles} untracked`)
  if (status.stashEntries > 0) parts.push(`${status.stashEntries} stashed`)
  if (status.ahead > 0) parts.push(`${status.ahead} ${status.hasUpstream ? 'unpushed' : 'unmerged'}`)
  if (status.behind > 0) parts.push(`${status.behind} behind`)

  if (parts.length === 0) return { text: 'Clean · nothing unique here', kind: 'clean' }
  const dirty = status.changedFiles > 0 || status.untrackedFiles > 0
  return { text: parts.join(' · '), kind: dirty ? 'dirty' : 'ahead' }
}

/**
 * A worktree is the home of the chats that run in it: a header, the worktree's own canvas of
 * those chats, and one compact row beneath. The header carries the checkout - branch, project, git
 * state and the checkout-level actions - and doubles as the drag handle that moves the worktree and
 * everything in it together; the canvas and the row belong to `WorktreeCanvas`.
 *
 * Collapsed, the worktree is its header and row. The canvas is still rendered, at the size it
 * expands back to, hidden by the stylesheet rather than unmounted: every chat on it keeps its
 * session, draft and scroll, and comes back exactly as it was.
 */
export default function WorktreeNode({ id, data, selected }: NodeProps<WorktreeCanvasNode>): JSX.Element {
  const [status, setStatus] = useState<WorktreeStatus | null>(null)
  const { path, branch, baseRef, worktreeId, onCreateNodeInWorktree } = data

  const refresh = useCallback(
    async (): Promise<WorktreeStatus | null> => window.worktreeApi.status({ path, branch, baseRef }).catch(() => null),
    [baseRef, branch, path]
  )

  useEffect(() => {
    let active = true
    const read = (): void => {
      void refresh().then((next) => {
        if (active && next) setStatus(next)
      })
    }
    read()
    const interval = setInterval(read, STATUS_POLL_MS)
    return () => {
      active = false
      clearInterval(interval)
    }
    // Attaching or detaching a node is the most likely moment for the tree to have changed.
  }, [data.attachedNodeCount, refresh])

  const addChat = useCallback(
    (kind: TerminalKind): void => onCreateNodeInWorktree(worktreeId, kind),
    [onCreateNodeInWorktree, worktreeId]
  )

  const collapsed = data.collapsed === true
  const expandedHeight = data.expandedHeight ?? DEFAULT_WORKTREE_SIZE.height

  const summary = data.unavailable
    ? { text: 'Worktree no longer exists', kind: 'missing' as const }
    : describeStatus(status)
  // The way out of a missing worktree, said where it shows even while its chats are still open.
  const summaryTitle = data.unavailable
    ? 'Worktree no longer exists. Close its attached sessions to remove this record.'
    : summary.text

  return (
    <article
      className={`worktree-node ${selected ? 'selected' : ''} ${collapsed ? 'collapsed' : ''}`}
      style={
        {
          '--project-color': data.projectColor,
          '--worktree-canvas-height': `${expandedHeight - WORKTREE_CHROME_HEIGHT}px`
        } as React.CSSProperties
      }
    >
      {/* A collapsed worktree is its chrome; there is no size to drag. */}
      {!collapsed && (
        <NodeBorderResizer
          minWidth={MIN_WORKTREE_SIZE.width}
          minHeight={MIN_WORKTREE_SIZE.height}
          selected={selected}
          color={data.projectColor}
        />
      )}
      <header className="node-header worktree-node-header">
        <button
          type="button"
          className="worktree-header-action worktree-collapse nodrag"
          aria-label={collapsed ? 'Expand worktree' : 'Collapse worktree'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand this worktree' : 'Collapse this worktree to its header; its chats keep running'}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => data.onToggleCollapsed(worktreeId)}
        >
          {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </button>
        <span className="worktree-glyph" aria-hidden="true">
          <GitBranch />
        </span>
        {/* Directory and base stay one hover away rather than taking a row of the canvas. */}
        <strong title={`${branch}\n${path}\nBranched from ${baseRef}`}>{branch}</strong>
        <span className="node-project" title={data.projectPath}>
          <span className="project-color-dot" />
          {data.projectName}
        </span>
        <span className="worktree-status" data-kind={summary.kind} title={summaryTitle}>
          <span className="worktree-status-dot" />
          <span className="worktree-status-text">{summary.text}</span>
        </span>
        <span className="worktree-header-actions nodrag">
          <button
            type="button"
            className="worktree-header-action worktree-terminal"
            title="New terminal in this worktree"
            aria-label="New terminal in this worktree"
            disabled={data.unavailable}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => onCreateNodeInWorktree(worktreeId, 'terminal')}
          >
            <SessionKindIcon kind="terminal" />
          </button>
          <button
            type="button"
            className="worktree-header-action worktree-setup"
            disabled={data.unavailable || !data.setupCommand}
            title={
              data.setupCommand
                ? `Run in a new terminal: ${data.setupCommand}`
                : 'No setup command configured for this project'
            }
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => data.onRunSetupCommand(worktreeId)}
          >
            Setup
          </button>
          <button
            type="button"
            className="worktree-header-action worktree-diff"
            title={`Review this worktree's changes against ${baseRef}`}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => data.onOpenDiff(worktreeId)}
          >
            Diff
          </button>
          <button
            type="button"
            className="worktree-header-action worktree-remove"
            title={
              data.attachedNodeCount > 0
                ? 'Close or detach its nodes before removing this worktree'
                : 'Check this worktree for unique work and remove it'
            }
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => data.onRemoveWorktree(worktreeId)}
          >
            Remove
          </button>
        </span>
        {/* Focus is room for the chats; a collapsed worktree is expanded first. */}
        {!collapsed && <NodeFitAction nodeId={id} fitted={data.fittedToCanvas ?? false} />}
      </header>

      <ReactFlowProvider>
        <WorktreeCanvas
          worktreeId={worktreeId}
          viewport={data.viewport}
          unavailable={data.unavailable ?? false}
          attachedNodeCount={data.attachedNodeCount}
          onAddChat={addChat}
          onViewportChange={data.onViewportChange}
        />
      </ReactFlowProvider>
    </article>
  )
}
