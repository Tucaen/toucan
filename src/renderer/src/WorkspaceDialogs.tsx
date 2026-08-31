import { useState } from 'react'
import type { WorkspaceProject } from '../../shared/terminal'
import type { WorktreeRemovalBlocker } from '../../shared/worktree'
import { branchNameProblem, describeWorktreeBlocker, deriveWorktreeDirectory } from '../../shared/worktree'
import { describeForcedRemovalCost, type WorktreeRemovalPlan } from './worktree-removal'

export interface WorktreeDraft {
  projectId: string
  branch: string
  baseRef: string
  position: { x: number; y: number }
  busy: boolean
  error: string | null
}

export interface WorktreeRemovalPrompt {
  worktreeId: string
  branch: string
  path: string
  plan: WorktreeRemovalPlan
  busy: boolean
  error: string | null
}

export function WorktreeCreateDialog({
  draft,
  project,
  onChange,
  onCancel,
  onConfirm
}: {
  draft: WorktreeDraft
  project: WorkspaceProject
  onChange(patch: Partial<WorktreeDraft>): void
  onCancel(): void
  onConfirm(): void
}): JSX.Element {
  const problem = draft.branch ? branchNameProblem(draft.branch) : null
  const directory = problem ? null : deriveWorktreeDirectory(project.path, draft.branch)

  return (
    <div
      className="worktree-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="worktree-create-title"
      onClick={(event) => event.stopPropagation()}
    >
      <form
        className="worktree-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (!problem && !draft.busy) onConfirm()
        }}
      >
        <strong id="worktree-create-title">New worktree in {project.name}</strong>
        <label>
          <span>Branch name</span>
          <input
            autoFocus
            value={draft.branch}
            placeholder="feature/login"
            disabled={draft.busy}
            onChange={(event) => onChange({ branch: event.target.value, error: null })}
          />
        </label>
        <label>
          <span>Branch from</span>
          <input
            value={draft.baseRef}
            placeholder="current HEAD"
            disabled={draft.busy}
            onChange={(event) => onChange({ baseRef: event.target.value, error: null })}
          />
        </label>
        {directory && (
          <p className="worktree-dialog-path" title={directory}>
            Directory: {directory}
          </p>
        )}
        {problem && draft.branch.length > 0 && <p className="worktree-dialog-error">{problem}</p>}
        {draft.error && <p className="worktree-dialog-error">{draft.error}</p>}
        <div className="worktree-dialog-actions">
          <button type="button" disabled={draft.busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={draft.busy || Boolean(problem) || !draft.branch}>
            {draft.busy ? 'Creating…' : 'Create worktree'}
          </button>
        </div>
      </form>
    </div>
  )
}

export function WorktreeRemoveDialog({
  prompt,
  onCancel,
  onConfirm
}: {
  prompt: WorktreeRemovalPrompt
  onCancel(): void
  onConfirm(force: boolean): void
}): JSX.Element {
  const { plan } = prompt
  return (
    <div
      className="worktree-dialog-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="worktree-remove-title"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="worktree-dialog">
        <strong id="worktree-remove-title">Remove worktree {prompt.branch}?</strong>
        <p className="worktree-dialog-path" title={prompt.path}>
          {prompt.path}
        </p>
        {plan.decision === 'ready' && (
          <p>Nothing unique lives here: the tree is clean, and its commits are already merged or pushed.</p>
        )}
        {plan.hard.length > 0 && (
          <>
            <p>This worktree cannot be removed yet:</p>
            <ul className="worktree-blockers" data-kind="hard">
              {plan.hard.map((blocker: WorktreeRemovalBlocker, index) => (
                <li key={`${blocker.kind}-${index}`}>{describeWorktreeBlocker(blocker)}</li>
              ))}
            </ul>
          </>
        )}
        {plan.hard.length === 0 && plan.forcible.length > 0 && (
          <>
            <p>This worktree still holds work that exists nowhere else:</p>
            <ul className="worktree-blockers" data-kind="forcible">
              {plan.forcible.map((blocker: WorktreeRemovalBlocker, index) => (
                <li key={`${blocker.kind}-${index}`}>{describeWorktreeBlocker(blocker)}</li>
              ))}
            </ul>
            <p className="worktree-dialog-cost">{describeForcedRemovalCost(plan.forcible)}</p>
          </>
        )}
        {prompt.error && <p className="worktree-dialog-error">{prompt.error}</p>}
        <div className="worktree-dialog-actions">
          <button type="button" disabled={prompt.busy} onClick={onCancel}>
            {plan.decision === 'blocked' ? 'Close' : 'Cancel'}
          </button>
          {plan.decision === 'ready' && (
            <button type="button" className="primary" disabled={prompt.busy} onClick={() => onConfirm(false)}>
              {prompt.busy ? 'Removing…' : 'Remove worktree'}
            </button>
          )}
          {plan.decision === 'confirm' && (
            <button type="button" className="danger" disabled={prompt.busy} onClick={() => onConfirm(true)}>
              {prompt.busy ? 'Removing…' : 'Remove and discard'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export function SetupCommandDialog({
  project,
  onCancel,
  onSave
}: {
  project: WorkspaceProject
  onCancel(): void
  onSave(command: string): void
}): JSX.Element {
  const [value, setValue] = useState(project.setupCommand ?? '')
  return (
    <div
      className="worktree-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="setup-command-title"
      onClick={(event) => event.stopPropagation()}
    >
      <form
        className="worktree-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          onSave(value.trim())
        }}
      >
        <strong id="setup-command-title">Setup command for {project.name}</strong>
        <p>Run in a terminal node inside a new worktree to make it usable. Leave empty for none.</p>
        <label>
          <span>Command</span>
          <input autoFocus value={value} placeholder="npm install" onChange={(event) => setValue(event.target.value)} />
        </label>
        <div className="worktree-dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Save
          </button>
        </div>
      </form>
    </div>
  )
}
