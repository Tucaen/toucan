import type { Node } from '@xyflow/react'
import type { AttentionAction, AttentionKind } from '../../shared/attention'
import type { AgentTurnOutcome } from '../../shared/agent'
import type {
  AgentPermissionModes,
  ConversationPreview,
  TerminalLiveness,
  TerminalKind,
  TerminalNodeStatus,
  WorkspaceState,
  WorkspaceTerminalNode
} from '../../shared/terminal'
import { RECENTLY_CLOSED_SESSION_LIMIT, type WorkspaceProject } from '../../shared/terminal'
import { defaultFileViewMode, type FileViewMode, type WorkspaceFileNode } from '../../shared/file-view'
import type { WorkspaceDiffNode } from '../../shared/git-diff'
import type { WorkspaceWorktree } from '../../shared/worktree'
import type { WorktreeHandoffPlan } from '../../shared/worktree-handoff'
import type { ConversationTitleSource } from '../../shared/conversation-title'
import type { TicketActivityReport } from './ticket-activity'

/** Re-exported so canvas modules keep one import site; the union itself is a shared contract. */
export type { TerminalNodeStatus }

/** What a node reports about its own attention; the reducer that consumes it lives in shared/attention.ts. */
export type NodeAttentionAction = AttentionAction

export interface TerminalNodeCallbacks {
  onStatusChange(nodeId: string, status: TerminalNodeStatus): void
  /**
   * The single channel every surface uses to report or clear attention. Optional so a node can
   * be rendered in isolation (tests, storybook-style harnesses) without a workspace behind it.
   */
  onAttention?(action: NodeAttentionAction): void
  /**
   * Which ticket files this session has been writing, so the board can show a live card. The node
   * reports paths rather than tickets because it knows its transcript but not where its project
   * keeps tickets; the workspace resolves them (`ticket-activity.ts`). Optional for the same
   * reason `onAttention` is: a node must render without a workspace behind it.
   */
  onTicketActivity?(nodeId: string, report: TicketActivityReport): void
  onConversationId(nodeId: string, conversationId: string): void
  onTitleChange(nodeId: string, title: string, source: ConversationTitleSource): Promise<boolean>
  onPreview(nodeId: string, preview: ConversationPreview): void
  onFocusModeChange(nodeId: string, enabled: boolean): void
  /** Persists unsent composer text so a draft outlives resize, collapse, and a workspace reload. */
  onDraftChange(nodeId: string, draft: string): void
  onPermissionModeChange(provider: keyof AgentPermissionModes, modeId: string): void
  onModelChange(nodeId: string, modelId: string): void
  /** Persists terminal turn outcomes that provider-owned transcript replay cannot reproduce. */
  onTurnOutcome?(nodeId: string, outcome: AgentTurnOutcome): void
  onResume(nodeId: string): void
  onTerminalLiveness?(nodeId: string, liveness: TerminalLiveness): void
  /**
   * A prompt that asked for its own worktree. The composer hands it up rather than dispatching
   * it, so the work starts in a session whose working directory is the worktree from its first
   * turn - which is the only way it can be granted as a writable root.
   */
  onWorktreeHandoff?(nodeId: string, request: WorktreeHandoffPlan): void
}

interface CanvasNodePresentation {
  /** Session-local presentation state; deliberately omitted from workspace serialization. */
  fittedToCanvas?: boolean
}

export interface TerminalNodeData extends Record<string, unknown>, TerminalNodeCallbacks, CanvasNodePresentation {
  kind: TerminalKind
  sessionId: string
  terminalLiveness: TerminalLiveness
  label: string
  titleSource?: ConversationTitleSource
  projectId: string
  projectName: string
  projectPath: string
  projectColor: string
  /** The worktree this node is attached to, if any. Attachment is fixed for the node's life. */
  worktreeId?: string
  /** Shown on the node so it is always obvious which branch a session is editing. */
  worktreeBranch?: string
  /** A worktree this node started work in but does not run in; drawn as a link, never a cwd. */
  activeWorktreeId?: string
  activeWorktreeBranch?: string
  /**
   * Where this session actually runs: the attached worktree's directory, or the project
   * checkout when unattached. This is the only value that should ever be sent as a cwd.
   */
  workingDirectory: string
  /** True when a restored node's worktree record is gone, so it must not silently run elsewhere. */
  detachedFromWorktree?: boolean
  conversationId?: string
  preview?: ConversationPreview
  focusMode: boolean
  /** Unsent composer text, restored into the composer when the node comes back. */
  draft?: string
  preferredPermissionMode?: string
  modelId?: string
  turnOutcomes?: AgentTurnOutcome[]
  dormant: boolean
  /**
   * How many attention records on this node are still unread. Pushed down from the workspace so
   * the node's own indicator, the sidebar, and the header all read the same number.
   */
  unread?: number
  /** The most blocking of those unread records, so a node's own dot can say which kind it is. */
  unreadKind?: AttentionKind
  launchMode: 'new' | 'resume'
  /** Written into the shell on first start; carries a project's setup command. */
  initialInput?: string
}

