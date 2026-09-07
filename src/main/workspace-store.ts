import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { AGENT_TURN_OUTCOME_LIMIT } from '../shared/agent'
import { isAttentionItem } from '../shared/attention'
import { isFileViewMode, type WorkspaceFileNode } from '../shared/file-view'
import type { WorkspaceDiffNode } from '../shared/git-diff'
import { isProjectColor, paletteColorAt } from '../shared/project-colors'
import {
  isComposerSendKey,
  RECENTLY_CLOSED_SESSION_LIMIT,
  type ProjectGroup,
  type WorkspaceLoadResult,
  type WorkspaceProject,
  type WorkspaceSaveResult,
  type WorkspaceState
} from '../shared/terminal'
import { errorMessage, repairUtf8Mojibake } from '../shared/text'

interface WorkspaceStateV1 {
  version: 1
  projects: WorkspaceState['projects']
  activeProjectId: string | null
  sidebarCollapsed: boolean
}

interface WorkspaceStateV2 {
  version: 2
  projects: WorkspaceState['projects']
  activeProjectId: string | null
  sidebarCollapsed: boolean
  agentPermissionModes?: WorkspaceState['agentPermissionModes']
  nodes: WorkspaceState['nodes']
}

function isWorkspaceWorktree(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const worktree = value as Partial<WorkspaceState['worktrees'][number]>
  return (
    typeof worktree.id === 'string' &&
    typeof worktree.projectId === 'string' &&
    typeof worktree.branch === 'string' &&
    typeof worktree.path === 'string' &&
    typeof worktree.baseRef === 'string' &&
    typeof worktree.createdAt === 'string' &&
    typeof worktree.position?.x === 'number' &&
    typeof worktree.position?.y === 'number' &&
    typeof worktree.width === 'number' &&
    typeof worktree.height === 'number'
  )
}

function isWorkspaceFileNode(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const file = value as Partial<WorkspaceFileNode>
  return (
    typeof file.id === 'string' &&
    typeof file.projectId === 'string' &&
    typeof file.path === 'string' &&
    isFileViewMode(file.view) &&
    typeof file.position?.x === 'number' &&
    typeof file.position?.y === 'number' &&
    typeof file.width === 'number' &&
    typeof file.height === 'number'
  )
}

function isWorkspaceDiffNode(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const diff = value as Partial<WorkspaceDiffNode>
  return (
    typeof diff.id === 'string' &&
    typeof diff.projectId === 'string' &&
    (diff.worktreeId === undefined || typeof diff.worktreeId === 'string') &&
    (diff.selectedPath === undefined || typeof diff.selectedPath === 'string') &&
    typeof diff.position?.x === 'number' &&
    typeof diff.position?.y === 'number' &&
    typeof diff.width === 'number' &&
    typeof diff.height === 'number'
  )
}

function hasValidProjects(
  value: unknown
): value is Pick<WorkspaceState, 'projects' | 'activeProjectId' | 'sidebarCollapsed'> {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<WorkspaceState>
  if (!Array.isArray(state.projects)) return false
  if (state.activeProjectId !== null && typeof state.activeProjectId !== 'string') return false
  if (typeof state.sidebarCollapsed !== 'boolean') return false

  return state.projects.every(
    (project) =>
      project &&
      typeof project.id === 'string' &&
      typeof project.name === 'string' &&
      typeof project.path === 'string' &&
      isProjectColor(project.color) &&
      (project.setupCommand === undefined || typeof project.setupCommand === 'string') &&
      (project.groupId === undefined || typeof project.groupId === 'string') &&
      (project.ticketsDirectory === undefined || typeof project.ticketsDirectory === 'string') &&
      (project.githubInProgressLabel === undefined || typeof project.githubInProgressLabel === 'string')
  )
}

function isProjectGroup(value: unknown): value is ProjectGroup {
  if (!value || typeof value !== 'object') return false
  const group = value as Partial<ProjectGroup>
  return typeof group.id === 'string' && typeof group.name === 'string' && typeof group.collapsed === 'boolean'
}

function isAgentTurnOutcome(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const outcome = value as { id?: unknown; status?: unknown; message?: unknown }
  return (
    typeof outcome.id === 'string' &&
    (outcome.status === 'failed' || outcome.status === 'cancelled') &&
    typeof outcome.message === 'string'
  )
}

