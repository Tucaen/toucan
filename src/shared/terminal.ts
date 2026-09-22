import type { AgentProvider } from './agent'

/**
 * One shell session: how it is started, what it emits, and how it ends. Everything a terminal
 * *sits on* - the canvas, the workspace snapshot, the projects - lives in `shared/workspace.ts`,
 * and the OS affordances the canvas offers live in `shared/shell.ts`.
 */

export type TerminalKind = 'terminal' | AgentProvider
export type TerminalLiveness = 'live' | 'unverifiable' | 'exited'

/**
 * The live verdict on one canvas session. It is a *live* read - whoever runs the session owns it -
 * and deliberately not the unread model: `shared/attention.ts` decides what needs the user, while
 * this only says what the session is doing right now. Defined here rather than in the canvas so the
 * host and the mobile client can name the same states.
 */
export type TerminalNodeStatus =
  'dormant' | 'starting' | 'idle' | 'working' | 'result' | 'attention' | 'stalled' | 'exited'

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

/** Display-only retained output. It is never evidence that the process is reachable or writable. */
export interface TerminalScrollbackSnapshot {
  sessionId: string
  incarnationId: string
  data: string
  capturedAt: number
  truncated: boolean
  incomplete: boolean
}

export interface TerminalExit {
  sessionId: string
  incarnationId: string
  attachmentId: string
  exitCode: number
}

/** Terminals seen from the renderer. Preload implements it; main answers the channels behind it. */
export interface TerminalApi {
  create(request: TerminalCreateRequest): Promise<TerminalCreateResult>
  write(sessionId: string, incarnationId: string, data: string): void
  resize(sessionId: string, incarnationId: string, cols: number, rows: number): void
  kill(sessionId: string, incarnationId: string, attachmentId: string): void
  /** Historical display data only; never proof that a process is alive or safe to write to. */
  scrollback(sessionId: string): Promise<TerminalScrollbackSnapshot | null>
  /** False means the retained files could not be completely removed. */
  removeScrollback(sessionId: string): Promise<boolean>
  onData(sessionId: string, attachmentId: string, callback: (output: TerminalOutput) => void): () => void
  onExit(sessionId: string, attachmentId: string, callback: (result: TerminalExit) => void): () => void
}
