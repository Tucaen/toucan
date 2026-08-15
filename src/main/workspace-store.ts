import { readFileSync, writeFileSync } from 'node:fs'
import { FIRSTMATE_PANEL_MAX_WIDTH, FIRSTMATE_PANEL_MIN_WIDTH } from '../shared/firstmate'
import type { WorkspaceSaveResult, WorkspaceState } from '../shared/terminal'
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
  if (
    state.firstMate !== undefined
    && (
      !state.firstMate
      || typeof state.firstMate !== 'object'
      || (state.firstMate.provider !== undefined && state.firstMate.provider !== 'codex' && state.firstMate.provider !== 'claude')
      || (state.firstMate.conversationId !== undefined && typeof state.firstMate.conversationId !== 'string')
      || (state.firstMate.permissionMode !== undefined && typeof state.firstMate.permissionMode !== 'string')
      || (state.firstMate.modelId !== undefined && typeof state.firstMate.modelId !== 'string')
      || (state.firstMate.worklogCollapsed !== undefined && typeof state.firstMate.worklogCollapsed !== 'boolean')
      || (state.firstMate.panelWidth !== undefined && (
        typeof state.firstMate.panelWidth !== 'number'
        || !Number.isFinite(state.firstMate.panelWidth)
        || state.firstMate.panelWidth < FIRSTMATE_PANEL_MIN_WIDTH
        || state.firstMate.panelWidth > FIRSTMATE_PANEL_MAX_WIDTH
      ))
    )
  ) return false

  return state.nodes.every((node) => (
    node
    && typeof node.id === 'string'
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
  if (isWorkspaceState(value)) {
    return {
      ...value,
      nodes: value.nodes.map((node) => node.preview
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
  load(): WorkspaceState | null
  save(state: WorkspaceState): WorkspaceSaveResult
}

export function createWorkspaceStore(path: string): WorkspaceStore {
  return {
    load(): WorkspaceState | null {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
        return parseWorkspaceState(parsed)
      } catch {
        return null
      }
    },
    save(state: WorkspaceState): WorkspaceSaveResult {
      if (!isWorkspaceState(state)) return { ok: false, message: 'The workspace state is invalid.' }
      try {
        writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
        return { ok: true }
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
      }
    }
  }
}
