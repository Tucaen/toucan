import { useState } from 'react'
import { ProjectAvatar } from './ProjectAvatar'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import type { WorkspaceProject } from '../../shared/terminal'
import {
  moveRunCommand,
  normalizeRunCommands,
  runCommandsIncomplete,
  type ProjectRunCommand
} from '../../shared/project-run-commands'
import type { WorktreeRemovalBlocker } from '../../shared/worktree'
import { branchNameProblem, describeWorktreeBlocker, deriveWorktreeDirectory } from '../../shared/worktree'
import { DEFAULT_TICKETS_DIRECTORY, isTicketsDirectory } from '../../shared/tickets'
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
      className="dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="worktree-create-title"
      onClick={(event) => event.stopPropagation()}
    >
      <form
        className="dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (!problem && !draft.busy) onConfirm()
        }}
      >
        <strong id="worktree-create-title">New worktree in {project.name}</strong>
        <label>
          <span className="eyebrow-label">Branch name</span>
          <input
            autoFocus
            value={draft.branch}
            placeholder="feature/login"
            disabled={draft.busy}
            onChange={(event) => onChange({ branch: event.target.value, error: null })}
          />
        </label>
        <label>
          <span className="eyebrow-label">Branch from</span>
          <input
            value={draft.baseRef}
            placeholder="current HEAD"
            disabled={draft.busy}
            onChange={(event) => onChange({ baseRef: event.target.value, error: null })}
          />
        </label>
        {directory && (
          <p className="dialog-path" title={directory}>
            Directory: {directory}
          </p>
        )}
        {problem && draft.branch.length > 0 && <p className="dialog-error">{problem}</p>}
        {draft.error && <p className="dialog-error">{draft.error}</p>}
        <div className="dialog-actions">
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
      className="dialog-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="worktree-remove-title"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="dialog">
        <strong id="worktree-remove-title">Remove worktree {prompt.branch}?</strong>
        <p className="dialog-path" title={prompt.path}>
          {prompt.path}
        </p>
        {plan.decision === 'ready' && !prompt.busy && (
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
            <p className="dialog-cost">{describeForcedRemovalCost(plan.forcible)}</p>
          </>
        )}
        {prompt.error && <p className="dialog-error">{prompt.error}</p>}
        <div className="dialog-actions">
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

/**
 * Everything `ProjectSettingsDialog` hands back on Save. One type rather than three parameters,
 * so adding a fourth setting is one edit here instead of a matching structural literal in the
 * dialog and again in `App`'s `saveProjectSettings`.
 */
export interface ProjectSettingsDraft {
  setupCommand: string
  ticketsDirectory: string
  runCommands: ProjectRunCommand[]
}

/**
 * The gear's tooltip, and so also its accessible name - the only handle a test has on the button.
 * It lives here rather than inline in `App` because it names what this dialog edits, and a
 * settings list that grows must not cost a wording edit in every test that opens the dialog.
 */
export function projectSettingsTitle(project: { name: string }): string {
  return `Settings for ${project.name}: avatar image, setup command, tickets folder and run commands`
}

/**
 * A project's per-project settings, behind the gear on its sidebar row. Three settings today, all
 * of them answers about *this checkout*: what makes a fresh worktree usable, where the project
 * keeps its ticket files, and the named commands that start it.
 *
 * The tickets folder is validated here against the same rule main enforces
 * (`isTicketsDirectory`), so a path that leaves the checkout is refused while the user is typing
 * it rather than silently ignored later - the one thing worse than a rejected folder is a saved
 * one the board never reads from. The run-command list is the same bargain in the other
 * direction: the rules are `shared/project-run-commands.ts`, and a row that is only half typed
 * blocks Save rather than being dropped on the way to disk.
 */