function isWorkspaceTerminalNode(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const node = value as Partial<WorkspaceState['nodes'][number]>
  return (
    typeof node.id === 'string' &&
    (node.sessionId === undefined || typeof node.sessionId === 'string') &&
    node.kind !== undefined &&
    ['terminal', 'claude', 'codex'].includes(node.kind) &&
    typeof node.label === 'string' &&
    (node.titleSource === undefined || node.titleSource === 'generated' || node.titleSource === 'manual') &&
    typeof node.projectId === 'string' &&
    (node.worktreeId === undefined || typeof node.worktreeId === 'string') &&
    typeof node.position?.x === 'number' &&
    typeof node.position?.y === 'number' &&
    typeof node.width === 'number' &&
    typeof node.height === 'number' &&
    (node.conversationId === undefined || typeof node.conversationId === 'string') &&
    (node.focusMode === undefined || typeof node.focusMode === 'boolean') &&
    (node.worklogCollapsed === undefined || typeof node.worklogCollapsed === 'boolean') &&
    (node.modelId === undefined || typeof node.modelId === 'string') &&
    (node.turnOutcomes === undefined ||
      (Array.isArray(node.turnOutcomes) && node.turnOutcomes.every(isAgentTurnOutcome))) &&
    (node.draft === undefined || typeof node.draft === 'string') &&
    (node.terminalLiveness === undefined || ['live', 'unverifiable', 'exited'].includes(node.terminalLiveness)) &&
    (node.preview === undefined ||
      (typeof node.preview.updatedAt === 'string' &&
        (node.preview.user === undefined || typeof node.preview.user === 'string') &&
        (node.preview.assistant === undefined || typeof node.preview.assistant === 'string')))
  )
}

function isBrainDumpPanelState(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const panel = value as Partial<NonNullable<WorkspaceState['brainDumpPanel']>>
  return (
    typeof panel.open === 'boolean' &&
    typeof panel.width === 'number' &&
    Number.isFinite(panel.width) &&
    (panel.draft === undefined || typeof panel.draft === 'string') &&
    (panel.draftProjectPath === undefined || typeof panel.draftProjectPath === 'string') &&
    (panel.provider === undefined || panel.provider === 'claude' || panel.provider === 'codex')
  )
}