export interface WorktreeNodeCallbacks {
  onRemoveWorktree(worktreeId: string): void
  onCreateNodeInWorktree(worktreeId: string, kind: TerminalKind): void
  onRunSetupCommand(worktreeId: string): void
  /** Opens a diff node reviewing this worktree's changes against the ref it was branched from. */
  onOpenDiff(worktreeId: string): void
}

export interface WorktreeNodeData extends Record<string, unknown>, WorktreeNodeCallbacks, CanvasNodePresentation {
  worktreeId: string
  branch: string
  path: string
  baseRef: string
  createdAt: string
  projectId: string
  projectName: string
  projectPath: string
  projectColor: string
  setupCommand?: string
  /** How many canvas nodes currently run in this worktree; teardown is refused while non-zero. */
  attachedNodeCount: number
}

export interface FileNodeCallbacks {
  /** The reader switched between rendered Markdown and raw text; the choice persists with the node. */
  onViewModeChange(nodeId: string, view: FileViewMode): void
  /** Opens the workspace picker and returns the selected absolute path, or null when cancelled. */
  onRequestFilePath(nodeId: string): Promise<string | null>
  /** The reader chose another file for this existing canvas node. */
  onPathChange(nodeId: string, path: string): void
}

export interface FileNodeData extends Record<string, unknown>, FileNodeCallbacks, CanvasNodePresentation {
  /** Absolute path of the file shown. Kept even when the file is gone so the layout survives. */
  path: string
  view: FileViewMode
  projectId: string
  projectName: string
  projectPath: string
  projectColor: string
}

export interface DiffNodeCallbacks {
  /** The reader opened another file's hunks (or none); the choice persists with the node. */
  onSelectDiffPath(nodeId: string, path: string | undefined): void
}

export interface DiffNodeData extends Record<string, unknown>, DiffNodeCallbacks, CanvasNodePresentation {
  projectId: string
  projectName: string
  projectPath: string
  projectColor: string
  /** The worktree under review; absent for the project's primary checkout. */
  worktreeId?: string
  /** Shown as the node's identity: the worktree branch, or the project name for the primary checkout. */
  label: string
  /** The checkout directory git runs in. */
  path: string
  /** What the working tree is compared against; `HEAD` for the primary checkout. */
  baseRef: string
  selectedPath?: string
}

export type TerminalCanvasNode = Node<TerminalNodeData, 'terminalNode'>
export type WorktreeCanvasNode = Node<WorktreeNodeData, 'worktreeNode'>
export type FileCanvasNode = Node<FileNodeData, 'fileNode'>
export type DiffCanvasNode = Node<DiffNodeData, 'diffNode'>
export type CanvasNode = TerminalCanvasNode | WorktreeCanvasNode | FileCanvasNode | DiffCanvasNode
export const NODE_DRAG_HANDLE = '.node-header'

/** Enough accidental closes to be useful without letting a workspace snapshot grow forever. */
export const CLOSED_SESSION_STACK_LIMIT = RECENTLY_CLOSED_SESSION_LIMIT

/** The subset of `KeyboardEvent` the canvas shortcuts read, so callers can test without a DOM. */
export interface ShortcutKey {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  /** True while a held key auto-repeats; a shortcut that creates something must fire only once. */
  repeat?: boolean
}

export function closedSessionKeyAction(event: ShortcutKey, hasClosedSession: boolean): 'reopen' | 'none' {
  return hasClosedSession &&
    event.key.toLocaleLowerCase() === 't' &&
    event.ctrlKey &&
    event.shiftKey &&
    !event.altKey &&
    !event.metaKey
    ? 'reopen'
    : 'none'
}

