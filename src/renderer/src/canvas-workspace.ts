import type { Node } from '@xyflow/react'
import type {
  ConversationPreview,
  TerminalKind,
  WorkspaceState,
  WorkspaceTerminalNode
} from '../../shared/terminal'

export type TerminalNodeStatus = 'dormant' | 'starting' | 'running' | 'attention' | 'exited'

export interface TerminalNodeCallbacks {
  onStatusChange(nodeId: string, status: TerminalNodeStatus): void
  onConversationId(nodeId: string, conversationId: string): void
  onPreview(nodeId: string, preview: ConversationPreview): void
  onResume(nodeId: string): void
}

export interface TerminalNodeData extends Record<string, unknown>, TerminalNodeCallbacks {
  kind: TerminalKind
  label: string
  projectId: string
  projectName: string
  projectPath: string
  projectColor: string
  conversationId?: string
  preview?: ConversationPreview
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
    kind: node.data.kind,
    label: node.data.label,
    projectId: node.data.projectId,
    position: node.position,
    width: node.measured?.width ?? styleWidth,
    height: node.measured?.height ?? styleHeight,
    ...(node.data.conversationId ? { conversationId: node.data.conversationId } : {}),
    ...(node.data.preview ? { preview: node.data.preview } : {})
  }
}

export function restoreCanvasWorkspace(
  state: WorkspaceState,
  callbacks: TerminalNodeCallbacks
): RestoredCanvasWorkspace {
  const nodes = state.nodes.flatMap<TerminalCanvasNode>((savedNode) => {
    const project = state.projects.find((candidate) => candidate.id === savedNode.projectId)
    if (!project) return []
    return [{
      id: savedNode.id,
      type: 'terminalNode',
      position: savedNode.position,
      data: {
        kind: savedNode.kind,
        label: savedNode.label,
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        projectColor: project.color,
        conversationId: savedNode.conversationId,
        preview: savedNode.preview,
        dormant: true,
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
    statuses: Object.fromEntries(nodes.map((node) => [node.id, 'dormant' as TerminalNodeStatus])),
    nextSessionNumber: highestSessionNumber + 1,
    activeProjectId: state.projects.some((project) => project.id === state.activeProjectId)
      ? state.activeProjectId!
      : state.projects[0].id
  }
}
