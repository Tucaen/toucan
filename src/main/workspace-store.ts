import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { WorkspaceLoadResult, WorkspaceSaveResult, WorkspaceState } from '../shared/terminal'
import { errorMessage, repairUtf8Mojibake } from '../shared/text'

interface WorkspaceStateV1 {
  version: 1
  projects: WorkspaceState['projects']
  activeProjectId: string | null
  sidebarCollapsed: boolean
}

function hasValidProjects(value: unknown): value is Pick<WorkspaceState, 'projects' | 'activeProjectId' | 'sidebarCollapsed'> {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<WorkspaceState>
  if (!Array.isArray(state.projects)) return false
  if (state.activeProjectId !== null && typeof state.activeProjectId !== 'string') return false
  if (typeof state.sidebarCollapsed !== 'boolean') return false

  return state.projects.every((project) => (
    project
    && typeof project.id === 'string'
    && typeof project.name === 'string'
    && typeof project.path === 'string'
    && typeof project.color === 'string'
  ))
}

export function isWorkspaceState(value: unknown): value is WorkspaceState {
  if (!hasValidProjects(value)) return false
  const state = value as Partial<WorkspaceState>
  if (state.version !== 2 || !Array.isArray(state.nodes)) return false
  if (
    state.agentPermissionModes !== undefined
    && (
      !state.agentPermissionModes
      || typeof state.agentPermissionModes !== 'object'
      || (state.agentPermissionModes.claude !== undefined && typeof state.agentPermissionModes.claude !== 'string')
      || (state.agentPermissionModes.codex !== undefined && typeof state.agentPermissionModes.codex !== 'string')
    )
  ) return false
  return state.nodes.every((node) => (
    node
    && typeof node.id === 'string'
    && (node.sessionId === undefined || typeof node.sessionId === 'string')
    && ['terminal', 'claude', 'codex'].includes(node.kind)
    && typeof node.label === 'string'
    && typeof node.projectId === 'string'
    && typeof node.position?.x === 'number'
    && typeof node.position?.y === 'number'
    && typeof node.width === 'number'
    && typeof node.height === 'number'
    && (node.conversationId === undefined || typeof node.conversationId === 'string')
    && (node.worklogCollapsed === undefined || typeof node.worklogCollapsed === 'boolean')
    && (node.modelId === undefined || typeof node.modelId === 'string')
    && (node.terminalLiveness === undefined || ['live', 'unverifiable', 'exited'].includes(node.terminalLiveness))
    && (
      node.preview === undefined
      || (
        typeof node.preview.updatedAt === 'string'
        && (node.preview.user === undefined || typeof node.preview.user === 'string')
        && (node.preview.assistant === undefined || typeof node.preview.assistant === 'string')
      )
    )
  ))
}

export function parseWorkspaceState(value: unknown): WorkspaceState | null {
  if (hasValidProjects(value) && (value as Partial<WorkspaceState>).version === 2) {
    if (!isWorkspaceState(value as WorkspaceState)) return null
    const state = value as WorkspaceState
    return {
      ...state,
      nodes: state.nodes.map((node) => node.preview
        ? {
            ...node,
            preview: {
              ...node.preview,
              ...(node.preview.user ? { user: repairUtf8Mojibake(node.preview.user) } : {}),
              ...(node.preview.assistant ? { assistant: repairUtf8Mojibake(node.preview.assistant) } : {})
            }
          }
        : node)
    }
  }
  if (!hasValidProjects(value) || (value as WorkspaceStateV1).version !== 1) return null
  const previous = value as WorkspaceStateV1
  return {
    version: 2,
    projects: previous.projects,
    activeProjectId: previous.activeProjectId,
    sidebarCollapsed: previous.sidebarCollapsed,
    nodes: []
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
async function writeFileDurably(tempPath: string, contents: string): Promise<void> {
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
async function writeSnapshotAtomically(targetPath: string, contents: string): Promise<void> {
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