/** One entry of the canvas context menu, reachable from the keyboard without opening the menu. */
export type CreateNodeKeyAction =
  | 'create-terminal'
  | 'create-claude'
  | 'create-codex'
  | 'create-worktree'
  | 'open-history'
  | 'open-file'
  | 'open-diff'
  | 'none'

/**
 * Ctrl+P mirrors VS Code's quick-open for the file node; the others follow the same "Ctrl plus the
 * node's initial" idea, with Shift for the secondary agent and for the worktree (Ctrl+Shift+G is
 * VS Code's source-control view). Ctrl+Alt is deliberately unused: on German layouts it is AltGr
 * and types characters. Ctrl+Shift+T is taken by `closedSessionKeyAction`.
 */
const NODE_SHORTCUTS: readonly { action: Exclude<CreateNodeKeyAction, 'none'>; key: string; shift: boolean }[] = [
  { action: 'create-terminal', key: 't', shift: false },
  { action: 'create-claude', key: 'n', shift: false },
  { action: 'create-codex', key: 'n', shift: true },
  { action: 'create-worktree', key: 'g', shift: true },
  { action: 'open-history', key: 'h', shift: false },
  { action: 'open-file', key: 'p', shift: false },
  { action: 'open-diff', key: 'd', shift: false }
]

/** Shown beside each menu entry so the shortcuts are discoverable where the mouse already is. */
export const NODE_SHORTCUT_LABELS = Object.fromEntries(
  NODE_SHORTCUTS.map(({ action, key, shift }) => [action, `Ctrl+${shift ? 'Shift+' : ''}${key.toLocaleUpperCase()}`])
) as Record<Exclude<CreateNodeKeyAction, 'none'>, string>

export interface CreateNodeKeyContext {
  /** Whether the key went to a terminal, where Ctrl+P/N/H/T are readline keys the shell must keep. */
  editingTerminal: boolean
}

/**
 * Text fields are fine - none of these keys mean anything in an input - but a terminal owns them,
 * so the shortcut yields there. A held key repeats the event and would otherwise spawn a node per
 * repeat, so only the first press counts.
 */
export function createNodeKeyAction(event: ShortcutKey, context: CreateNodeKeyContext): CreateNodeKeyAction {
  if (context.editingTerminal || event.repeat || !event.ctrlKey || event.altKey || event.metaKey) return 'none'
  const key = event.key.toLocaleLowerCase()
  return NODE_SHORTCUTS.find((binding) => binding.key === key && binding.shift === event.shiftKey)?.action ?? 'none'
}

export function isTerminalCanvasNode(node: CanvasNode): node is TerminalCanvasNode {
  return node.type === 'terminalNode'
}

export function isWorktreeCanvasNode(node: CanvasNode): node is WorktreeCanvasNode {
  return node.type === 'worktreeNode'
}

export function isFileCanvasNode(node: CanvasNode): node is FileCanvasNode {
  return node.type === 'fileNode'
}

export function isDiffCanvasNode(node: CanvasNode): node is DiffCanvasNode {
  return node.type === 'diffNode'
}

/**
 * Nodes that are layout rather than sessions: closing one is not an accidental close worth
 * undoing, so they never enter the recently-closed stack - and never wipe it either.
 */
export function isLayoutCanvasNode(node: CanvasNode): node is FileCanvasNode | DiffCanvasNode {
  return isFileCanvasNode(node) || isDiffCanvasNode(node)
}

export interface RestoredCanvasWorkspace {
  nodes: CanvasNode[]
  statuses: Record<string, TerminalNodeStatus>
  nextSessionNumber: number
  activeProjectId: string
}

const DEFAULT_TERMINAL_SIZE = { width: 520, height: 340 }
export const DEFAULT_WORKTREE_SIZE = { width: 360, height: 232 }
/** Taller than wide: a file node is for reading a document, and prose is read downward. */
export const DEFAULT_FILE_NODE_SIZE = { width: 480, height: 560 }
/** Wide enough for a file rail beside hunks that keep their line numbers readable. */
export const DEFAULT_DIFF_NODE_SIZE = { width: 760, height: 560 }

/** How far each retry of `cascadedNodePosition` steps, and how many times it may step. */
const CASCADE_STEP = 48
const CASCADE_ATTEMPTS = 24

