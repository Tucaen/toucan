import { isRecord } from './record'

/**
 * The canvas half of spawning a ticket session (#34). Main creates the worktree, guards it and
 * runs the project's setup command; node identity, geometry and the session launch are the
 * canvas's, so main then asks the desktop renderer to put the worktree and its chat on the canvas
 * through its own add-node path - the same split as a phone's spawn (`remote-spawn.ts`).
 */

/** Who orchestrates a ticket session: persisted on the ticket session's node, and drawn from it. */
export interface OrchestratorLink {
  nodeId: string
  conversationId: string
}

export interface TicketSessionCanvasRequest {
  /** The workspace project the worktree belongs to. */
  projectId: string
  /** The worktree main just created; the renderer registers it before the chat attaches to it. */
  worktree: { path: string; branch: string; baseRef: string }
  /** `#<id> <title>`, a manual title. */
  label: string
  modelId: string
  effortId: string
  /** The orchestrator's current permission mode, inherited; absent leaves the canvas default. */
  permissionMode?: string
  orchestratedBy: OrchestratorLink
  /** The first prompt: implementation skill, ticket, contract. */
  prompt: string
}

export type TicketSessionCanvasResult =
  { ok: true; nodeId: string; conversationId: string } | { ok: false; message: string }

export function isOrchestratorLink(value: unknown): value is OrchestratorLink {
  return isRecord(value) && typeof value.nodeId === 'string' && typeof value.conversationId === 'string'
}

/** Narrows the renderer's answer, which crosses IPC unvalidated. */
export function isTicketSessionCanvasResult(value: unknown): value is TicketSessionCanvasResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return typeof value.nodeId === 'string' && typeof value.conversationId === 'string'
  return value.ok === false && typeof value.message === 'string'
}