export function ProjectSettingsDialog({
  project,
  avatarUrl,
  avatarError,
  onChooseAvatar,
  onRemoveAvatar,
  onCancel,
  onSave
}: {
  project: WorkspaceProject
  /** The stored custom avatar as a data URL; null shows the letter chip the sidebar falls back to. */
  avatarUrl: string | null
  avatarError: string | null
  /** Applies immediately (the pick is normalized and written by main); Save/Cancel govern only the text settings. */
  onChooseAvatar(): void
  onRemoveAvatar(): void
  onCancel(): void
  onSave(settings: ProjectSettingsDraft): void
}): JSX.Element {
  const [command, setCommand] = useState(project.setupCommand ?? '')
  const [tickets, setTickets] = useState(project.ticketsDirectory ?? '')
  const [runCommands, setRunCommands] = useState<readonly ProjectRunCommand[]>(project.runCommands ?? [])
  const ticketsFolder = tickets.trim()
  const ticketsError = ticketsFolder && !isTicketsDirectory(ticketsFolder)
  const runCommandsError = runCommandsIncomplete(runCommands)
  const patchRunCommand = (id: string, patch: Partial<ProjectRunCommand>): void =>
    setRunCommands((current) => current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)))
  return (
    <div
      className="dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-settings-title"
      onClick={(event) => event.stopPropagation()}
    >
      <form
        className="dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (ticketsError || runCommandsError) return
          onSave({
            setupCommand: command.trim(),
            ticketsDirectory: ticketsFolder,
            runCommands: normalizeRunCommands(runCommands)
          })
        }}
      >
        <strong id="project-settings-title">Settings for {project.name}</strong>
        <div className="project-avatar-settings">
          <ProjectAvatar
            project={project}
            avatarUrl={avatarUrl}
            className="project-avatar-preview"
            imageAlt={`Avatar of ${project.name}`}
          />
          <button type="button" onClick={onChooseAvatar}>
            Choose image…
          </button>
          {avatarUrl && (
            <button type="button" onClick={onRemoveAvatar}>
              Remove image
            </button>
          )}
        </div>
        <p>
          Shown instead of the letter in the sidebar. The image is copied, center-cropped square and stored by Toucan;
          changes apply immediately.
        </p>
        {avatarError && <p className="dialog-error">{avatarError}</p>}
        <label>
          <span className="eyebrow-label">Setup command</span>
          <input
            autoFocus
            value={command}
            placeholder="npm install"
            onChange={(event) => setCommand(event.target.value)}
          />
        </label>
        <p>Run in a terminal node inside a new worktree to make it usable. Leave empty for none.</p>
        <label>
          <span className="eyebrow-label">Tickets folder</span>
          <input
            value={tickets}
            placeholder={DEFAULT_TICKETS_DIRECTORY}
            aria-invalid={ticketsError || undefined}
            onChange={(event) => setTickets(event.target.value)}
          />
        </label>
        <p>
          Where this project's ticket Markdown files live, relative to the checkout. Leave empty for{' '}
          {DEFAULT_TICKETS_DIRECTORY}.
        </p>
        {ticketsError && <p className="dialog-error">The tickets folder must stay inside the checkout.</p>}
        <div className="project-run-commands">
          <span className="eyebrow-label">Run commands</span>
          {runCommands.map((entry, index) => (
            <div className="project-run-command" key={entry.id}>
              <input
                aria-label={`Command ${index + 1} name`}
                value={entry.name}
                placeholder="Web"
                onChange={(event) => patchRunCommand(entry.id, { name: event.target.value })}
              />
              <input
                aria-label={`Command ${index + 1} command line`}
                value={entry.command}
                placeholder="npm run dev"
                onChange={(event) => patchRunCommand(entry.id, { command: event.target.value })}
              />
              <button
                type="button"
                aria-label={`Move command ${index + 1} up`}
                disabled={index === 0}
                onClick={() => setRunCommands((current) => moveRunCommand(current, index, -1))}
              >
                <ArrowUp aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={`Move command ${index + 1} down`}
                disabled={index === runCommands.length - 1}
                onClick={() => setRunCommands((current) => moveRunCommand(current, index, 1))}
              >
                <ArrowDown aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={`Remove command ${index + 1}`}
                onClick={() => setRunCommands((current) => current.filter((item) => item.id !== entry.id))}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="project-run-command-add"
            onClick={() =>
              setRunCommands((current) => [...current, { id: crypto.randomUUID(), name: '', command: '' }])
            }
          >
            Add command
          </button>
        </div>
        <p>
          Named commands that start this project, run in its checkout. Order is the order they are listed in; leave the
          list empty for none.
        </p>
        {runCommandsError && <p className="dialog-error">Every run command needs a name and a command line.</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={Boolean(ticketsError) || runCommandsError}>
            Save
          </button>
        </div>
      </form>
    </div>
  )
}