/**
 * A spot near `origin` whose top-left corner no node already sits on, cascaded down-right.
 *
 * A node created from the canvas lands where the pointer was, which is inherently distinguishable.
 * One created with no pointer behind it - a phone spawning a chat - has only a default spot, and
 * two of those in a row would land on the exact same coordinates, hiding the first behind the
 * second completely. This is the same cascade a window manager offers for the same reason, and it
 * makes the same promise: the new node's header and controls are reachable, *not* that it does not
 * overlap (a session node is many times wider than one step). After enough attempts the last
 * candidate is taken regardless - a node landing on another is a far smaller problem than a search
 * that does not end.
 */
export function cascadedNodePosition(
  nodes: readonly { position: { x: number; y: number } }[],
  origin: { x: number; y: number }
): { x: number; y: number } {
  const taken = (candidate: { x: number; y: number }): boolean =>
    nodes.some(
      (node) =>
        Math.abs(node.position.x - candidate.x) < CASCADE_STEP && Math.abs(node.position.y - candidate.y) < CASCADE_STEP
    )
  let candidate = origin
  for (let attempt = 0; attempt < CASCADE_ATTEMPTS && taken(candidate); attempt += 1) {
    candidate = {
      x: origin.x + (attempt + 1) * CASCADE_STEP,
      y: origin.y + (attempt + 1) * CASCADE_STEP
    }
  }
  return candidate
}

type SessionRestoreWorkspace = Pick<WorkspaceState, 'projects' | 'worktrees' | 'agentPermissionModes'>
type SessionRestoreMode = 'hydrate' | 'reopen'

function measured(node: CanvasNode, fallback: { width: number; height: number }): { width: number; height: number } {
  const styleWidth = typeof node.style?.width === 'number' ? node.style.width : fallback.width
  const styleHeight = typeof node.style?.height === 'number' ? node.style.height : fallback.height
  return {
    width: node.measured?.width ?? styleWidth,
    height: node.measured?.height ?? styleHeight
  }
}

export function serializeCanvasNode(node: TerminalCanvasNode): WorkspaceTerminalNode {
  const size = measured(node, DEFAULT_TERMINAL_SIZE)
  return {
    id: node.id,
    ...(node.data.kind === 'terminal' ? { sessionId: node.data.sessionId } : {}),
    kind: node.data.kind,
    label: node.data.label,
    ...(node.data.titleSource ? { titleSource: node.data.titleSource } : {}),
    projectId: node.data.projectId,
    ...(node.data.worktreeId ? { worktreeId: node.data.worktreeId } : {}),
    ...(node.data.activeWorktreeId ? { activeWorktreeId: node.data.activeWorktreeId } : {}),
    position: node.position,
    width: size.width,
    height: size.height,
    ...(node.data.conversationId ? { conversationId: node.data.conversationId } : {}),
    ...(node.data.preview ? { preview: node.data.preview } : {}),
    ...(node.data.modelId ? { modelId: node.data.modelId } : {}),
    ...(node.data.turnOutcomes?.length ? { turnOutcomes: node.data.turnOutcomes } : {}),
    ...(node.data.draft ? { draft: node.data.draft } : {}),
    ...(node.data.kind === 'terminal' ? {} : { focusMode: node.data.focusMode }),
    ...(node.data.kind === 'terminal' ? { terminalLiveness: node.data.terminalLiveness } : {})
  }
}

/** Store only durable session data; React callbacks are rebuilt when the node is reopened. */
export function rememberClosedSessionNodes(
  current: WorkspaceTerminalNode[],
  removedNodes: CanvasNode[]
): WorkspaceTerminalNode[] {
  if (removedNodes.length === 0) return current
  const sessionNodes = removedNodes.filter(isTerminalCanvasNode)
  if (
    sessionNodes.length !== removedNodes.length ||
    sessionNodes.some((node) => node.data.kind !== 'terminal' && !node.data.conversationId)
  )
    return []
  const closed = sessionNodes.map(serializeCanvasNode)
  return [...current, ...closed].slice(-CLOSED_SESSION_STACK_LIMIT)
}

