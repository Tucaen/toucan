import type { AgentProvider } from './agent'
import type { FirstMateWorkspaceState } from './firstmate'

export type TerminalKind = 'terminal' | 'claude' | 'codex'
export type TerminalLiveness = 'live' | 'unverifiable' | 'exited'

export type AgentPermissionModes = Partial<Record<AgentProvider, string>>

export interface TerminalCreateRequest {
  id: string
  /** Durable identity of the terminal, independent of any renderer or process. */
  sessionId?: string
  attachmentId?: string
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
  sessionId?: string
  kind: TerminalKind
  label: string
  projectId: string
  position: { x: number; y: number }
  width: number
  height: number
  conversationId?: string
  preview?: ConversationPreview
  worklogCollapsed?: boolean
  /** The agent model this conversation last ran on, as reported by its ACP adapter. */
  modelId?: string
  terminalLiveness?: TerminalLiveness
}

export interface WorkspaceState {
  version: 2
  projects: WorkspaceProject[]
  activeProjectId: string | null
  sidebarCollapsed: boolean
  agentPermissionModes?: AgentPermissionModes
  firstMate?: FirstMateWorkspaceState
  nodes: WorkspaceTerminalNode[]
}

export interface WorkspaceSaveResult {
  ok: boolean
  message?: string
}

export interface WorkspaceLoadResult {
  state: WorkspaceState | null
  /** True when the primary snapshot was missing/corrupt and this state came from the recovery copy. */
  recovered: boolean
}

export interface TerminalCreateResult {
  ok: boolean
  message?: string
  sessionId?: string
  incarnationId?: string
  liveness?: TerminalLiveness
}

export interface TerminalOutput {
  sessionId: string
  incarnationId: string
  attachmentId: string
  data: string
}

export interface TerminalExit {
  sessionId: string
  incarnationId: string
  attachmentId: string
  exitCode: number
}

export interface TerminalSession {
  sessionId: string
  incarnationId: string
  attachmentId: string
  conversationId: string
}

export interface TerminalLivenessEvent {
  sessionId: string
  incarnationId: string
  liveness: TerminalLiveness
}
