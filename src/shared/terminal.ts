import type { AgentProvider, AgentTurnOutcome } from './agent'
import type { AttentionItem } from './attention'
import type { WorkspaceFileNode } from './file-view'
import type { LocalFileOpenResult } from './local-file-link'
import type { WorkspaceDiffNode } from './git-diff'
import type { WorkspaceWorktree } from './worktree'
import type { ConversationTitleSource } from './conversation-title'

export type TerminalKind = 'terminal' | 'claude' | 'codex'
export type TerminalLiveness = 'live' | 'unverifiable' | 'exited'

/**
 * The live verdict on one canvas session. It is a *live* read - whoever runs the session owns it -
 * and deliberately not the unread model: `shared/attention.ts` decides what needs the user, while
 * this only says what the session is doing right now. Defined here rather than in the canvas so the
 * host and the mobile client can name the same states.
 */
export const terminalNodeStatuses = [
  'dormant',
  'starting',
  'idle',
  'working',
  'result',
  'attention',
  'stalled',
  'exited'
] as const
export type TerminalNodeStatus = (typeof terminalNodeStatuses)[number]

export const RECENTLY_CLOSED_SESSION_LIMIT = 10

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
  /** Always stored as lowercase `#rrggbb`; see `isProjectColor` in `shared/project-colors.ts`. */
  color: string
  /**
   * Shell command that makes a freshly created worktree usable (dependency install, env copy,
   * first build). Optional: a worktree is created whether or not one is configured.
   */
  setupCommand?: string
  /** The group this project sits in; absent means top level. Dangling ids are dropped on load. */
  groupId?: string
  /**
   * Where this project keeps its Markdown tickets, relative to its root. Absent means
   * `DEFAULT_TICKETS_DIRECTORY` in `shared/tickets.ts`.
   */
  ticketsDirectory?: string
  /**
   * The GitHub label that puts an open issue in the board's In progress column. Absent means
   * `DEFAULT_GITHUB_STATUS_LABELS.inProgress` in `shared/github-issues.ts`.
   */
  githubInProgressLabel?: string
}

/**
 * A collapsible sidebar folder. Groups are a desktop-sidebar affordance only: they never reach the
 * canvas, the remote projection, or the phone.
 */
export interface ProjectGroup {
  id: string
  name: string
  collapsed: boolean
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
  /** Why an agent node's label changed from its generic launch label. */
  titleSource?: ConversationTitleSource
  projectId: string
  /**
   * The worktree this node runs in. Absent means the node runs in the project checkout itself,
   * which stays the default; a node references a worktree, it does not own one.
   */
  worktreeId?: string
  /**
   * A worktree this node started work in without running there: the session keeps its own
   * working directory, so this is an association for the canvas, never a cwd.
   */
  activeWorktreeId?: string
  position: { x: number; y: number }
  width: number
  height: number
  conversationId?: string
  preview?: ConversationPreview
  /** Whether this node hides inline activity and reasoning, leaving only the dialogue. */
  focusMode?: boolean
  /** Legacy name read during migration; new snapshots never write it. */
  worklogCollapsed?: boolean
  /** The agent model this conversation last ran on, as reported by its ACP adapter. */
  modelId?: string
  /** Bounded local turn failures/cancellations that provider transcript replay cannot restore. */
  turnOutcomes?: AgentTurnOutcome[]
  terminalLiveness?: TerminalLiveness
  /** Unsent composer text, kept so a draft survives resize, collapse, and an Toucan restart. */
  draft?: string
}

/**
 * Whether a saved node hides its inline activity, reading the legacy field for a snapshot written
 * before the choice was renamed. One function so the store's migration and the canvas's restore
 * cannot disagree about what an older snapshot meant - the store rewrites the field on load, but a
 * recently-closed record is stored as it was and still comes back through the canvas.
 */
export function nodeFocusMode(node: Pick<WorkspaceTerminalNode, 'focusMode' | 'worklogCollapsed'>): boolean {
  return node.focusMode ?? node.worklogCollapsed ?? false
}

/**
 * The docked brain-dump library's persisted shape. Everything here outlives a restart for the same
 * reason a node's composer draft does: the user typed it, or sized it, and losing it would be a
 * silent discard. Width is stored raw and clamped against the current window on load, so shrinking
 * the application never permanently narrows the panel.
 */
export interface BrainDumpPanelState {
  open: boolean
  width: number
  /** An unsent capture draft, cleared only by a confirmed capture or an explicit Discard. */
  draft?: string
  /** The project the draft is filed under; absent means the user chose Unassigned. */
  draftProjectPath?: string
  /** The last provider a capture succeeded with; absent falls back to Codex. */
  provider?: 'claude' | 'codex'
}

/**
 * The board is a projection of files on disk, so there is nothing about a ticket worth persisting
 * here - only where the panel sits and whether it is open.
 */