function restoreTerminalCanvasNode(
  savedNode: WorkspaceTerminalNode,
  workspace: SessionRestoreWorkspace,
  callbacks: TerminalNodeCallbacks,
  mode: SessionRestoreMode
): TerminalCanvasNode | null {
  const project = workspace.projects.find((candidate) => candidate.id === savedNode.projectId)
  if (!project) return null
  const worktree = savedNode.worktreeId
    ? workspace.worktrees.find((candidate) => candidate.id === savedNode.worktreeId)
    : undefined
  // A node whose worktree record vanished must never quietly fall back to the project
  // checkout and start writing there, so it restores detached and dormant instead.
  const detachedFromWorktree = Boolean(savedNode.worktreeId) && !worktree
  // Workspace hydration leaves real terminal processes dormant; an explicit undo opens the
  // process immediately, just as creating or resuming a node does.
  const dormant = detachedFromWorktree || (mode === 'hydrate' && savedNode.kind === 'terminal')
  const terminalLiveness: TerminalLiveness =
    savedNode.kind === 'terminal' ? (savedNode.terminalLiveness === 'exited' ? 'exited' : 'unverifiable') : 'live'
  return {
    id: savedNode.id,
    type: 'terminalNode',
    dragHandle: NODE_DRAG_HANDLE,
    ...(mode === 'reopen' ? { selected: true } : {}),
    position: savedNode.position,
    data: {
      kind: savedNode.kind,
      sessionId: savedNode.sessionId ?? savedNode.id,
      terminalLiveness,
      label: savedNode.label,
      titleSource: savedNode.titleSource,
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      projectColor: project.color,
      worktreeId: worktree?.id,
      worktreeBranch: worktree?.branch,
      activeWorktreeId: savedNode.activeWorktreeId,
      activeWorktreeBranch: savedNode.activeWorktreeId
        ? workspace.worktrees.find((candidate) => candidate.id === savedNode.activeWorktreeId)?.branch
        : undefined,
      workingDirectory: worktree?.path ?? project.path,
      detachedFromWorktree,
      conversationId: savedNode.conversationId,
      preview: savedNode.preview,
      focusMode: savedNode.focusMode ?? savedNode.worklogCollapsed ?? false,
      draft: savedNode.draft,
      preferredPermissionMode:
        savedNode.kind === 'terminal' ? undefined : workspace.agentPermissionModes?.[savedNode.kind],
      modelId: savedNode.kind === 'terminal' ? undefined : savedNode.modelId,
      turnOutcomes: savedNode.kind === 'terminal' ? undefined : savedNode.turnOutcomes,
      dormant,
      launchMode: 'resume',
      onStatusChange: callbacks.onStatusChange,
      onAttention: callbacks.onAttention,
      onTicketActivity: callbacks.onTicketActivity,
      onConversationId: callbacks.onConversationId,
      onTitleChange: callbacks.onTitleChange,
      onPreview: callbacks.onPreview,
      onFocusModeChange: callbacks.onFocusModeChange,
      onDraftChange: callbacks.onDraftChange,
      onPermissionModeChange: callbacks.onPermissionModeChange,
      onModelChange: callbacks.onModelChange,
      onTurnOutcome: callbacks.onTurnOutcome,
      onResume: callbacks.onResume,
      onTerminalLiveness: callbacks.onTerminalLiveness,
      onWorktreeHandoff: callbacks.onWorktreeHandoff
    },
    style: { width: savedNode.width, height: savedNode.height }
  }
}

export function reopenClosedSession(
  recentlyClosedNodes: WorkspaceTerminalNode[],
  workspace: SessionRestoreWorkspace,
  callbacks: TerminalNodeCallbacks
): { node: TerminalCanvasNode | null; recentlyClosedNodes: WorkspaceTerminalNode[] } {
  const remaining = [...recentlyClosedNodes]
  while (remaining.length > 0) {
    const savedNode = remaining.pop()!
    if (savedNode.kind !== 'terminal' && !savedNode.conversationId) {
      return { node: null, recentlyClosedNodes: [] }
    }
    const node = restoreTerminalCanvasNode(savedNode, workspace, callbacks, 'reopen')
    if (node) return { node, recentlyClosedNodes: remaining }
  }
  return { node: null, recentlyClosedNodes: remaining }
}

export function serializeWorktreeNode(node: WorktreeCanvasNode): WorkspaceWorktree {
  const size = measured(node, DEFAULT_WORKTREE_SIZE)
  return {
    id: node.data.worktreeId,
    projectId: node.data.projectId,
    branch: node.data.branch,
    path: node.data.path,
    baseRef: node.data.baseRef,
    createdAt: node.data.createdAt,
    position: node.position,
    width: size.width,
    height: size.height
  }
}

