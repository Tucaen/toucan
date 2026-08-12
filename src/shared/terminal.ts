import type { AgentProvider } from './agent'

export type TerminalKind = 'terminal' | 'claude' | 'codex'

export type AgentPermissionModes = Partial<Record<AgentProvider, string>>

export interface TerminalCreateRequest {
  id: string
  kind: TerminalKind
  cols: number
  rows: number
  cwd: string
  conversationId?: string
  resume?: boolean
}

export interface ProjectDirectory {
  name: string
  path: string
}

export interface WorkspaceProject extends ProjectDirectory {
  id: string
  color: string
}

export interface ConversationPreview {
  user?: string
  assistant?: string
  updatedAt: string
}

export interface WorkspaceTerminalNode {
  id: string
  kind: TerminalKind
  label: string
  projectId: string
  position: { x: number; y: number }
  width: number
  height: number
  conversationId?: string
  preview?: ConversationPreview
  worklogCollapsed?: boolean
}

export interface WorkspaceState {
  version: 2
  projects: WorkspaceProject[]
  activeProjectId: string | null
  sidebarCollapsed: boolean
  agentPermissionModes?: AgentPermissionModes
  nodes: WorkspaceTerminalNode[]
}

export interface WorkspaceSaveResult {
  ok: boolean
  message?: string
}

export interface TerminalCreateResult {
  ok: boolean
  message?: string
}

export interface TerminalOutput {
  id: string
  data: string
}

export interface TerminalExit {
  id: string
  exitCode: number
}

export interface TerminalSession {
  id: string
  conversationId: string
}