export interface TicketBoardPanelState {
  open: boolean
  width: number
  /**
   * How wide the detail pane is inside the board, when the panel is wide enough to show the ticket
   * list and the detail side by side. Absent in every snapshot written before the three-pane
   * layout, and folded back into the panel's current width on read: a width stored by a wider board
   * must never squeeze the ticket list out of existence.
   */
  detailWidth?: number
  /**
   * Which optional ticket sources are switched on, keyed by project path. Only a choice is stored,
   * never a listing: whether this checkout shows its GitHub issues is the user's answer, and the
   * issues themselves are still read fresh from `gh` every time the board lists.
   */
  enabledSources?: Record<string, string[]>
}

export interface WorkspaceState {
  version: 3
  projects: WorkspaceProject[]
  /**
   * Absent in every snapshot written before groups existed. Array order is the order groups appear
   * in the sidebar, exactly as `projects` order is the order projects appear.
   */
  projectGroups?: ProjectGroup[]
  activeProjectId: string | null
  sidebarCollapsed: boolean
  agentPermissionModes?: AgentPermissionModes
  composerSendKey?: ComposerSendKey
  nodes: WorkspaceTerminalNode[]
  /** Bounded LIFO history used by Ctrl+Shift+T; callbacks are rebuilt when an entry is reopened. */
  recentlyClosedNodes?: WorkspaceTerminalNode[]
  /**
   * The durable unread model behind every attention count (see `shared/attention.ts`). Persisted
   * so an approval, sign-in request, result, or failure is still waiting after a restart; records
   * whose node no longer exists are pruned on load.
   */
  attention?: AttentionItem[]
  worktrees: WorkspaceWorktree[]
  /**
   * File nodes on the canvas. Absent in every snapshot written before they existed, and written
   * only when there is at least one, so a workspace without them keeps its old snapshot shape.
   */
  files?: WorkspaceFileNode[]
  /** Diff nodes on the canvas, optional and written only when present for the same reason as `files`. */
  diffs?: WorkspaceDiffNode[]
  /** Absent in every snapshot written before the library existed; the panel starts closed there. */
  brainDumpPanel?: BrainDumpPanelState
  /** Absent in every snapshot written before the board existed; the panel starts closed there. */
  ticketBoardPanel?: TicketBoardPanelState
  /**
   * Remembered canvas arrangements by slot number ('1'..'9'), written only when at least one is
   * saved. A slot names nodes by id; ids that no longer exist are skipped when it is restored.
   */
  layoutSlots?: Record<string, WorkspaceLayoutSlot>
}

/**
 * The `WorkspaceState` arrays that hold canvas nodes, one per node kind. Shared so the renderer's
 * `CANVAS_NODE_KINDS` and the store's `CANVAS_NODE_VALIDATORS` name the same set of fields: a kind
 * whose field is missing from one of those tables would be persisted without being validated, or
 * validated without ever being written.
 */
export type CanvasNodeStateField = 'nodes' | 'worktrees' | 'files' | 'diffs'

/** One remembered arrangement: where each node was, in flow coordinates, keyed by node id. */
export type WorkspaceLayoutSlot = Record<string, { x: number; y: number; width: number; height: number }>

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

export interface TerminalLivenessEvent {
  sessionId: string
  incarnationId: string
  liveness: TerminalLiveness
}

/**
 * Terminals, the workspace snapshot, and the clipboard/shell affordances the canvas offers,
 * seen from the renderer. Preload implements it; main answers the channels behind it.
 */
export interface TerminalApi {
  getInitialProject(): Promise<ProjectDirectory>
  pickProject(): Promise<ProjectDirectory | null>
  loadWorkspace(): Promise<WorkspaceLoadResult>
  saveWorkspace(state: WorkspaceState): Promise<WorkspaceSaveResult>
  getConversationPreview(kind: 'claude' | 'codex', conversationId: string): Promise<ConversationPreview | null>
  create(request: TerminalCreateRequest): Promise<TerminalCreateResult>
  write(sessionId: string, incarnationId: string, data: string): void
  resize(sessionId: string, incarnationId: string, cols: number, rows: number): void
  kill(sessionId: string, incarnationId: string, attachmentId: string): void
  /** Historical display data only; never proof that a process is alive or safe to write to. */
  scrollback(sessionId: string): Promise<TerminalScrollbackSnapshot | null>
  /** False means the retained files could not be completely removed. */
  removeScrollback(sessionId: string): Promise<boolean>
  copyText(text: string): void
  openExternal(url: string): Promise<void>
  /** Selects a file in the OS file manager; never opens or executes it. */
  showItemInFolder(path: string): Promise<void>
  /**
   * Opens a local artifact - an image, a document, a media file - with the application the OS
   * associates with it. Main decides whether the path may be opened at all and says why not.
   */
  openLocalFile(path: string): Promise<LocalFileOpenResult>
  readClipboardText(): string
  onData(sessionId: string, attachmentId: string, callback: (output: TerminalOutput) => void): () => void
  onExit(sessionId: string, attachmentId: string, callback: (result: TerminalExit) => void): () => void
}
