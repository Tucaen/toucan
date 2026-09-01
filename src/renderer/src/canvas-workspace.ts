import type { Node } from '@xyflow/react'
import type { AttentionAction, AttentionKind } from '../../shared/attention'
import type {
  AgentPermissionModes,
  ConversationPreview,
  TerminalLiveness,
  TerminalKind,
  WorkspaceState,
  WorkspaceTerminalNode
} from '../../shared/terminal'
import { RECENTLY_CLOSED_SESSION_LIMIT } from '../../shared/terminal'
import type { WorkspaceWorktree } from '../../shared/worktree'
import type { WorktreeHandoffPlan } from '../../shared/worktree-handoff'
import type { ConversationTitleSource } from '../../shared/conversation-title'

export type TerminalNodeStatus =
  'dormant' | 'starting' | 'idle' | 'working' | 'result' | 'attention' | 'stalled' | 'exited'

/** What a node reports about its own attention; the reducer that consumes it lives in shared/attention.ts. */
export type NodeAttentionAction = AttentionAction

export interface TerminalNodeCallbacks {
  onStatusChange(nodeId: string, status: TerminalNodeStatus): void
  /**
   * The single channel every surface uses to report or clear attention. Optional so a node can
   * be rendered in isolation (tests, storybook-style harnesses) without a workspace behind it.
   */
  onAttention?(action: NodeAttentionAction): void
  onConversationId(nodeId: string, conversationId: string): void
  onTitleChange(nodeId: string, title: string, source: ConversationTitleSource): Promise<boolean>
  onPreview(nodeId: string, preview: ConversationPreview): void
  onFocusModeChange(nodeId: string, enabled: boolean): void
  /** Persists unsent composer text so a draft outlives resize, collapse, and a workspace reload. */
  onDraftChange(nodeId: string, draft: string): void
  onPermissionModeChange(provider: keyof AgentPermissionModes, modeId: string): void
  onModelChange(nodeId: string, modelId: string): void
  onResume(nodeId: string): void
  onTerminalLiveness?(nodeId: string, liveness: TerminalLiveness): void
  /**
   * A prompt that asked for its own worktree. The composer hands it up rather than dispatching
   * it, so the work starts in a session whose working directory is the worktree from its first
   * turn - which is the only way it can be granted as a writable root.
   */
  onWorktreeHandoff?(nodeId: string, request: WorktreeHandoffPlan): void
}

export interface TerminalNodeData extends Record<string, unknown>, TerminalNodeCallbacks {
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
}

export interface WorktreeNodeData extends Record<string, unknown>, WorktreeNodeCallbacks {
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

export type TerminalCanvasNode = Node<TerminalNodeData, 'terminalNode'>
export type WorktreeCanvasNode = Node<WorktreeNodeData, 'worktreeNode'>
export type CanvasNode = TerminalCanvasNode | WorktreeCanvasNode

/** Enough accidental closes to be useful without letting a workspace snapshot grow forever. */
export const CLOSED_SESSION_STACK_LIMIT = RECENTLY_CLOSED_SESSION_LIMIT

interface ClosedSessionShortcutKey {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

export function closedSessionKeyAction(event: ClosedSessionShortcutKey, hasClosedSession: boolean): 'reopen' | 'none' {
  return hasClosedSession &&
    event.key.toLocaleLowerCase() === 't' &&
    event.ctrlKey &&
    event.shiftKey &&
    !event.altKey &&
    !event.metaKey
    ? 'reopen'
    : 'none'
}

export function isTerminalCanvasNode(node: CanvasNode): node is TerminalCanvasNode {
  return node.type === 'terminalNode'
}

export function isWorktreeCanvasNode(node: CanvasNode): node is WorktreeCanvasNode {
  return node.type === 'worktreeNode'
}

export interface RestoredCanvasWorkspace {
  nodes: CanvasNode[]
  statuses: Record<string, TerminalNodeStatus>
  nextSessionNumber: number
  activeProjectId: string
}

const DEFAULT_TERMINAL_SIZE = { width: 520, height: 340 }
export const DEFAULT_WORKTREE_SIZE = { width: 360, height: 232 }

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
      dormant,
      launchMode: 'resume',
      onStatusChange: callbacks.onStatusChange,
      onAttention: callbacks.onAttention,
      onConversationId: callbacks.onConversationId,
      onTitleChange: callbacks.onTitleChange,
      onPreview: callbacks.onPreview,
      onFocusModeChange: callbacks.onFocusModeChange,
      onDraftChange: callbacks.onDraftChange,
      onPermissionModeChange: callbacks.onPermissionModeChange,
      onModelChange: callbacks.onModelChange,
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

export function restoreCanvasWorkspace(
  state: WorkspaceState,
  callbacks: TerminalNodeCallbacks & WorktreeNodeCallbacks
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
        onRunSetupCommand: callbacks.onRunSetupCommand
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

  return {
    nodes: [...worktreeNodes, ...terminalNodes],
    statuses: Object.fromEntries(
      terminalNodes.map((node) => [node.id, node.data.dormant ? ('dormant' as const) : ('starting' as const)])
    ),
    nextSessionNumber: highestSessionNumber + 1,
    activeProjectId: state.projects.some((project) => project.id === state.activeProjectId)
      ? state.activeProjectId!
      : state.projects[0].id
  }
}