function isTicketBoardPanelState(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const panel = value as Partial<NonNullable<WorkspaceState['ticketBoardPanel']>>
  return (
    typeof panel.open === 'boolean' &&
    typeof panel.width === 'number' &&
    Number.isFinite(panel.width) &&
    (panel.detailWidth === undefined ||
      (typeof panel.detailWidth === 'number' && Number.isFinite(panel.detailWidth))) &&
    (panel.enabledSources === undefined ||
      (typeof panel.enabledSources === 'object' &&
        panel.enabledSources !== null &&
        Object.values(panel.enabledSources).every(
          (ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string')
        )))
  )
}

export function isWorkspaceState(value: unknown): value is WorkspaceState {
  if (!hasValidProjects(value)) return false
  const state = value as Partial<WorkspaceState>
  if (state.version !== 3 || !Array.isArray(state.nodes)) return false
  if (!Array.isArray(state.worktrees) || !state.worktrees.every(isWorkspaceWorktree)) return false
  if (state.files !== undefined && (!Array.isArray(state.files) || !state.files.every(isWorkspaceFileNode)))
    return false
  if (state.diffs !== undefined && (!Array.isArray(state.diffs) || !state.diffs.every(isWorkspaceDiffNode)))
    return false
  if (
    state.projectGroups !== undefined &&
    (!Array.isArray(state.projectGroups) || !state.projectGroups.every(isProjectGroup))
  )
    return false
  if (
    state.agentPermissionModes !== undefined &&
    (!state.agentPermissionModes ||
      typeof state.agentPermissionModes !== 'object' ||
      (state.agentPermissionModes.claude !== undefined && typeof state.agentPermissionModes.claude !== 'string') ||
      (state.agentPermissionModes.codex !== undefined && typeof state.agentPermissionModes.codex !== 'string'))
  )
    return false
  if (state.composerSendKey !== undefined && !isComposerSendKey(state.composerSendKey)) return false
  if (state.brainDumpPanel !== undefined && !isBrainDumpPanelState(state.brainDumpPanel)) return false
  if (state.ticketBoardPanel !== undefined && !isTicketBoardPanelState(state.ticketBoardPanel)) return false
  if (state.attention !== undefined && (!Array.isArray(state.attention) || !state.attention.every(isAttentionItem)))
    return false
  if (!state.nodes.every(isWorkspaceTerminalNode)) return false
  return (
    state.recentlyClosedNodes === undefined ||
    (Array.isArray(state.recentlyClosedNodes) && state.recentlyClosedNodes.every(isWorkspaceTerminalNode))
  )
}

/**
 * The project half of a snapshot, made loadable before it is validated. A colour is user-editable
 * now, so a snapshot carrying one Toucan would not have written (hand-edited, or from a future
 * build) must still open with a palette colour substituted rather than being refused - and a
 * `groupId` that names no group, or a group id listed twice, must not survive into the sidebar,
 * where either would render a project into a folder that does not exist.
 */
function normalizeProjectsAndGroups(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const state = value as { projects?: unknown; projectGroups?: unknown }
  if (!Array.isArray(state.projects)) return value

  // A malformed group is left exactly as it is so validation refuses the snapshot; only a
  // well-formed list is deduped, because two groups sharing an id would render one twice.
  const seen = new Set<string>()
  const declared = state.projectGroups
  const groups =
    Array.isArray(declared) && declared.every(isProjectGroup)
      ? (declared as ProjectGroup[]).filter((group) => {
          if (seen.has(group.id)) return false
          seen.add(group.id)
          return true
        })
      : undefined

  const projects = (state.projects as unknown[]).map((entry, index) => {
    if (!entry || typeof entry !== 'object') return entry
    const project = entry as WorkspaceProject
    const color = isProjectColor(project.color) ? project.color : paletteColorAt(index)
    const grouped = typeof project.groupId === 'string' && seen.has(project.groupId)
    const { groupId, ...rest } = project
    return { ...rest, color, ...(grouped ? { groupId } : {}) }
  })

  return { ...state, projects, ...(groups ? { projectGroups: groups } : {}) }
}

export function parseWorkspaceState(candidate: unknown): WorkspaceState | null {
  const value = normalizeProjectsAndGroups(candidate)
  if (!hasValidProjects(value)) return null
  const version = (value as Partial<WorkspaceState>).version

  if (version === 3) {
    if (!isWorkspaceState(value as WorkspaceState)) return null
    const state = value as WorkspaceState
    // Attention records name canvas nodes, so a record whose node is gone can never be reached
    // or cleared; dropping it here keeps every count derived from records that still exist.
    const liveNodeIds = new Set(state.nodes.map((node) => node.id))
    return {
      ...state,
      ...(state.attention ? { attention: state.attention.filter((item) => liveNodeIds.has(item.nodeId)) } : {}),
      ...(state.recentlyClosedNodes
        ? { recentlyClosedNodes: state.recentlyClosedNodes.slice(-RECENTLY_CLOSED_SESSION_LIMIT) }
        : {}),
      nodes: state.nodes.map((node) => {
        const { worklogCollapsed, ...current } = node
        return {
          ...current,
          ...(node.kind === 'terminal' ? {} : { focusMode: node.focusMode ?? worklogCollapsed ?? false }),
          ...(node.turnOutcomes ? { turnOutcomes: node.turnOutcomes.slice(-AGENT_TURN_OUTCOME_LIMIT) } : {}),
          ...(node.preview
            ? {
                preview: {
                  ...node.preview,
                  ...(node.preview.user ? { user: repairUtf8Mojibake(node.preview.user) } : {}),
                  ...(node.preview.assistant ? { assistant: repairUtf8Mojibake(node.preview.assistant) } : {})
                }
              }
            : {})
        }
      })
    }
  }

  // Every pre-worktree workspace ran entirely in its projects' checkouts, so it migrates
  // to an empty worktree set with all of its nodes still attached to nothing.
  if (version === 2) {
    const previous = value as WorkspaceStateV2
    if (!Array.isArray(previous.nodes)) return null
    return parseWorkspaceState({ ...previous, version: 3, worktrees: [] })
  }
  if (version !== 1) return null
  const previous = value as WorkspaceStateV1
  return {
    version: 3,
    projects: previous.projects,
    activeProjectId: previous.activeProjectId,
    sidebarCollapsed: previous.sidebarCollapsed,
    nodes: [],
    worktrees: []
  }
}

export interface WorkspaceStore {
  load(): Promise<WorkspaceLoadResult>
  save(state: WorkspaceState): Promise<WorkspaceSaveResult>
}

function readValidatedSnapshot(path: string): WorkspaceState | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parseWorkspaceState(parsed)
  } catch {
    return null
  }
}

