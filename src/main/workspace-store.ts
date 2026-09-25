import { existsSync, readFileSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { discardTempFileSync, writeFileDurably, writeSnapshotAtomically } from './durable-file'
import { createSerialQueue } from './serial-queue'
import { AGENT_TURN_OUTCOME_LIMIT } from '../shared/agent'
import { isAttentionItem, normalizeAttentionItems } from '../shared/attention'
import { isFileViewMode, type WorkspaceFileNode } from '../shared/file-view'
import type { WorkspaceDiffNode } from '../shared/git-diff'
import { isProjectColor, paletteColorAt } from '../shared/project-colors'
import { isProjectRunCommand } from '../shared/project-run-commands'
import { isDecisionDelegationPreference } from '../shared/decision-delegation'
import { isRoutineDelegationPreference } from '../shared/routine-delegation'
import { isDictationCleanupPreference } from '../shared/dictation-cleanup'
import {
  isComposerSendKey,
  nodeFocusMode,
  RECENTLY_CLOSED_SESSION_LIMIT,
  type CanvasNodeStateField,
  type ProjectGroup,
  type WorkspaceLoadResult,
  type WorkspaceProject,
  type WorkspaceSaveResult,
  type WorkspaceState
} from '../shared/workspace'
import { errorMessage } from '../shared/text'
import { normalizeWorkspaceWorktrees } from '../shared/worktree-identity'
import { isAgentProvider } from '../shared/agent-provider'
import { isScheduledMessage } from '../shared/scheduled-message'

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
    (worktree.unavailable === undefined || typeof worktree.unavailable === 'boolean') &&
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
      (project.githubInProgressLabel === undefined || typeof project.githubInProgressLabel === 'string') &&
      (project.avatarVersion === undefined || typeof project.avatarVersion === 'number') &&
      (project.runCommands === undefined ||
        (Array.isArray(project.runCommands) && project.runCommands.every(isProjectRunCommand)))
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
    (node.kind === 'terminal' || isAgentProvider(node.kind)) &&
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
    (node.scheduledMessages === undefined ||
      (Array.isArray(node.scheduledMessages) && node.scheduledMessages.every(isScheduledMessage))) &&
    // A branch's provenance leaves here as `forkFromSessionId` on an `agent:create`, so both halves
    // are checked rather than trusted: a malformed record would otherwise reach the adapter.
    (node.branchedFrom === undefined ||
      (typeof node.branchedFrom.nodeId === 'string' && typeof node.branchedFrom.conversationId === 'string')) &&
    (node.terminalLiveness === undefined || ['live', 'unverifiable', 'exited'].includes(node.terminalLiveness))
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
    (panel.provider === undefined || isAgentProvider(panel.provider))
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

function isLayoutSlots(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value as Record<string, unknown>).every(
    ([number, slot]) =>
      /^[1-9]$/.test(number) &&
      !!slot &&
      typeof slot === 'object' &&
      Object.values(slot as Record<string, unknown>).every((geometry) => {
        if (!geometry || typeof geometry !== 'object') return false
        const { x, y, width, height } = geometry as Record<string, unknown>
        return [x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))
      })
  )
}

/**
 * One entry per canvas node kind: which `WorkspaceState` array it persists into and what a valid
 * record in it looks like. The mirror, on this side of the privilege seam, of `CANVAS_NODE_KINDS`
 * in `renderer/src/canvas-workspace.ts` - a new kind is one entry here rather than another `if` in
 * `isWorkspaceState`, and `tests/workspace-store.test.ts` holds the two tables to the same fields
 * so a kind cannot be persisted without being validated. `alwaysPersisted` means the same thing it
 * does there: false for every kind added after version 3 was set, whose field is simply absent
 * from the snapshots written before it existed.
 */
export const CANVAS_NODE_VALIDATORS: readonly {
  field: CanvasNodeStateField
  alwaysPersisted: boolean
  isRecord(value: unknown): boolean
}[] = [
  { field: 'nodes', alwaysPersisted: true, isRecord: isWorkspaceTerminalNode },
  { field: 'worktrees', alwaysPersisted: true, isRecord: isWorkspaceWorktree },
  { field: 'files', alwaysPersisted: false, isRecord: isWorkspaceFileNode },
  { field: 'diffs', alwaysPersisted: false, isRecord: isWorkspaceDiffNode }
]

/** @internal exported for tests */
export function isWorkspaceState(value: unknown): value is WorkspaceState {
  if (!hasValidProjects(value)) return false
  const state = value as Partial<WorkspaceState>
  if (state.version !== 3) return false
  for (const kind of CANVAS_NODE_VALIDATORS) {
    const records: unknown = state[kind.field]
    if (records === undefined) {
      if (kind.alwaysPersisted) return false
      continue
    }
    if (!Array.isArray(records) || !records.every(kind.isRecord)) return false
  }
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
  if (state.routineDelegation !== undefined && !isRoutineDelegationPreference(state.routineDelegation)) return false
  if (state.dictationCleanup !== undefined && !isDictationCleanupPreference(state.dictationCleanup)) return false
  if (state.decisionDelegation !== undefined && !isDecisionDelegationPreference(state.decisionDelegation)) return false
  if (state.brainDumpPanel !== undefined && !isBrainDumpPanelState(state.brainDumpPanel)) return false
  if (state.ticketBoardPanel !== undefined && !isTicketBoardPanelState(state.ticketBoardPanel)) return false
  if (state.layoutSlots !== undefined && !isLayoutSlots(state.layoutSlots)) return false
  if (state.attention !== undefined && (!Array.isArray(state.attention) || !state.attention.every(isAttentionItem)))
    return false
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
      ? declared.filter((group) => {
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

/**
 * Repairs attention record ids before the snapshot is validated, for the reason
 * `normalizeAttentionItems` gives: a drifted id is a duplicate badge, and no id mistake is worth
 * refusing a whole canvas over.
 */
function normalizeAttention(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const state = value as { attention?: unknown }
  if (!Array.isArray(state.attention)) return value
  return { ...state, attention: normalizeAttentionItems(state.attention) }
}

/** @internal exported for tests */
export function parseWorkspaceState(candidate: unknown): WorkspaceState | null {
  const value = normalizeAttention(normalizeProjectsAndGroups(candidate))
  if (!hasValidProjects(value)) return null
  const version = (value as Partial<WorkspaceState>).version

  if (version === 3) {
    if (!isWorkspaceState(value)) return null
    const state = normalizeWorkspaceWorktrees(value)
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
        // Legacy keys older snapshots still carry, dropped here so they are never written back.
        const {
          worklogCollapsed: _collapsed,
          preview: _preview,
          ...current
        } = node as typeof node & { preview?: unknown }
        return {
          ...current,
          ...(node.kind === 'terminal' ? {} : { focusMode: nodeFocusMode(node) }),
          ...(node.turnOutcomes ? { turnOutcomes: node.turnOutcomes.slice(-AGENT_TURN_OUTCOME_LIMIT) } : {})
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

/**
 * A file-backed workspace store that never lets a crash or interrupted write destroy the last
 * usable canvas: saves are serialized, validated fully before they replace the primary snapshot,
 * and the previous valid snapshot is retained as a bounded recovery copy for startup fallback.
 */
export function createWorkspaceStore(path: string): WorkspaceStore {
  const backupPath = `${path}.backup`
  // A single serial queue serializes load/save so concurrent IPC calls cannot interleave file writes.
  const enqueue = createSerialQueue()

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
        const contents = `${JSON.stringify(normalizeWorkspaceWorktrees(state), null, 2)}\n`
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
            discardTempFileSync(tempPath)
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
