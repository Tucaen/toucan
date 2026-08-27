import type { Node } from '@xyflow/react'
import type { AgentRateLimitStatus } from '../../shared/agent'
import type {
  AgentPermissionModes,
  ConversationPreview,
  TerminalLiveness,
  TerminalKind,
  WorkspaceState,
  WorkspaceTerminalNode
} from '../../shared/terminal'

export type TerminalNodeStatus = 'dormant' | 'starting' | 'idle' | 'working' | 'result' | 'attention' | 'stalled' | 'exited'

export interface TerminalNodeCallbacks {
  onStatusChange(nodeId: string, status: TerminalNodeStatus): void
  /** Optional so a persisted node restored before this callback existed still mounts. */
  onUsageChange?(nodeId: string, provider: TerminalKind, rateLimit: AgentRateLimitStatus | null): void
  onConversationId(nodeId: string, conversationId: string): void
  onPreview(nodeId: string, preview: ConversationPreview): void
  onWorklogCollapsed(nodeId: string, collapsed: boolean): void
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
  conversationId?: string
  preview?: ConversationPreview
  worklogCollapsed: boolean
  preferredPermissionMode?: string
  modelId?: string
  dormant: boolean
  launchMode: 'new' | 'resume'
}

export type TerminalCanvasNode = Node<TerminalNodeData, 'terminalNode'>

export interface RestoredCanvasWorkspace {
  nodes: TerminalCanvasNode[]
  statuses: Record<string, TerminalNodeStatus>
  nextSessionNumber: number
  activeProjectId: string
}

export function serializeCanvasNode(node: TerminalCanvasNode): WorkspaceTerminalNode {
  const styleWidth = typeof node.style?.width === 'number' ? node.style.width : 520
  const styleHeight = typeof node.style?.height === 'number' ? node.style.height : 340
  return {
    id: node.id,
    ...(node.data.kind === 'terminal' ? { sessionId: node.data.sessionId } : {}),
    kind: node.data.kind,
    label: node.data.label,
    projectId: node.data.projectId,
    position: node.position,
    width: node.measured?.width ?? styleWidth,
    height: node.measured?.height ?? styleHeight,
    ...(node.data.conversationId ? { conversationId: node.data.conversationId } : {}),
    ...(node.data.preview ? { preview: node.data.preview } : {}),
    ...(node.data.modelId ? { modelId: node.data.modelId } : {}),
    ...(node.data.kind === 'terminal' ? {} : { worklogCollapsed: node.data.worklogCollapsed }),
    ...(node.data.kind === 'terminal' ? { terminalLiveness: node.data.terminalLiveness } : {})
  }
}

export function restoreCanvasWorkspace(
  state: WorkspaceState,
  callbacks: TerminalNodeCallbacks
): RestoredCanvasWorkspace {
  const nodes = state.nodes.flatMap<TerminalCanvasNode>((savedNode) => {
    const project = state.projects.find((candidate) => candidate.id === savedNode.projectId)
    if (!project) return []
    // Loading an ACP conversation only replays its stored history; it does not send
    // a model prompt or consume tokens. Restore chat nodes live so their history is
    // visible immediately, while real terminal processes remain explicitly resumed.
    const dormant = savedNode.kind === 'terminal'
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
        conversationId: savedNode.conversationId,
        preview: savedNode.preview,
        worklogCollapsed: savedNode.worklogCollapsed ?? savedNode.kind !== 'terminal',
        preferredPermissionMode: savedNode.kind === 'terminal'
          ? undefined
          : state.agentPermissionModes?.[savedNode.kind],
        modelId: savedNode.kind === 'terminal' ? undefined : savedNode.modelId,
        dormant,
        launchMode: 'resume',
        ...callbacks
      },
      style: { width: savedNode.width, height: savedNode.height }
    }]
  })
  const highestSessionNumber = nodes.reduce((highest, node) => {
    const match = node.data.label.match(/ (\d+)$/)
    return Math.max(highest, match ? Number(match[1]) : 0)
  }, 0)

  return {
    nodes,
    statuses: Object.fromEntries(nodes.map((node) => [
      node.id,
      node.data.dormant ? 'dormant' as const : 'starting' as const
    ])),
    nextSessionNumber: highestSessionNumber + 1,
    activeProjectId: state.projects.some((project) => project.id === state.activeProjectId)
      ? state.activeProjectId!
      : state.projects[0].id
  }
}
