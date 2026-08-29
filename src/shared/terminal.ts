import type { AgentProvider } from './agent'
import type { WorkspaceWorktree } from './worktree'

export type TerminalKind = 'terminal' | 'claude' | 'codex'
export type TerminalLiveness = 'live' | 'unverifiable' | 'exited'

export type AgentPermissionModes = Partial<Record<AgentProvider, string>>

/**
 * How the composer's Enter key behaves. One workspace-wide preference rather than a per-node one:
 * it is muscle memory, so it has to mean the same thing in every composer.
 */
export const composerSendKeys = ['enter', 'mod-enter'] as const
export type ComposerSendKey = (typeof composerSendKeys)[number]

export function isComposerSendKey(value: unknown): value is ComposerSendKey {
  return composerSendKeys.includes(value as ComposerSendKey)
}

export interface TerminalCreateRequest {
  id: string
  /** Durable identity of the terminal, independent of any renderer or process. */
  sessionId?: string
  attachmentId?: string
  kind: 'terminal'
  cols: number
  rows: number
  cwd: string
  /**
   * Written to the shell once, right after the session starts. Used to run a project's setup
   * command in a fresh worktree where the user can watch it and interrupt it.
   */
  initialInput?: string
}

export interface ProjectDirectory {
  name: string
  path: string
}

export interface WorkspaceProject extends ProjectDirectory {
  id: string
  color: string
  /**
   * Shell command that makes a freshly created worktree usable (dependency install, env copy,
   * first build). Optional: a worktree is created whether or not one is configured.
   */
  setupCommand?: string
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
  /**
   * The worktree this node runs in. Absent means the node runs in the project checkout itself,
   * which stays the default; a node references a worktree, it does not own one.
   */
  worktreeId?: string
  position: { x: number; y: number }
  width: number
  height: number
  conversationId?: string
  preview?: ConversationPreview
  worklogCollapsed?: boolean
  /** The agent model this conversation last ran on, as reported by its ACP adapter. */
  modelId?: string
  terminalLiveness?: TerminalLiveness
  /** Unsent composer text, kept so a draft survives resize, collapse, and an ADE restart. */
  draft?: string
}

export interface WorkspaceState {
  version: 3
  projects: WorkspaceProject[]
  activeProjectId: string | null
  sidebarCollapsed: boolean
  agentPermissionModes?: AgentPermissionModes
  composerSendKey?: ComposerSendKey
  nodes: WorkspaceTerminalNode[]
  worktrees: WorkspaceWorktree[]
}

export interface WorkspaceSaveResult {
  ok: boolean
  message?: string
}

export interface WorkspaceLoadResult {
  state: WorkspaceState | null
  /** True when the primary snapshot was missing/corrupt and this state came from the recovery copy. */
  recovered: boolean
  /**
   * True when a primary and/or backup file exists on disk but neither could be validated, so
   * `state` is null for reasons other than "no workspace has ever been saved." Callers must not
   * treat this the same as a fresh install: silently seeding and saving a default workspace here
   * would permanently destroy the last damaged-but-potentially-recoverable copy.
   */
  unrecoverable: boolean
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

export interface TerminalLivenessEvent {
  sessionId: string
  incarnationId: string
  liveness: TerminalLiveness
}
