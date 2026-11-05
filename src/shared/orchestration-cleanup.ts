import type { TicketSession } from './orchestration'

/** Retire the settled chat, preflight its canvas, then remove the chat and frame after Git succeeds. */
export interface TicketCleanupRequest {
  projectPath: string
  /** `conversationId` is absent for a live session no record names (an unrecorded attempt). */
  session: Omit<Required<TicketSession>, 'conversationId'> & { conversationId?: string }
  phase: 'retire' | 'prepare' | 'remove'
}

export type TicketCleanupResult = { ok: true } | { ok: false; message: string }

/**
 * A ticket worktree or `ticket/*` branch the record holds no attempt for, or one a live session
 * works in that the record does not name (Requirement 5 of the unrecorded-attempt work). Never
 * deleted: it is somebody's work that Toucan lost track of.
 */
export interface UnrecordedAttempt {
  /** The ticket the branch name belongs to: a record ticket's id when its slug matches, else the bare slug. */
  ticket: string
  /** Absent for a branch no worktree has checked out. */
  path?: string
  branch: string
  /** Commits on the branch the target lacks; null when git could not count them. */
  ahead: number | null
  /** Whether a live session runs in the worktree. */
  liveSession: boolean
  /** The node of the live session running there that the record does not name, when there is one. */
  nodeId?: string
  /** That session's conversation id, when it has opened one. */
  conversationId?: string
}

/** A live agent session and the directory it runs in. */
export interface LiveSessionLocation {
  nodeId: string
  cwd: string
  /** The provider conversation the session has opened, once it has. */
  conversationId?: string
}
