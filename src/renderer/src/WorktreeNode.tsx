import { useCallback, useEffect, useState } from 'react'
import type { NodeProps } from '@xyflow/react'
import { GitBranch } from 'lucide-react'
import type { WorktreeStatus } from '../../shared/worktree'
import type { WorktreeCanvasNode } from './canvas-workspace'
import NodeBorderResizer from './NodeBorderResizer'
import NodeFitAction from './NodeFitAction'
import SessionKindIcon from './SessionKindIcon'

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

export default function WorktreeNode({ id, data, selected }: NodeProps<WorktreeCanvasNode>): JSX.Element {
  const [status, setStatus] = useState<WorktreeStatus | null>(null)
  const { path, branch, baseRef } = data

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

  const summary = data.unavailable
    ? { text: 'Worktree no longer exists. Close its attached sessions to remove this record.', kind: 'missing' }
    : describeStatus(status)

  return (
    <article
      className={`worktree-node ${selected ? 'selected' : ''}`}
      style={{ '--project-color': data.projectColor } as React.CSSProperties}
    >
      <NodeBorderResizer minWidth={320} minHeight={200} selected={selected} color={data.projectColor} />
      <header className="node-header worktree-node-header">
        <span className="worktree-glyph" aria-hidden="true">
          <GitBranch />
        </span>
        <strong title={branch}>{branch}</strong>
        <span className="node-project" title={data.projectPath}>
          <span className="project-color-dot" />
          {data.projectName}
        </span>
        <span className="node-status">{data.attachedNodeCount} attached</span>
        <button
          type="button"
          className="worktree-diff nodrag"
          title={`Review this worktree's changes against ${baseRef}`}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => data.onOpenDiff(data.worktreeId)}
        >
          Diff
        </button>
        <NodeFitAction nodeId={id} fitted={data.fittedToCanvas ?? false} />
      </header>

      <div className="worktree-body nodrag">
        <dl className="worktree-facts">
          <div>
            <dt className="eyebrow-label">Directory</dt>
            <dd title={path}>{path}</dd>
          </div>
          <div>
            <dt className="eyebrow-label">Branched from</dt>
            <dd>{baseRef}</dd>
          </div>
        </dl>
        <p className="worktree-status" data-kind={summary.kind}>
          <span className="worktree-status-dot" />
          {summary.text}
        </p>
      </div>

      <footer className="worktree-actions nodrag">
        <div className="worktree-open-group">
          <span className="eyebrow-label">Open here</span>
          <button
            type="button"
            title="New terminal in this worktree"
            disabled={data.unavailable}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => data.onCreateNodeInWorktree(data.worktreeId, 'terminal')}
          >
            <SessionKindIcon kind="terminal" />
          </button>
          <button
            type="button"
            title="New Claude session in this worktree"
            disabled={data.unavailable}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => data.onCreateNodeInWorktree(data.worktreeId, 'claude')}
          >
            <SessionKindIcon kind="claude" />
          </button>
          <button
            type="button"
            title="New Codex session in this worktree"
            disabled={data.unavailable}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => data.onCreateNodeInWorktree(data.worktreeId, 'codex')}
          >
            <SessionKindIcon kind="codex" />
          </button>
        </div>
        <button
          type="button"
          className="worktree-setup"
          disabled={data.unavailable || !data.setupCommand}
          title={
            data.setupCommand
              ? `Run in a new terminal: ${data.setupCommand}`
              : 'No setup command configured for this project'
          }
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => data.onRunSetupCommand(data.worktreeId)}
        >
          Setup
        </button>
        <button
          type="button"
          className="worktree-remove"
          title={
            data.attachedNodeCount > 0
              ? 'Close or detach its nodes before removing this worktree'
              : 'Check this worktree for unique work and remove it'
          }
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => data.onRemoveWorktree(data.worktreeId)}
        >
          Remove
        </button>
      </footer>
    </article>
  )
}
