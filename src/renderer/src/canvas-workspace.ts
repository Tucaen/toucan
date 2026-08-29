import type { Node } from '@xyflow/react'
import type {
  AgentPermissionModes,
  ConversationPreview,
  TerminalLiveness,
  TerminalKind,
  WorkspaceState,
  WorkspaceTerminalNode
} from '../../shared/terminal'
import type { WorkspaceWorktree } from '../../shared/worktree'

export type TerminalNodeStatus = 'dormant' | 'starting' | 'idle' | 'working' | 'result' | 'attention' | 'stalled' | 'exited'

export interface TerminalNodeCallbacks {
  onStatusChange(nodeId: string, status: TerminalNodeStatus): void
  onConversationId(nodeId: string, conversationId: string): void
  onPreview(nodeId: string, preview: ConversationPreview): void
  onFocusModeChange(nodeId: string, enabled: boolean): void
  /** Persists unsent composer text so a draft outlives resize, collapse, and a workspace reload. */
  onDraftChange(nodeId: string, draft: string): void
  onPermissionModeChange(provider: keyof AgentPermissionModes, modeId: string): void
  onModelChange(nodeId: string, modelId: string): void
  onResume(nodeId: string): void
  onTerminalLiveness?(nodeId: string, liveness: TerminalLiveness): void
}

export interface TerminalNodeData extends Record<string, unknown>, TerminalNodeCallbacks {
  kind: TerminalKind
  sessionId: string
  terminalLiveness: TerminalLiveness
  label: string
  projectId: string
  projectName: string
  projectPath: string
  projectColor: string
  /** The worktree this node is attached to, if any. Attachment is fixed for the node's life. */
  worktreeId?: string
  /** Shown on the node so it is always obvious which branch a session is editing. */
  worktreeBranch?: string
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
    projectId: node.data.projectId,
    ...(node.data.worktreeId ? { worktreeId: node.data.worktreeId } : {}),
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
    const project = projectsById.get(savedNode.projectId)
    if (!project) return []
    const worktree = savedNode.worktreeId ? worktreesById.get(savedNode.worktreeId) : undefined
    // A node whose worktree record vanished must never quietly fall back to the project
    // checkout and start writing there, so it restores detached and dormant instead.
    const detachedFromWorktree = Boolean(savedNode.worktreeId) && !worktree
    // Loading an ACP conversation only replays its stored history; it does not send
    // a model prompt or consume tokens. Restore chat nodes live so their history is
    // visible immediately, while real terminal processes remain explicitly resumed.
    const dormant = savedNode.kind === 'terminal' || detachedFromWorktree
    const terminalLiveness: TerminalLiveness = savedNode.kind === 'terminal'
      ? savedNode.terminalLiveness === 'exited' ? 'exited' : 'unverifiable'
      : 'live'
    return [{
      id: savedNode.id,
      type: 'terminalNode',
      position: savedNode.position,
      data: {
        kind: savedNode.kind,
        sessionId: savedNode.sessionId ?? savedNode.id,
        terminalLiveness,
        label: savedNode.label,
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        projectColor: project.color,
        worktreeId: worktree?.id,
        worktreeBranch: worktree?.branch,
        workingDirectory: worktree?.path ?? project.path,
        detachedFromWorktree,
        conversationId: savedNode.conversationId,
        preview: savedNode.preview,
        focusMode: savedNode.focusMode ?? savedNode.worklogCollapsed ?? savedNode.kind !== 'terminal',
        draft: savedNode.draft,
        preferredPermissionMode: savedNode.kind === 'terminal'
          ? undefined
          : state.agentPermissionModes?.[savedNode.kind],
        modelId: savedNode.kind === 'terminal' ? undefined : savedNode.modelId,
        dormant,
        launchMode: 'resume',
        onStatusChange: callbacks.onStatusChange,
        onConversationId: callbacks.onConversationId,
        onPreview: callbacks.onPreview,
        onFocusModeChange: callbacks.onFocusModeChange,
        onDraftChange: callbacks.onDraftChange,
        onPermissionModeChange: callbacks.onPermissionModeChange,
        onModelChange: callbacks.onModelChange,
        onResume: callbacks.onResume,
        onTerminalLiveness: callbacks.onTerminalLiveness
      },
      style: { width: savedNode.width, height: savedNode.height }
    }]
  })

  const highestSessionNumber = terminalNodes.reduce((highest, node) => {
    const match = node.data.label.match(/ (\d+)$/)
    return Math.max(highest, match ? Number(match[1]) : 0)
  }, 0)

  return {
    nodes: [...worktreeNodes, ...terminalNodes],
    statuses: Object.fromEntries(terminalNodes.map((node) => [
      node.id,
      node.data.dormant ? 'dormant' as const : 'starting' as const
    ])),
    nextSessionNumber: highestSessionNumber + 1,
    activeProjectId: state.projects.some((project) => project.id === state.activeProjectId)
      ? state.activeProjectId!
      : state.projects[0].id
  }
}