export function serializeFileNode(node: FileCanvasNode): WorkspaceFileNode {
  const size = measured(node, DEFAULT_FILE_NODE_SIZE)
  return {
    id: node.id,
    projectId: node.data.projectId,
    path: node.data.path,
    view: node.data.view,
    position: node.position,
    width: size.width,
    height: size.height
  }
}

/** Repoints one file node without rebuilding the canvas object that owns its layout. */
export function changeFileCanvasNodePath(nodes: CanvasNode[], nodeId: string, path: string): CanvasNode[] {
  const target = nodes.find((node) => isFileCanvasNode(node) && node.id === nodeId)
  if (!target || target.data.path === path) return nodes
  return nodes.map((node) =>
    isFileCanvasNode(node) && node.id === nodeId ? { ...node, data: { ...node.data, path } } : node
  )
}

export interface FileNodeSeed {
  id: string
  path: string
  position: { x: number; y: number }
  /** Absent for a freshly opened file, which then opens the way its type reads best. */
  view?: FileViewMode
  width?: number
  height?: number
}

/**
 * The one place a file node is built, whether it is opened from the picker, from a transcript's
 * file card, or restored from a snapshot - so every path lands with the same header, drag handle
 * and size rules. The project is denormalised onto the node exactly as it is for session nodes.
 */
export function createFileCanvasNode(
  seed: FileNodeSeed,
  project: WorkspaceProject,
  callbacks: FileNodeCallbacks
): FileCanvasNode {
  return {
    id: seed.id,
    type: 'fileNode',
    dragHandle: NODE_DRAG_HANDLE,
    position: seed.position,
    data: {
      path: seed.path,
      view: seed.view ?? defaultFileViewMode(seed.path),
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      projectColor: project.color,
      onViewModeChange: callbacks.onViewModeChange,
      onRequestFilePath: callbacks.onRequestFilePath,
      onPathChange: callbacks.onPathChange
    },
    style: { width: seed.width ?? DEFAULT_FILE_NODE_SIZE.width, height: seed.height ?? DEFAULT_FILE_NODE_SIZE.height }
  }
}

export function serializeDiffNode(node: DiffCanvasNode): WorkspaceDiffNode {
  const size = measured(node, DEFAULT_DIFF_NODE_SIZE)
  return {
    id: node.id,
    projectId: node.data.projectId,
    ...(node.data.worktreeId ? { worktreeId: node.data.worktreeId } : {}),
    position: node.position,
    width: size.width,
    height: size.height,
    ...(node.data.selectedPath ? { selectedPath: node.data.selectedPath } : {})
  }
}

export interface DiffNodeSeed {
  id: string
  position: { x: number; y: number }
  selectedPath?: string
  width?: number
  height?: number
}

/**
 * The one place a diff node is built, from the worktree node header, the canvas menu, or a
 * snapshot. Against a worktree it reviews that directory against the ref the branch was cut
 * from; without one it reviews the project's primary checkout against `HEAD`, which is the only
 * base a checkout with no recorded origin has.
 */
export function createDiffCanvasNode(
  seed: DiffNodeSeed,
  project: WorkspaceProject,
  worktree: Pick<WorkspaceWorktree, 'id' | 'branch' | 'path' | 'baseRef'> | undefined,
  callbacks: DiffNodeCallbacks
): DiffCanvasNode {
  return {
    id: seed.id,
    type: 'diffNode',
    dragHandle: NODE_DRAG_HANDLE,
    position: seed.position,
    data: {
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      projectColor: project.color,
      ...(worktree ? { worktreeId: worktree.id } : {}),
      label: worktree ? worktree.branch : project.name,
      path: worktree ? worktree.path : project.path,
      baseRef: worktree ? worktree.baseRef : 'HEAD',
      ...(seed.selectedPath ? { selectedPath: seed.selectedPath } : {}),
      onSelectDiffPath: callbacks.onSelectDiffPath
    },
    style: { width: seed.width ?? DEFAULT_DIFF_NODE_SIZE.width, height: seed.height ?? DEFAULT_DIFF_NODE_SIZE.height }
  }
}

/** Records which file a diff node has open without rebuilding the canvas object that owns its layout. */
export function selectDiffCanvasNodePath(nodes: CanvasNode[], nodeId: string, path: string | undefined): CanvasNode[] {
  const target = nodes.find((node) => isDiffCanvasNode(node) && node.id === nodeId)
  if (!target || target.data.selectedPath === path) return nodes
  return nodes.map((node) =>
    isDiffCanvasNode(node) && node.id === nodeId ? { ...node, data: { ...node.data, selectedPath: path } } : node
  )
}