/** Writes `contents` fully and durably to `tempPath`, unlinking it again on any failure. */
export async function writeFileDurably(tempPath: string, contents: string): Promise<void> {
  try {
    const handle = await open(tempPath, 'w')
    try {
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath)
      } catch {
        // Best-effort cleanup; the original error below is what matters.
      }
    }
    throw error
  }
}

/** Writes `contents` fully and durably to a temp file, then atomically renames it onto `targetPath`. */
export async function writeSnapshotAtomically(targetPath: string, contents: string): Promise<void> {
  const tempPath = `${targetPath}.tmp-${randomUUID()}`
  await writeFileDurably(tempPath, contents)
  try {
    renameSync(tempPath, targetPath)
  } catch (error) {
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath)
      } catch {
        // Best-effort cleanup; the original error below is what matters.
      }
    }
    throw error
  }
}

/**
 * A file-backed workspace store that never lets a crash or interrupted write destroy the last
 * usable canvas: saves are serialized, validated fully before they replace the primary snapshot,
 * and the previous valid snapshot is retained as a bounded recovery copy for startup fallback.
 */
export function createWorkspaceStore(path: string): WorkspaceStore {
  const backupPath = `${path}.backup`
  // A single promise chain serializes load/save so concurrent IPC calls cannot interleave file writes.
  let queue: Promise<unknown> = Promise.resolve()

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  return {
    load(): Promise<WorkspaceLoadResult> {
      return enqueue(async () => {
        const primary = readValidatedSnapshot(path)
        if (primary) return { state: primary, recovered: false, unrecoverable: false }

        const backup = readValidatedSnapshot(backupPath)
        if (!backup) {
          // A missing primary and backup means no workspace has ever been saved here; anything
          // else on disk (an unparseable primary and/or backup) means there was a workspace that
          // could not be recovered, which callers must not treat the same as a fresh install.
          const unrecoverable = existsSync(path) || existsSync(backupPath)
          return { state: null, recovered: false, unrecoverable }
        }

        // Recover the last known-good snapshot and self-heal the primary so future loads succeed too.
        try {
          await writeSnapshotAtomically(path, `${JSON.stringify(backup, null, 2)}\n`)
        } catch {
          // The recovery is still reported below even if self-healing the primary fails;
          // the backup copy itself remains untouched on disk either way.
        }
        return { state: backup, recovered: true, unrecoverable: false }
      })
    },
    save(state: WorkspaceState): Promise<WorkspaceSaveResult> {
      return enqueue(async () => {
        if (!isWorkspaceState(state)) return { ok: false, message: 'The workspace state is invalid.' }
        const contents = `${JSON.stringify(state, null, 2)}\n`
        const tempPath = `${path}.tmp-${randomUUID()}`
        try {
          await writeFileDurably(tempPath, contents)
          try {
            // Promote the current primary (if it is still valid) to the recovery copy before
            // replacing it, so a crash between these two renames leaves a recoverable backup
            // rather than losing both the old and new snapshots.
            if (readValidatedSnapshot(path)) {
              renameSync(path, backupPath)
            }
            renameSync(tempPath, path)
          } catch (error) {
            if (existsSync(tempPath)) {
              try {
                unlinkSync(tempPath)
              } catch {
                // Best-effort cleanup; the original error below is what matters.
              }
            }
            throw error
          }
          return { ok: true }
        } catch (error) {
          return { ok: false, message: errorMessage(error) }
        }
      })
    }
  }
}