/** A worktree's diff nodes go with it: they review a directory that no longer exists. */
export function withoutWorktree(nodes: CanvasNode[], worktreeId: string): CanvasNode[] {
  return nodes.filter(
    (node) =>
      !(isWorktreeCanvasNode(node) && node.data.worktreeId === worktreeId) &&
      !(isDiffCanvasNode(node) && node.data.worktreeId === worktreeId)
  )
}

export function restoreCanvasWorkspace(
  state: WorkspaceState,
  callbacks: TerminalNodeCallbacks & WorktreeNodeCallbacks & FileNodeCallbacks & DiffNodeCallbacks
): RestoredCanvasWorkspace {
  const projectsById = new Map(state.projects.map((project) => [project.id, project]))
  const worktrees = (state.worktrees ?? []).filter((worktree) => projectsById.has(worktree.projectId))
  const worktreesById = new Map(worktrees.map((worktree) => [worktree.id, worktree]))
  const attachedCounts = new Map<string, number>()
  for (const node of state.nodes) {
    if (node.worktreeId && worktreesById.has(node.worktreeId)) {
      attachedCounts.set(node.worktreeId, (attachedCounts.get(node.worktreeId) ?? 0) + 1)
    }
  }

  const worktreeNodes = worktrees.map<WorktreeCanvasNode>((worktree) => {
    const project = projectsById.get(worktree.projectId)!
    return {
      id: `worktree:${worktree.id}`,
      type: 'worktreeNode',
      dragHandle: NODE_DRAG_HANDLE,
      // Teardown is a deliberate, evidence-gated act; the Delete key must never be able to
      // drop the record and orphan a directory git still knows about.
      deletable: false,
      position: worktree.position,
      data: {
        worktreeId: worktree.id,
        branch: worktree.branch,
        path: worktree.path,
        baseRef: worktree.baseRef,
        createdAt: worktree.createdAt,
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        projectColor: project.color,
        setupCommand: project.setupCommand,
        attachedNodeCount: attachedCounts.get(worktree.id) ?? 0,
        onRemoveWorktree: callbacks.onRemoveWorktree,
        onCreateNodeInWorktree: callbacks.onCreateNodeInWorktree,
        onRunSetupCommand: callbacks.onRunSetupCommand,
        onOpenDiff: callbacks.onOpenDiff
      },
      style: { width: worktree.width, height: worktree.height }
    }
  })

  const terminalNodes = state.nodes.flatMap<TerminalCanvasNode>((savedNode) => {
    const restored = restoreTerminalCanvasNode(savedNode, { ...state, worktrees }, callbacks, 'hydrate')
    return restored ? [restored] : []
  })

  const highestSessionNumber = terminalNodes.reduce((highest, node) => {
    const match = node.data.label.match(/ (\d+)$/)
    return Math.max(highest, match ? Number(match[1]) : 0)
  }, 0)

  // A file whose project is gone has no root to be read under, so it goes with the project; a
  // file that is merely missing from disk keeps its node, which reports that itself.
  const fileNodes = (state.files ?? []).flatMap<FileCanvasNode>((file) => {
    const project = projectsById.get(file.projectId)
    return project ? [createFileCanvasNode(file, project, callbacks)] : []
  })

  // A diff node reviews a checkout, so it goes with its worktree record (or its project) the
  // way a worktree's teardown removes it; a checkout that is merely dirty or gone from disk keeps
  // its node, which reports that itself.
  const diffNodes = (state.diffs ?? []).flatMap<DiffCanvasNode>((diff) => {
    const project = projectsById.get(diff.projectId)
    if (!project) return []
    const worktree = diff.worktreeId ? worktreesById.get(diff.worktreeId) : undefined
    if (diff.worktreeId && !worktree) return []
    return [createDiffCanvasNode(diff, project, worktree, callbacks)]
  })

  return {
    nodes: [...worktreeNodes, ...terminalNodes, ...fileNodes, ...diffNodes],
    statuses: Object.fromEntries(
      terminalNodes.map((node) => [node.id, node.data.dormant ? ('dormant' as const) : ('starting' as const)])
    ),
    nextSessionNumber: highestSessionNumber + 1,
    activeProjectId: state.projects.some((project) => project.id === state.activeProjectId)
      ? state.activeProjectId!
      : state.projects[0].id
  }
}
