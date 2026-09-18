import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStore,
  type Connection,
  type Edge,
  type IsValidConnection,
  type NodeChange,
  type NodeTypes
} from '@xyflow/react'
import {
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  FileText,
  FolderPlus,
  GitBranch,
  GitCompare,
  GripVertical,
  History,
  LayoutGrid,
  Maximize,
  Plus,
  Settings,
  Smartphone,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { AGENT_TURN_OUTCOME_LIMIT, type AgentTurnOutcome } from '../../shared/agent'
import type { ConversationSummary } from '../../shared/conversation'
import { normalizeConversationTitle, type ConversationTitleSource } from '../../shared/conversation-title'
import { paletteColorAt } from '../../shared/project-colors'
import { terminalRunInput } from '../../shared/project-run-commands'
import type {
  AgentPermissionModes,
  BrainDumpPanelState,
  ComposerSendKey,
  ConversationLineage,
  ConversationPreview,
  ProjectDirectory,
  ProjectGroup,
  TerminalKind,
  TerminalLiveness,
  TicketBoardPanelState,
  WorkspaceLayoutSlot,
  WorkspaceProject,
  WorkspaceState,
  WorkspaceTerminalNode
} from '../../shared/terminal'
import type { WorktreeRemovalBlocker } from '../../shared/worktree'
import { worktreePathKey } from '../../shared/worktree'
import type { FileViewMode } from '../../shared/file-view'
import { pathIdentity } from '../../shared/paths'
import toucanLogo from './assets/toucan-logo.svg'
import { placeholderBranchName, type WorktreeHandoffPlan } from '../../shared/worktree-handoff'
import {
  BRAIN_DUMP_PANEL_DEFAULT_WIDTH,
  brainDumpPanelKeyAction,
  clampBrainDumpPanelWidth
} from './brain-dump-panel-layout'
import BrainDumpLibraryPanel from './BrainDumpLibraryPanel'
import {
  TICKET_BOARD_DEFAULT_WIDTH,
  clampTicketBoardWidth,
  pruneEnabledSources,
  ticketBoardKeyAction
} from './ticket-board-layout'
import { ticketSessionsFromNodes, type TicketActivityReport } from './ticket-activity'
import { createTicketFileSource } from './ticket-file-source'
import { createTicketGithubSource } from './ticket-github-source'
import TicketBoardPanel from './TicketBoardPanel'
import {
  closedSessionKeyAction,
  createNodeKeyAction,
  type CreateNodeKeyAction,
  CREATE_NODE_ACTIONS,
  NODE_SHORTCUT_LABELS,
  changeFileCanvasNodePath,
  createDiffCanvasNode,
  createFileCanvasNode,
  createWorktreeCanvasNode,
  DEFAULT_WORKTREE_SIZE,
  NEW_NODE_SIZE,
  NEW_SESSION_NODE_SIZE,
  centredNodePosition,
  isDiffCanvasNode,
  isChatCanvasNode,
  isFileCanvasNode,
  isTerminalCanvasNode,
  isWorktreeCanvasNode,
  NODE_DRAG_HANDLE,
  rememberClosedSessionNodes,
  reopenClosedSession,
  restoreCanvasWorkspace,
  selectDiffCanvasNodePath,
  serializeCanvasNodes,
  serializeWorktreeNode,
  sessionNodeStatus,
  withoutWorktree,
  withProjectColor,
  cascadedNodePosition,
  type CanvasNode,
  type TerminalCanvasNode,
  type TerminalNodeCallbacks,
  type TerminalNodeStatus,
  type WorktreeCanvasNode,
  type WorktreeNodeCallbacks
} from './canvas-workspace'
import {
  adoptTerminalContext,
  isValidTerminalContextConnection,
  mirroredTerminalContextEdges,
  planTerminalContextAdoptions,
  withTerminalContextEdge,
  withoutEdgesTouchingNodes
} from './terminal-context-edges'
import {
  branchBlockedReason,
  launchModeAfterConversation,
  lineageEdges,
  lineageKey,
  lineageOf,
  offersBranchAction
} from './conversation-lineage'
import { COMPOSER_SEND_KEY_DEFAULT } from './composer-keys'
import { ComposerSendKeyContext } from './composer-send-key-context'
import { RoutineDelegationContext } from './routine-delegation-context'
import type { RoutineDelegationPreference } from '../../shared/routine-delegation'
import { AppUpdateChip } from './AppUpdateChip'
import { useAppUpdate } from './use-app-update'
import { RemoteAccessDialog } from './RemoteAccessDialog'
import { AdapterManagementDialog } from './AdapterManagementDialog'
import { useRemoteAccess } from './use-remote-access'
import type { RemoteChatSpawnRequest, RemoteChatSpawnResult } from '../../shared/remote-spawn'
import ConversationHistoryDialog from './ConversationHistoryDialog'
import FileNode from './FileNode'
import DiffNode from './DiffNode'
import FilePickerDialog from './FilePickerDialog'
import { OpenFileContext } from './open-file-context'
import { projectOwningPath, workspaceRootOwningPath } from './file-node'
import {
  groupDropTarget,
  moveGroup,
  moveProject,
  nextGroupName,
  projectDropTarget,
  sidebarRegions,
  ungroupProjects,
  type MeasuredRow
} from './project-order'
import ProjectRowMenu, { type ProjectMenuPage, type ProjectMenuTarget } from './ProjectRowMenu'
import ProjectBranchChip from './ProjectBranchChip'
import type { GitCheckoutResult } from '../../shared/git-branch'
import { ProviderRateLimitsContext } from './provider-rate-limits'
import { ProviderUsageChip } from './ProviderUsageChip'
import SessionKindIcon from './SessionKindIcon'
import SessionNode from './SessionNode'
import { terminalLivenessLabels } from './terminal-liveness'
import { SidebarTerminalLiveness } from './TerminalLivenessPresentation'
import { useProviderRateLimits } from './use-provider-rate-limits'
import { READ_ON_VIEW_KINDS } from '../../shared/attention'
import { useWorkspaceAttention } from './workspace-attention'
import { ticketsDirectoryOrDefault } from '../../shared/tickets'
import { useWorkspacePersistence } from './workspace-persistence'
import {
  ProjectSettingsDialog,
  projectSettingsTitle,
  WorktreeCreateDialog,
  WorktreeRemoveDialog,
  type ProjectSettingsDraft,
  type WorktreeDraft,
  type WorktreeRemovalPrompt
} from './WorkspaceDialogs'
import { planWorktreeRemoval } from './worktree-removal'
import {
  adoptClaimedWorktrees,
  applyAttachedNodeCounts,
  applyWorktreeClaims,
  registerWorktreeNode,
  reconcileStaleWorktrees
} from './worktree-attachment'
import WorktreeNode from './WorktreeNode'
import {
  LAYOUT_SHORTCUT_LABELS,
  applyLayoutSlot,
  captureLayoutSlot,
  layoutKeyAction,
  matchNodeSizes,
  nextTileMode,
  pruneLayoutSlots,
  tileNodes,
  type LayoutKeyAction,
  type TileMode
} from './canvas-layout'
import { NODE_FIT_INSET, canvasRegion, nodeBeforeTemporaryFit, viewportShowingNode } from './node-snap'
import { NodeFitContext } from './node-fit-context'
import { nodeSearchKeyAction } from './node-search'
import { NodeSearchContext, NO_NODE_SEARCH_REQUEST, type NodeSearchRequest } from './node-search-context'
import { useNodeSnap } from './use-node-snap'
import { useProjectAvatars } from './use-project-avatars'
import { ProjectAvatar } from './ProjectAvatar'

type Project = WorkspaceProject

interface ContextMenuState {
  clientX: number
  clientY: number
  flowX: number
  flowY: number
}

type FilePickerRequest =
  | {
      kind: 'create'
      projectId: string
      projectName: string
      root: string
      position: { x: number; y: number }
    }
  | {
      kind: 'change'
      projectName: string
      root: string
    }

/** How often Toucan re-checks git for worktrees it has no record of. */
const WORKTREE_SWEEP_INTERVAL_MS = 15000

const nodeTypes: NodeTypes = {
  terminalNode: SessionNode,
  worktreeNode: WorktreeNode,
  fileNode: FileNode,
  diffNode: DiffNode
}

const SESSION_KIND_BY_ACTION = {
  'create-terminal': 'terminal',
  'create-claude': 'claude',
  'create-codex': 'codex'
} as const

/**
 * How the context menu draws each create action. Kept beside the menu rather than in
 * `CREATE_NODE_ACTIONS` because that table has to stay a pure module the non-DOM test runner can
 * import; everything else about an action - its shortcut, its wording, its size - lives there.
 */
const CREATE_ACTION_ICONS: Record<Exclude<CreateNodeKeyAction, 'none'>, { className: string; icon: JSX.Element }> = {
  'create-terminal': { className: 'terminal-icon', icon: <SessionKindIcon kind="terminal" /> },
  'create-claude': { className: 'claude-icon', icon: <SessionKindIcon kind="claude" /> },
  'create-codex': { className: 'codex-icon', icon: <SessionKindIcon kind="codex" /> },
  'create-worktree': { className: 'worktree-icon', icon: <GitBranch aria-hidden="true" /> },
  'open-history': { className: 'history-icon', icon: <History aria-hidden="true" /> },
  'open-file': { className: 'file-icon', icon: <FileText aria-hidden="true" /> },
  'open-diff': { className: 'diff-icon', icon: <GitCompare aria-hidden="true" /> }
}

const labels: Record<TerminalKind, string> = {
  terminal: 'Terminal',
  claude: 'Claude Code',
  codex: 'Codex'
}

const statusLabels: Record<TerminalNodeStatus, string> = {
  dormant: 'Saved',
  starting: 'Starting',
  idle: 'Idle',
  working: 'Working',
  result: 'Result',
  attention: 'Attention',
  stalled: 'Stalled',
  exited: terminalLivenessLabels.exited
}

function createProject(directory: ProjectDirectory, index: number): Project {
  return {
    ...directory,
    id: crypto.randomUUID(),
    color: paletteColorAt(index)
  }
}

/**
 * Today in the user's own calendar. The brain-dump library records local calendar days, so a UTC
 * date would read "yesterday" all evening for anyone west of Greenwich.
 */
function localCalendarDate(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${`${now.getDate()}`.padStart(2, '0')}`
}

function worktreeRemovalErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The worktree could not be removed.'
}

/** Drops the named node ids from a per-node record - closing a node and spending an adoption share it. */
function withoutNodeKeys<Value>(record: Record<string, Value>, nodeIds: ReadonlySet<string>): Record<string, Value> {
  return Object.fromEntries(Object.entries(record).filter(([nodeId]) => !nodeIds.has(nodeId)))
}

function Canvas(): JSX.Element {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([])
  // Terminal-context edges: runtime-only React state on purpose, never `WorkspaceState` - closing
  // either node removes the edge and a restart starts with none (decision 2 in
  // docs/plans/terminal-context-edge.md). Main's registry mirrors this set; see the effect below.
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  // Whether each chat node's *live session* was created with the terminal-context read tool - the
  // launch-time truth off `AgentCreateResult.terminalContext`. Compared against the live edge set
  // to decide when a session must restart to adopt an edge drawn onto it mid-conversation.
  const [terminalContextSessions, setTerminalContextSessions] = useState<Record<string, boolean>>({})
  const [projects, setProjects] = useState<Project[]>([])
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([])
  const [nodeStatuses, setNodeStatuses] = useState<Record<string, TerminalNodeStatus>>({})
  const [ticketActivity, setTicketActivity] = useState<Record<string, TicketActivityReport>>({})
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [agentPermissionModes, setAgentPermissionModes] = useState<AgentPermissionModes>({})
  const [composerSendKey, setComposerSendKey] = useState<ComposerSendKey>(COMPOSER_SEND_KEY_DEFAULT)
  const [routineDelegation, setRoutineDelegation] = useState<RoutineDelegationPreference>({ enabled: false })
  const [recentlyClosedNodes, setRecentlyClosedNodes] = useState<WorkspaceTerminalNode[]>([])
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [worktreeDraft, setWorktreeDraft] = useState<WorktreeDraft | null>(null)
  const [removalPrompt, setRemovalPrompt] = useState<WorktreeRemovalPrompt | null>(null)
  const [setupProjectId, setSetupProjectId] = useState<string | null>(null)
  // The sidebar's own right-click menu, positioned at the pointer like the canvas one.
  const [projectMenu, setProjectMenu] = useState<{
    x: number
    y: number
    target: ProjectMenuTarget
    page?: ProjectMenuPage
  } | null>(null)
  // Bumped after Toucan itself checks a branch out, so the sidebar rows re-read at once instead of
  // waiting out their poll interval. Node chips keep polling; they catch up within seconds.
  const [branchRevision, setBranchRevision] = useState(0)
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null)
  // Where a conversation picked from the history browser lands, captured when the browser opens
  // so the node still appears where the user right-clicked.
  const [historyDrop, setHistoryDrop] = useState<{ x: number; y: number } | null>(null)
  /** Whether the picker will create a node or return a new path to an existing file node. */
  const [filePickerRequest, setFilePickerRequest] = useState<FilePickerRequest | null>(null)
  const filePickerResolver = useRef<((path: string | null) => void) | null>(null)
  // The brain-dump library is global rather than per-project, so the workspace owns its persisted
  // panel state and the panel itself only renders it.
  const [brainDumpPanel, setBrainDumpPanel] = useState<BrainDumpPanelState>({
    open: false,
    width: BRAIN_DUMP_PANEL_DEFAULT_WIDTH
  })
  const [brainDumpMounted, setBrainDumpMounted] = useState(false)
  // The board is a projection of the active project's files, so the workspace persists only where
  // the panel sits; everything it shows is re-read from disk.
  const [ticketBoardPanel, setTicketBoardPanel] = useState<TicketBoardPanelState>({
    open: false,
    width: TICKET_BOARD_DEFAULT_WIDTH
  })
  const [ticketBoardMounted, setTicketBoardMounted] = useState(false)
  // Built once, in board order: the files in the checkout are always on, GitHub is offered per
  // project. A further tracker is another entry here and nothing else above the seam.
  const ticketSources = useMemo(
    () => [
      createTicketFileSource(window.ticketsApi),
      createTicketGithubSource(window.githubIssuesApi, (url) => void window.terminalApi.openExternal(url))
    ],
    []
  )
  const [workspaceWidth, setWorkspaceWidth] = useState(() => window.innerWidth)
  const { fitView, getViewport, screenToFlowPosition, setViewport, zoomIn, zoomOut, zoomTo } = useReactFlow()
  // Selecting the scalar rather than the whole transform keeps the sidebar out of every pan frame:
  // panning changes transform[0]/[1] on each pointer move, and only the zoom readout needs to react.
  const canvasZoom = useStore((state) => state.transform[2])
  const canvasRegionRef = useRef<HTMLElement>(null)
  const nextSessionNumber = useRef(1)

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? projects[0],
    [activeProjectId, projects]
  )
  const activeWorktreeDraftProject = useMemo(
    () => projects.find((project) => project.id === worktreeDraft?.projectId),
    [projects, worktreeDraft]
  )
  const setupProject = useMemo(
    () => projects.find((project) => project.id === setupProjectId),
    [projects, setupProjectId]
  )
  const projectAvatars = useProjectAvatars(projects)
  // A refused avatar pick, shown inside the settings dialog it happened in; cleared on open/close.
  const [avatarError, setAvatarError] = useState<string | null>(null)

  const {
    records: attention,
    unreadByNode,
    unreadTotal,
    count: countUnread,
    describe: describeUnread,
    report: handleAttention,
    forget: forgetNodeAttention,
    restore: restoreAttention
  } = useWorkspaceAttention(setNodes)

  // A global, always-visible read on the whole workspace: no need to open a node to see
  // whether anything is still busy or looks stuck.
  const statusSummary = useMemo(() => {
    let working = 0
    let stalled = 0
    for (const status of Object.values(nodeStatuses)) {
      if (status === 'working') working += 1
      else if (status === 'stalled') stalled += 1
    }
    return { working, stalled }
  }, [nodeStatuses])

  const providerRateLimits = useProviderRateLimits()

  const handleStatusChange = useCallback((nodeId: string, status: TerminalNodeStatus): void => {
    setNodeStatuses((current) => {
      if (current[nodeId] === status) return current
      return { ...current, [nodeId]: status }
    })
  }, [])

  /**
   * Which files each session has been writing, reported by the node itself. Session-local: what a
   * chat is doing right now is not worth persisting, and a restored workspace has no turns in
   * flight to describe. The board reads it through `ticketSessionsByCard`, which is the only place
   * that decides whether a written path is a ticket.
   */
  const handleTicketActivity = useCallback((nodeId: string, report: TicketActivityReport): void => {
    setTicketActivity((current) => ({ ...current, [nodeId]: report }))
  }, [])

  /** Every session-node update funnels through here so worktree nodes are never mistaken for one. */
  const patchTerminalNode = useCallback(
    (nodeId: string, patch: (data: TerminalCanvasNode['data']) => Partial<TerminalCanvasNode['data']>): void => {
      setNodes((current) =>
        current.map((node) =>
          isTerminalCanvasNode(node) && node.id === nodeId
            ? { ...node, data: { ...node.data, ...patch(node.data) } }
            : node
        )
      )
    },
    [setNodes]
  )

  const handleConversationId = useCallback(
    (nodeId: string, conversationId: string): void => {
      patchTerminalNode(nodeId, (data) => {
        if (data.kind !== 'terminal' && data.launchMode === 'new' && data.titleSource) {
          void window.conversationApi
            .setTitle(data.kind, conversationId, data.label, data.titleSource)
            .catch(() => undefined)
        }
        // A fork is a one-shot launch; `launchModeAfterConversation` says what it settles into.
        return { conversationId, launchMode: launchModeAfterConversation(data.launchMode) }
      })
    },
    [patchTerminalNode]
  )

  const handleTitleChange = useCallback(
    async (nodeId: string, title: string, source: ConversationTitleSource): Promise<boolean> => {
      const normalized = normalizeConversationTitle(title)
      if (!normalized) return false
      const node = nodesRef.current.find((candidate) => isTerminalCanvasNode(candidate) && candidate.id === nodeId)
      if (!node || (node.data.kind !== 'claude' && node.data.kind !== 'codex')) return false
      const provider = node.data.kind
      const conversationId = typeof node.data.conversationId === 'string' ? node.data.conversationId : undefined
      if (conversationId) {
        try {
          const stored = await window.conversationApi.setTitle(provider, conversationId, normalized, source)
          if (!stored) return false
          patchTerminalNode(nodeId, () => ({ label: stored.title, titleSource: stored.source }))
          return true
        } catch {
          return false
        }
      }
      patchTerminalNode(nodeId, () => ({ label: normalized, titleSource: source }))
      return true
    },
    [patchTerminalNode]
  )

  // Launch-time truth about the adapter, kept on the node so the Branch action still knows the
  // answer once the session it came from is dormant or gone.
  const handleForkSupport = useCallback(
    (nodeId: string, supported: boolean): void => {
      patchTerminalNode(nodeId, () => ({ forkSupport: supported }))
    },
    [patchTerminalNode]
  )

  const handleTerminalContext = useCallback((nodeId: string, carried: boolean): void => {
    setTerminalContextSessions((current) => (current[nodeId] === carried ? current : { ...current, [nodeId]: carried }))
  }, [])

  const handleTerminalLiveness = useCallback(
    (nodeId: string, liveness: TerminalLiveness): void => {
      patchTerminalNode(nodeId, () => ({ terminalLiveness: liveness }))
    },
    [patchTerminalNode]
  )

  const handlePreview = useCallback(
    (nodeId: string, preview: ConversationPreview): void => {
      patchTerminalNode(nodeId, (data) => ({
        preview: {
          ...data.preview,
          ...preview,
          user: preview.user ?? data.preview?.user,
          assistant: preview.assistant ?? data.preview?.assistant
        }
      }))
    },
    [patchTerminalNode]
  )

  const handleFocusModeChange = useCallback(
    (nodeId: string, enabled: boolean): void => {
      patchTerminalNode(nodeId, () => ({ focusMode: enabled }))
    },
    [patchTerminalNode]
  )

  // A draft belongs to its node, so it is patched in like any other node state and rides the
  // ordinary workspace autosave out to disk.
  const handleDraftChange = useCallback(
    (nodeId: string, draft: string): void => {
      patchTerminalNode(nodeId, (data) => (data.draft === draft ? {} : { draft }))
    },
    [patchTerminalNode]
  )

  const handleFileViewModeChange = useCallback(
    (nodeId: string, view: FileViewMode): void => {
      setNodes((current) =>
        current.map((node) =>
          isFileCanvasNode(node) && node.id === nodeId && node.data.view !== view
            ? { ...node, data: { ...node.data, view } }
            : node
        )
      )
    },
    [setNodes]
  )

  const handleFilePathChange = useCallback(
    (nodeId: string, path: string): void => setNodes((current) => changeFileCanvasNodePath(current, nodeId, path)),
    [setNodes]
  )

  const handleSelectDiffPath = useCallback(
    (nodeId: string, path: string | undefined): void =>
      setNodes((current) => selectDiffCanvasNodePath(current, nodeId, path)),
    [setNodes]
  )

  const handlePermissionModeChange = useCallback(
    (provider: keyof AgentPermissionModes, modeId: string): void => {
      setAgentPermissionModes((current) =>
        current[provider] === modeId ? current : { ...current, [provider]: modeId }
      )
      setNodes((current) =>
        current.map((node) =>
          isTerminalCanvasNode(node) && node.data.dormant && node.data.kind === provider
            ? { ...node, data: { ...node.data, preferredPermissionMode: modeId } }
            : node
        )
      )
    },
    [setNodes]
  )

  // A model choice belongs to its conversation, so it is remembered per node rather than per provider.
  const handleModelChange = useCallback(
    (nodeId: string, modelId: string): void => {
      patchTerminalNode(nodeId, () => ({ modelId }))
    },
    [patchTerminalNode]
  )

  const handleTurnOutcome = useCallback(
    (nodeId: string, outcome: AgentTurnOutcome): void => {
      patchTerminalNode(nodeId, (data) => {
        if (data.turnOutcomes?.some((candidate) => candidate.id === outcome.id)) return {}
        return { turnOutcomes: [...(data.turnOutcomes ?? []), outcome].slice(-AGENT_TURN_OUTCOME_LIMIT) }
      })
    },
    [patchTerminalNode]
  )

  const resumeNode = useCallback(
    (nodeId: string): void => {
      setNodes((current) =>
        current.map((node) => {
          if (!isTerminalCanvasNode(node)) return node
          if (node.id !== nodeId) return { ...node, selected: false }
          return {
            ...node,
            selected: true,
            data: {
              ...node.data,
              dormant: false,
              // Resuming a detached node is the user knowingly accepting the project checkout,
              // so the badge stops warning about a worktree that no longer exists.
              detachedFromWorktree: false,
              launchMode: node.data.kind === 'terminal' || node.data.conversationId ? 'resume' : 'new'
            }
          }
        })
      )
      setNodeStatuses((current) => ({ ...current, [nodeId]: 'starting' }))
    },
    [setNodes]
  )

  // Node-data callbacks must keep a stable identity or every worktree node re-renders on each
  // canvas change, so they read the latest workspace through refs instead of dependencies.
  const nodesRef = useRef<CanvasNode[]>([])
  const nodeStatusesRef = useRef<Record<string, TerminalNodeStatus>>({})
  const projectsRef = useRef<Project[]>([])
  const permissionModesRef = useRef<AgentPermissionModes>({})
  const recentlyClosedNodesRef = useRef<WorkspaceTerminalNode[]>([])
  const brainDumpOpenRef = useRef(false)
  const ticketBoardOpenRef = useRef(false)
  // Held in a ref because the handler is declared after the node factories that hand it out,
  // and because a node's stored callback must not go stale as the handler is recreated.
  const handleWorktreeHandoffRef = useRef<TerminalNodeCallbacks['onWorktreeHandoff']>(undefined)
  /** Stable identity for node data; reads the ref at call time so it can never go stale. */
  const dispatchWorktreeHandoff = useCallback<NonNullable<TerminalNodeCallbacks['onWorktreeHandoff']>>(
    (nodeId, request) => handleWorktreeHandoffRef.current?.(nodeId, request),
    []
  )
  // Branching places a node, so its handler is built on `addSessionNode` further down; same ref
  // indirection, for the same two reasons.
  const handleBranchRef = useRef<TerminalNodeCallbacks['onBranch']>(undefined)
  const dispatchBranch = useCallback<NonNullable<TerminalNodeCallbacks['onBranch']>>(
    (nodeId) => handleBranchRef.current?.(nodeId),
    []
  )
  nodesRef.current = nodes
  nodeStatusesRef.current = nodeStatuses
  projectsRef.current = projects
  permissionModesRef.current = agentPermissionModes
  recentlyClosedNodesRef.current = recentlyClosedNodes
  brainDumpOpenRef.current = brainDumpPanel.open
  ticketBoardOpenRef.current = ticketBoardPanel.open

  const handleRequestFilePath = useCallback((nodeId: string): Promise<string | null> => {
    if (filePickerResolver.current) return Promise.resolve(null)
    const node = nodesRef.current.filter(isFileCanvasNode).find((candidate) => candidate.id === nodeId)
    const project = projectsRef.current.find((candidate) => candidate.id === node?.data.projectId)
    if (!node || !project) return Promise.resolve(null)

    const projectWorktrees = nodesRef.current
      .filter(isWorktreeCanvasNode)
      .filter((candidate) => candidate.data.projectId === project.id)
    const owner = workspaceRootOwningPath(node.data.path, [
      { projectId: project.id, root: project.path },
      ...projectWorktrees.map((candidate) => ({ projectId: project.id, root: candidate.data.path }))
    ])
    const root = owner?.root ?? project.path
    const worktree = projectWorktrees.find((candidate) => pathIdentity(candidate.data.path) === pathIdentity(root))

    return new Promise((resolve) => {
      filePickerResolver.current = resolve
      setFilePickerRequest({
        kind: 'change',
        projectName: worktree ? `${project.name} · ${worktree.data.branch}` : project.name,
        root
      })
    })
  }, [])

  const getCanvasNodes = useCallback((): CanvasNode[] => nodesRef.current, [])
  const nodeFit = useNodeSnap<CanvasNode>({
    canvasRef: canvasRegionRef,
    getNodes: getCanvasNodes,
    getViewport,
    setNodes
  })
  // Which layout the next tile produces. Session-local: it is a cycle position, not a preference.
  const [tileMode, setTileMode] = useState<TileMode>('grid')
  const [layoutSlots, setLayoutSlots] = useState<Record<string, WorkspaceLayoutSlot>>({})
  const [nodeSearchRequest, setNodeSearchRequest] = useState<NodeSearchRequest>(NO_NODE_SEARCH_REQUEST)

  /** The visible canvas in flow coordinates, or null before the region has laid out. */
  const visibleCanvasRegion = useCallback(() => {
    const canvas = canvasRegionRef.current?.getBoundingClientRect()
    return canvas ? canvasRegion(canvas, getViewport(), NODE_FIT_INSET) : null
  }, [getViewport])

  /**
   * Where a node lands when nothing pointed at a spot for it - a keyboard shortcut, a phone
   * spawning a chat, an "Open" on a transcript card. It is centred in the visible canvas and then
   * cascaded clear of whatever is already there, so a run of spawns fans out instead of stacking.
   *
   * The canvas region rather than the window is what the node has to fit into: the sidebar, the
   * header and the docked panels all take room a window measurement would count as canvas, and
   * measuring the window put new nodes off centre by half of that chrome.
   */
  const centredDropPosition = useCallback(
    (size: { width: number; height: number }): { x: number; y: number } => {
      // Window size is deliberately not a stand-in for a region that has not laid out: the usable
      // canvas is observed, never derived. Nothing reaches this before the canvas is on screen, and
      // a node with no measurable region lands at the top-left of the flow area - where an
      // unmeasurably small region would put it too.
      const region = visibleCanvasRegion() ?? { position: screenToFlowPosition({ x: 0, y: 0 }), width: 0, height: 0 }
      return cascadedNodePosition(nodesRef.current, centredNodePosition(region, size))
    },
    [screenToFlowPosition, visibleCanvasRegion]
  )

  /**
   * Lays every node - or the selection, when two or more are selected - into the visible canvas,
   * then advances the cycle so the next press gives the next layout. Tiling places nodes itself,
   * so their snaps are released first rather than left pointing at geometry that is gone.
   */
  const tileCanvas = useCallback((): void => {
    const region = visibleCanvasRegion()
    if (!region) return
    const current = getCanvasNodes()
    const selected = current.filter((node) => node.selected).map((node) => node.id)
    const ids = selected.length >= 2 ? selected : current.map((node) => node.id)
    nodeFit.release(ids)
    setNodes(tileNodes(getCanvasNodes(), ids, tileMode, region, NODE_FIT_INSET))
    setTileMode(nextTileMode(tileMode))
  }, [getCanvasNodes, nodeFit, setNodes, tileMode, visibleCanvasRegion])

  const runLayoutAction = useCallback(
    (action: LayoutKeyAction): void => {
      const current = getCanvasNodes()
      const selected = current.filter((node) => node.selected).map((node) => node.id)
      switch (action.kind) {
        case 'snap':
          nodeFit.snap(selected, action.arrow)
          return
        case 'match-size':
          setNodes(matchNodeSizes(current, selected))
          return
        case 'tile':
          tileCanvas()
          return
        case 'slot-save':
          setLayoutSlots((slots) => ({ ...slots, [action.slot]: captureLayoutSlot(current) }))
          return
        case 'slot-restore': {
          const slot = layoutSlots[action.slot]
          if (!slot) return
          // A restored arrangement places nodes itself, like tiling.
          nodeFit.release()
          setNodes(applyLayoutSlot(getCanvasNodes(), slot))
          return
        }
        case 'none':
          return
      }
    },
    [getCanvasNodes, layoutSlots, nodeFit, setNodes, tileCanvas]
  )

  /**
   * Which node Ctrl+F searches. The node the key came from wins - a reader pressing it inside a
   * node means that one, whatever the selection says - and a lone selected node is the fallback.
   * Two selected nodes name no single surface, and only nodes that can search are offered, so the
   * key is left to the browser everywhere else rather than swallowed to no effect.
   */
  const searchTargetNodeId = useCallback(
    (target: HTMLElement | null): string | null => {
      // A dormant chat node shows a resume panel, not its transcript, so it has nothing to search.
      const searchable = new Set(
        getCanvasNodes()
          .filter(
            (node) => isFileCanvasNode(node) || isDiffCanvasNode(node) || (isChatCanvasNode(node) && !node.data.dormant)
          )
          .map((node) => node.id)
      )
      const under = target?.closest('.react-flow__node')?.getAttribute('data-id')
      if (under && searchable.has(under)) return under
      const selected = getCanvasNodes().filter((node) => node.selected)
      return selected.length === 1 && searchable.has(selected[0].id) ? selected[0].id : null
    },
    [getCanvasNodes]
  )

  const clearRecentlyClosedNodes = useCallback((): void => {
    recentlyClosedNodesRef.current = []
    setRecentlyClosedNodes([])
  }, [])

  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]): void => {
      const removedIds = new Set(changes.flatMap((change) => (change.type === 'remove' ? [change.id] : [])))
      if (removedIds.size > 0) {
        const removedNodes = nodesRef.current
          .filter((node) => removedIds.has(node.id))
          .map((node) => nodeBeforeTemporaryFit(node, nodeFit.state()))
        for (const node of removedNodes) {
          if (isTerminalCanvasNode(node) && node.data.kind === 'terminal') {
            void window.terminalApi
              .removeScrollback(node.data.sessionId)
              .then((removed) => {
                if (!removed) {
                  window.alert(
                    'Toucan could not remove this terminal’s retained output. It may still exist in the app data folder.'
                  )
                }
              })
              .catch(() => {
                window.alert(
                  'Toucan could not verify removal of this terminal’s retained output. It may still exist in the app data folder.'
                )
              })
          }
        }
        // Everything that was removed, unfiltered: what a close means for each kind - a reopen
        // target, a stack wipe, or neither - is decided in one place inside that function.
        const next = rememberClosedSessionNodes(recentlyClosedNodesRef.current, removedNodes)
        recentlyClosedNodesRef.current = next
        setRecentlyClosedNodes(next)
        setNodeStatuses((current) =>
          Object.fromEntries(Object.entries(current).filter(([nodeId]) => !removedIds.has(nodeId)))
        )
        // A closed node cannot be reached any more, so its attention records go with it rather
        // than propping up a count nothing can clear.
        forgetNodeAttention(removedIds)
        // Same for its ticket chips: a chip that focuses a node that is gone is worse than none.
        setTicketActivity((current) =>
          Object.fromEntries(Object.entries(current).filter(([nodeId]) => !removedIds.has(nodeId)))
        )
        // Closing either end of a terminal-context edge revokes it - the whole lifecycle rule.
        setEdges((current) => withoutEdgesTouchingNodes(current, removedIds))
        setTerminalContextSessions((current) => withoutNodeKeys(current, removedIds))
      }
      // Fit mode reads the changes before they land: a drag or manual resize of the fitted node
      // leaves fit mode, and a removed node must not leave a restore waiting for it.
      nodeFit.observeChanges(changes)
      onNodesChange(changes)
    },
    [forgetNodeAttention, nodeFit, onNodesChange, setEdges]
  )

  // The only edge the canvas admits: terminal → chat, the terminal-context grant. No generic
  // untyped edges exist, so anything else is refused while it is still being dragged.
  const isValidCanvasConnection: IsValidConnection = useCallback(
    (connection) => isValidTerminalContextConnection(nodesRef.current, connection),
    []
  )

  /**
   * What the canvas draws: the terminal-context edges it owns as state, plus the lineage edges
   * projected from `branchedFrom` on every render. The projection is deliberately not merged into
   * `edges` - it is derived from nodes, so storing it would make two sources of truth for one
   * fact, and a lineage edge would then be something the user could select and delete.
   */
  const lineage = lineageKey(nodes)
  const canvasEdges = useMemo(
    () => [...edges, ...lineageEdges(nodesRef.current)],
    // `lineage` stands in for `nodes` deliberately: it changes only when a node or a `branchedFrom`
    // does, so dragging a node does not rebuild the projection on every pointer frame.
    [edges, lineage]
  )

  const connectTerminalContext = useCallback(
    (connection: Connection): void => {
      setEdges((current) => withTerminalContextEdge(current, nodesRef.current, connection))
    },
    [setEdges]
  )

  // Main is the privilege boundary, so the edge set is mirrored into its registry on every change:
  // a full-set replace keyed by durable terminal sessionId + agent session id, idempotent and
  // last-write-wins - which is also what resyncs after a renderer reload, since the fresh
  // renderer's first (empty) publish wipes whatever a previous incarnation had granted. Keyed on
  // `edges` alone on purpose: both mirror keys are fixed for a node's life, and re-publishing on
  // every node drag would be an IPC send per pointer frame.
  useEffect(() => {
    window.terminalContextApi.replaceEdges(mirroredTerminalContextEdges(nodesRef.current, edges))
  }, [edges])

  const reopenLastClosedSession = useCallback((): boolean => {
    const result = reopenClosedSession(
      recentlyClosedNodesRef.current,
      {
        projects: projectsRef.current,
        worktrees: nodesRef.current.filter(isWorktreeCanvasNode).map(serializeWorktreeNode),
        agentPermissionModes: permissionModesRef.current
      },
      {
        onStatusChange: handleStatusChange,
        onAttention: handleAttention,
        onTicketActivity: handleTicketActivity,
        onConversationId: handleConversationId,
        onTitleChange: handleTitleChange,
        onPreview: handlePreview,
        onFocusModeChange: handleFocusModeChange,
        onDraftChange: handleDraftChange,
        onPermissionModeChange: handlePermissionModeChange,
        onModelChange: handleModelChange,
        onTurnOutcome: handleTurnOutcome,
        onResume: resumeNode,
        onTerminalLiveness: handleTerminalLiveness,
        onTerminalContext: handleTerminalContext,
        onForkSupport: handleForkSupport,
        onBranch: dispatchBranch,
        onWorktreeHandoff: dispatchWorktreeHandoff
      }
    )
    recentlyClosedNodesRef.current = result.recentlyClosedNodes
    setRecentlyClosedNodes(result.recentlyClosedNodes)
    if (!result.node) return false

    const reopened = result.node
    setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), reopened])
    setNodeStatuses((current) => ({ ...current, [reopened.id]: sessionNodeStatus(reopened) }))
    return true
  }, [
    dispatchWorktreeHandoff,
    dispatchBranch,
    handleConversationId,
    handleDraftChange,
    handleFocusModeChange,
    handleModelChange,
    handleTurnOutcome,
    handlePermissionModeChange,
    handlePreview,
    handleStatusChange,
    handleTicketActivity,
    handleTerminalContext,
    handleForkSupport,
    handleTerminalLiveness,
    handleTitleChange,
    resumeNode,
    setNodes
  ])

  const toggleTicketBoardPanel = useCallback((): void => {
    setTicketBoardMounted(true)
    // Spread first: the per-project source choices must survive every open and close.
    setTicketBoardPanel((current) => ({
      ...current,
      open: !current.open,
      width: clampTicketBoardWidth(current.width, window.innerWidth)
    }))
  }, [])

  const toggleBrainDumpPanel = useCallback((): void => {
    setBrainDumpMounted(true)
    setBrainDumpPanel((current) => ({
      ...current,
      open: !current.open,
      width: clampBrainDumpPanelWidth(current.width, window.innerWidth)
    }))
  }, [])

  // The panel takes real layout width, so a smaller window must narrow it rather than let it push
  // the canvas off-screen.
  useEffect(() => {
    const onResize = (): void => {
      setWorkspaceWidth(window.innerWidth)
      setBrainDumpPanel((current) => {
        const width = clampBrainDumpPanelWidth(current.width, window.innerWidth)
        return width === current.width ? current : { ...current, width }
      })
      setTicketBoardPanel((current) => {
        const width = clampTicketBoardWidth(current.width, window.innerWidth)
        return width === current.width ? current : { ...current, width }
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const addSessionNode = useCallback(
    (options: {
      kind: TerminalKind
      project: Project
      worktree?: WorktreeCanvasNode['data']
      position: { x: number; y: number }
      initialInput?: string
      label?: string
      titleSource?: ConversationTitleSource
      /** An existing provider conversation this node adopts instead of starting a fresh one. */
      resumeConversationId?: string
      /**
       * The conversation this node branches off: it launches as a fork, inheriting the whole
       * transcript, and keeps the record as its provenance. Mutually exclusive with
       * `resumeConversationId` - one loads a conversation, the other copies it.
       */
      branchedFrom?: ConversationLineage
      /** The model to open on. Absent leaves it to the adapter's own default, as a click does. */
      modelId?: string
      // Returns the canvas node id it minted, so a caller waiting on this session can find it.
    }): string => {
      const { kind, project, worktree: requestedWorktree, position, resumeConversationId, branchedFrom } = options
      const id = crypto.randomUUID()
      const label = options.label ?? `${labels[kind]} ${nextSessionNumber.current}`
      // A branch has no conversation of its own until the fork produces one, and must not be
      // handed a speculative id: an id here would read as a conversation to resume.
      const conversationId = branchedFrom
        ? undefined
        : (resumeConversationId ?? (kind === 'claude' ? crypto.randomUUID() : undefined))
      nextSessionNumber.current += 1
      setNodes((current) => {
        const worktree = requestedWorktree
          ? (current
              .filter(isWorktreeCanvasNode)
              .find(
                (node) =>
                  node.data.projectId === project.id &&
                  worktreePathKey(node.data.path) === worktreePathKey(requestedWorktree.path)
              )?.data ?? requestedWorktree)
          : undefined
        if (worktree?.unavailable) return current
        return [
          ...current.map((node) => ({ ...node, selected: false })),
          {
            id,
            type: 'terminalNode',
            dragHandle: NODE_DRAG_HANDLE,
            selected: true,
            position,
            data: {
              kind,
              sessionId: crypto.randomUUID(),
              terminalLiveness: 'unverifiable',
              label,
              titleSource: options.titleSource,
              projectId: project.id,
              projectName: project.name,
              projectPath: project.path,
              projectColor: project.color,
              worktreeId: worktree?.worktreeId,
              worktreeBranch: worktree?.branch,
              workingDirectory: worktree?.path ?? project.path,
              conversationId,
              focusMode: false,
              preferredPermissionMode: kind === 'terminal' ? undefined : permissionModesRef.current[kind],
              modelId: options.modelId,
              dormant: false,
              branchedFrom,
              launchMode: branchedFrom ? 'fork' : resumeConversationId ? 'resume' : 'new',
              initialInput: options.initialInput,
              onStatusChange: handleStatusChange,
              onAttention: handleAttention,
              onTicketActivity: handleTicketActivity,
              onConversationId: handleConversationId,
              onTitleChange: handleTitleChange,
              onPreview: handlePreview,
              onFocusModeChange: handleFocusModeChange,
              onDraftChange: handleDraftChange,
              onPermissionModeChange: handlePermissionModeChange,
              onModelChange: handleModelChange,
              onTurnOutcome: handleTurnOutcome,
              onResume: resumeNode,
              onTerminalLiveness: handleTerminalLiveness,
              onTerminalContext: handleTerminalContext,
              onForkSupport: handleForkSupport,
              onBranch: dispatchBranch,
              onWorktreeHandoff: dispatchWorktreeHandoff
            },
            style: { ...NEW_SESSION_NODE_SIZE }
          }
        ]
      })
      setNodeStatuses((current) => ({ ...current, [id]: 'starting' }))
      return id
    },
    [
      handleConversationId,
      handleDraftChange,
      handleFocusModeChange,
      handleModelChange,
      handleTurnOutcome,
      handlePermissionModeChange,
      handlePreview,
      handleStatusChange,
      handleTicketActivity,
      handleTerminalContext,
      handleForkSupport,
      dispatchBranch,
      handleTerminalLiveness,
      handleTitleChange,
      resumeNode,
      setNodes
    ]
  )

  const findWorktreeNode = useCallback(
    (worktreeId: string): WorktreeCanvasNode | undefined =>
      nodesRef.current.filter(isWorktreeCanvasNode).find((node) => node.data.worktreeId === worktreeId),
    []
  )

  /**
   * "Branch" on a chat node: a sibling beside it that forks the conversation, in the same project,
   * the same worktree and so the same working directory - a branch is another line of the same
   * work, not a move. The boundary is re-checked here rather than trusted from the click, because
   * a turn can start between the render that enabled the button and the press.
   */
  const handleBranchSession = useCallback(
    (nodeId: string): void => {
      const node = nodesRef.current.find(
        (candidate): candidate is TerminalCanvasNode => candidate.id === nodeId && isTerminalCanvasNode(candidate)
      )
      if (!node || !offersBranchAction(node)) return
      if (branchBlockedReason(sessionNodeStatus(node, nodeStatusesRef.current))) return
      const lineage = lineageOf(node)
      const project = projectsRef.current.find((candidate) => candidate.id === node.data.projectId)
      if (!lineage || !project) return
      const width = typeof node.style?.width === 'number' ? node.style.width : NEW_SESSION_NODE_SIZE.width
      addSessionNode({
        kind: node.data.kind,
        project,
        worktree: node.data.worktreeId ? findWorktreeNode(node.data.worktreeId)?.data : undefined,
        position: cascadedNodePosition(nodesRef.current, {
          x: node.position.x + (node.measured?.width ?? width) + 48,
          y: node.position.y
        }),
        branchedFrom: lineage
      })
    },
    [addSessionNode, findWorktreeNode]
  )
  handleBranchRef.current = handleBranchSession

  /** Puts a review of one checkout on the canvas; the node reads git itself. */
  const addDiffNode = useCallback(
    (project: Project, worktree: WorktreeCanvasNode['data'] | undefined, position: { x: number; y: number }): void => {
      const node = createDiffCanvasNode(
        { id: `diff-${crypto.randomUUID()}`, position },
        project,
        worktree
          ? { id: worktree.worktreeId, branch: worktree.branch, path: worktree.path, baseRef: worktree.baseRef }
          : undefined,
        { onSelectDiffPath: handleSelectDiffPath }
      )
      setNodes((current) => [
        ...current.map((candidate) => ({ ...candidate, selected: false })),
        { ...node, selected: true }
      ])
    },
    [handleSelectDiffPath, setNodes]
  )

  /** "Diff" on a worktree node: the review lands below the worktree it reviews. */
  const handleOpenDiff = useCallback(
    (worktreeId: string): void => {
      const worktreeNode = findWorktreeNode(worktreeId)
      const project = projectsRef.current.find((candidate) => candidate.id === worktreeNode?.data.projectId)
      if (!worktreeNode || !project) return
      const height =
        typeof worktreeNode.style?.height === 'number' ? worktreeNode.style.height : DEFAULT_WORKTREE_SIZE.height
      addDiffNode(
        project,
        worktreeNode.data,
        cascadedNodePosition(nodesRef.current, {
          x: worktreeNode.position.x,
          y: worktreeNode.position.y + (worktreeNode.measured?.height ?? height) + 48
        })
      )
    },
    [addDiffNode, findWorktreeNode]
  )

  /** New sessions land beside their worktree node, fanned out so they do not stack on one spot. */
  const openInWorktree = useCallback(
    (worktreeId: string, kind: TerminalKind, initialInput?: string): void => {
      const worktreeNode = findWorktreeNode(worktreeId)
      const project = projectsRef.current.find((candidate) => candidate.id === worktreeNode?.data.projectId)
      if (!worktreeNode || worktreeNode.data.unavailable || !project) return
      const offset = worktreeNode.data.attachedNodeCount
      addSessionNode({
        kind,
        project,
        worktree: worktreeNode.data,
        position: {
          x: worktreeNode.position.x + DEFAULT_WORKTREE_SIZE.width + 48,
          y: worktreeNode.position.y + offset * 40
        },
        initialInput
      })
    },
    [addSessionNode, findWorktreeNode]
  )

  const handleCreateNodeInWorktree = useCallback(
    (worktreeId: string, kind: TerminalKind): void => {
      openInWorktree(worktreeId, kind)
    },
    [openInWorktree]
  )

  const handleRunSetupCommand = useCallback(
    (worktreeId: string): void => {
      const worktreeNode = findWorktreeNode(worktreeId)
      const input = terminalRunInput(worktreeNode?.data.setupCommand ?? '')
      if (!input) return
      // A visible terminal node, not a hidden background process: setup can fail, prompt, or
      // hang, and the user needs to see it and be able to interrupt it.
      openInWorktree(worktreeId, 'terminal', input)
    },
    [findWorktreeNode, openInWorktree]
  )

  /**
   * One saved run command, started from the project row's menu. It is the setup command's gesture
   * pointed at the checkout instead of a worktree: a visible terminal the user can watch and
   * interrupt. Every pick mints its own node - `centredDropPosition` cascades - so starting a
   * project's web and API halves is two clicks producing two terminals, not one reused one.
   */
  const handleRunProjectCommand = useCallback(
    (projectId: string, commandId: string): void => {
      const project = projectsRef.current.find((candidate) => candidate.id === projectId)
      const entry = project?.runCommands?.find((candidate) => candidate.id === commandId)
      const input = terminalRunInput(entry?.command ?? '')
      if (!project || !entry || !input) return
      addSessionNode({
        kind: 'terminal',
        project,
        position: centredDropPosition(NEW_SESSION_NODE_SIZE),
        label: entry.name,
        initialInput: input
      })
    },
    [addSessionNode, centredDropPosition]
  )

  const handleRemoveWorktree = useCallback(
    (worktreeId: string): void => {
      const worktreeNode = findWorktreeNode(worktreeId)
      const project = projectsRef.current.find((candidate) => candidate.id === worktreeNode?.data.projectId)
      if (!worktreeNode || !project) return

      const attached = worktreeNode.data.attachedNodeCount
      const open = (blockers: WorktreeRemovalBlocker[]): void =>
        setRemovalPrompt({
          worktreeId,
          branch: worktreeNode.data.branch,
          path: worktreeNode.data.path,
          plan: planWorktreeRemoval(attached, blockers),
          busy: false,
          error: null
        })

      // Attached nodes settle it on their own; there is no reason to inspect the repository yet.
      if (attached > 0) {
        open([])
        return
      }

      setRemovalPrompt({
        worktreeId,
        branch: worktreeNode.data.branch,
        path: worktreeNode.data.path,
        plan: planWorktreeRemoval(0, []),
        busy: true,
        error: null
      })
      void window.worktreeApi
        .remove({
          projectPath: project.path,
          path: worktreeNode.data.path,
          branch: worktreeNode.data.branch,
          baseRef: worktreeNode.data.baseRef
        })
        .then((result) => {
          if (result.ok) {
            clearRecentlyClosedNodes()
            setNodes((current) => withoutWorktree(current, worktreeId))
            setRemovalPrompt(null)
            return
          }
          if (result.blockers.length > 0) {
            open(result.blockers)
            return
          }
          setRemovalPrompt({
            worktreeId,
            branch: worktreeNode.data.branch,
            path: worktreeNode.data.path,
            plan: planWorktreeRemoval(0, []),
            busy: false,
            error: result.message ?? 'The worktree could not be removed.'
          })
        })
        .catch((error: unknown) => {
          setRemovalPrompt({
            worktreeId,
            branch: worktreeNode.data.branch,
            path: worktreeNode.data.path,
            plan: planWorktreeRemoval(0, []),
            busy: false,
            error: worktreeRemovalErrorMessage(error)
          })
        })
    },
    [clearRecentlyClosedNodes, findWorktreeNode, setNodes]
  )

  /**
   * The worktree node's callbacks in one bag, so every site that builds one - the dialog, a
   * handoff, the discovery sweep, a restore - hands `createWorktreeCanvasNode` the same set.
   */
  const worktreeCallbacks = useMemo<WorktreeNodeCallbacks>(
    () => ({
      onRemoveWorktree: handleRemoveWorktree,
      onCreateNodeInWorktree: handleCreateNodeInWorktree,
      onRunSetupCommand: handleRunSetupCommand,
      onOpenDiff: handleOpenDiff
    }),
    [handleCreateNodeInWorktree, handleOpenDiff, handleRemoveWorktree, handleRunSetupCommand]
  )

  /**
   * A prompt that asked for its own worktree. The worktree is made first and the session is
   * started inside it, so the agent's working directory is the worktree from its first turn -
   * the only arrangement in which the worktree is a writable root rather than a permission
   * prompt on every edit. The branch is provisional: the skill renames it once it has read
   * the work, which beats guessing a name from the prompt.
   */
  const handleWorktreeHandoff = useCallback(
    (nodeId: string, request: WorktreeHandoffPlan): void => {
      const node = nodesRef.current.filter(isTerminalCanvasNode).find((candidate) => candidate.id === nodeId)
      const project = projectsRef.current.find((candidate) => candidate.id === node?.data.projectId)
      if (!node || !project || node.data.kind === 'terminal') return

      void window.worktreeApi
        .create({ projectPath: project.path, branch: placeholderBranchName(new Date()) })
        .then((result) => {
          if (!result.ok || !result.worktree) {
            // Nothing was created, so the prompt goes back to the composer it was typed in rather
            // than being silently discarded, and the failure surfaces in the dialog that already
            // exists for making a worktree by hand - which doubles as the retry.
            handleDraftChange(nodeId, request.prompt)
            setWorktreeDraft({
              projectId: project.id,
              branch: '',
              baseRef: '',
              position: { x: node.position.x, y: node.position.y + (node.height ?? 340) + 64 },
              busy: false,
              error: result.message ?? 'The worktree could not be created.'
            })
            return
          }
          const worktreeId = crypto.randomUUID()
          const created = result.worktree
          const worktreeNode = createWorktreeCanvasNode(
            {
              worktreeId,
              branch: created.branch,
              path: created.path,
              baseRef: created.baseRef,
              createdAt: new Date().toISOString(),
              position: { x: node.position.x, y: node.position.y + (node.height ?? 340) + 64 }
            },
            project,
            worktreeCallbacks
          )
          setNodes((current) =>
            registerWorktreeNode(
              current.map((candidate) => ({ ...candidate, selected: false })),
              worktreeNode
            )
          )

          if (request.mode !== 'rehome') {
            addSessionNode({
              kind: node.data.kind,
              project,
              worktree: worktreeNode.data,
              position: node.position,
              initialInput: request.prompt
            })
            return
          }

          // Codex can load a conversation in a directory it did not start in, so the node itself
          // moves rather than a second one appearing beside it - which keeps exactly one owner of
          // the conversation. Changing `workingDirectory` restarts the session there (it is a
          // dependency of the session effect), and `resume` makes that restart load the
          // conversation rather than begin a new one.
          setNodes((current) =>
            current.map((candidate) =>
              isTerminalCanvasNode(candidate) && candidate.id === nodeId
                ? {
                    ...candidate,
                    data: {
                      ...candidate.data,
                      worktreeId:
                        current
                          .filter(isWorktreeCanvasNode)
                          .find(
                            (worktree) =>
                              worktree.data.projectId === project.id &&
                              worktreePathKey(worktree.data.path) === worktreePathKey(created.path)
                          )?.data.worktreeId ?? worktreeId,
                      worktreeBranch: created.branch,
                      workingDirectory: created.path,
                      launchMode: 'resume' as const,
                      initialInput: request.prompt
                    }
                  }
                : candidate
            )
          )
        })
    },
    [addSessionNode, handleDraftChange, setNodes, worktreeCallbacks]
  )
  handleWorktreeHandoffRef.current = handleWorktreeHandoff

  const confirmWorktreeRemoval = useCallback(
    (force: boolean): void => {
      const prompt = removalPrompt
      const worktreeNode = prompt ? findWorktreeNode(prompt.worktreeId) : undefined
      const project = projectsRef.current.find((candidate) => candidate.id === worktreeNode?.data.projectId)
      if (!prompt || !worktreeNode || !project) return

      setRemovalPrompt({ ...prompt, busy: true, error: null })
      void window.worktreeApi
        .remove({
          projectPath: project.path,
          path: worktreeNode.data.path,
          branch: worktreeNode.data.branch,
          baseRef: worktreeNode.data.baseRef,
          force
        })
        .then((result) => {
          if (result.ok) {
            clearRecentlyClosedNodes()
            setNodes((current) => withoutWorktree(current, prompt.worktreeId))
            setRemovalPrompt(null)
            return
          }
          setRemovalPrompt({
            ...prompt,
            busy: false,
            plan: planWorktreeRemoval(worktreeNode.data.attachedNodeCount, result.blockers),
            error: result.message ?? null
          })
        })
        .catch((error: unknown) => {
          setRemovalPrompt({
            ...prompt,
            busy: false,
            error: worktreeRemovalErrorMessage(error)
          })
        })
    },
    [clearRecentlyClosedNodes, findWorktreeNode, removalPrompt, setNodes]
  )

  const seedFreshWorkspace = useCallback(async (): Promise<void> => {
    const directory = await window.terminalApi.getInitialProject()
    const project = createProject(directory, 0)
    setProjects([project])
    setActiveProjectId(project.id)
  }, [])

  const restoreWorkspace = useCallback(
    (saved: WorkspaceState): void => {
      const restored = restoreCanvasWorkspace(saved, {
        onStatusChange: handleStatusChange,
        onAttention: handleAttention,
        onTicketActivity: handleTicketActivity,
        onConversationId: handleConversationId,
        onTitleChange: handleTitleChange,
        onPreview: handlePreview,
        onFocusModeChange: handleFocusModeChange,
        onDraftChange: handleDraftChange,
        onPermissionModeChange: handlePermissionModeChange,
        onModelChange: handleModelChange,
        onTurnOutcome: handleTurnOutcome,
        onResume: resumeNode,
        onTerminalLiveness: handleTerminalLiveness,
        onTerminalContext: handleTerminalContext,
        onForkSupport: handleForkSupport,
        onBranch: dispatchBranch,
        onWorktreeHandoff: dispatchWorktreeHandoff,
        ...worktreeCallbacks,
        onViewModeChange: handleFileViewModeChange,
        onRequestFilePath: handleRequestFilePath,
        onPathChange: handleFilePathChange,
        onSelectDiffPath: handleSelectDiffPath
      })

      setProjects(saved.projects)
      setProjectGroups(saved.projectGroups ?? [])
      setNodes(restored.nodes)
      setNodeStatuses(restored.statuses)
      nextSessionNumber.current = restored.nextSessionNumber
      setActiveProjectId(restored.activeProjectId)
      setSidebarCollapsed(saved.sidebarCollapsed)
      // A width saved on a larger monitor is folded into this window before it is ever rendered,
      // so restoring a workspace can never hand the canvas less room than it can use.
      if (saved.brainDumpPanel) {
        const width = clampBrainDumpPanelWidth(saved.brainDumpPanel.width, window.innerWidth)
        setBrainDumpPanel({ ...saved.brainDumpPanel, width })
        if (saved.brainDumpPanel.open) setBrainDumpMounted(true)
      }
      if (saved.ticketBoardPanel) {
        setTicketBoardPanel({
          ...saved.ticketBoardPanel,
          enabledSources: pruneEnabledSources(
            saved.ticketBoardPanel.enabledSources,
            saved.projects.map((entry) => entry.path)
          ),
          width: clampTicketBoardWidth(saved.ticketBoardPanel.width, window.innerWidth)
        })
        if (saved.ticketBoardPanel.open) setTicketBoardMounted(true)
      }
      setAgentPermissionModes(saved.agentPermissionModes ?? {})
      setComposerSendKey(saved.composerSendKey ?? COMPOSER_SEND_KEY_DEFAULT)
      // Absent in older snapshots means off: existing workspaces migrate with delegation disabled.
      setRoutineDelegation(saved.routineDelegation ?? { enabled: false })
      setRecentlyClosedNodes(saved.recentlyClosedNodes ?? [])
      setLayoutSlots(pruneLayoutSlots(saved.layoutSlots ?? {}, new Set(restored.nodes.map((node) => node.id))))
      restoreAttention(
        saved.attention ?? [],
        restored.nodes.map((node) => node.id)
      )
    },
    [
      handleConversationId,
      handleDraftChange,
      handleFilePathChange,
      handleRequestFilePath,
      handleFileViewModeChange,
      handleFocusModeChange,
      handleModelChange,
      handleTurnOutcome,
      handlePermissionModeChange,
      handlePreview,
      handleSelectDiffPath,
      handleStatusChange,
      handleTicketActivity,
      handleTerminalContext,
      handleForkSupport,
      dispatchBranch,
      handleTerminalLiveness,
      handleTitleChange,
      resumeNode,
      restoreAttention,
      setNodes,
      worktreeCallbacks
    ]
  )

  // Snap state is read through a ref rather than listed as a dependency: every snap, restore,
  // reflow and release also rewrites `nodes`, so the snapshot is already recomputed whenever it
  // can differ - and a maximised node must never be persisted filling the canvas.
  const workspaceSnapshot = useMemo<WorkspaceState>(
    () => ({
      version: 3,
      projects,
      // Absent rather than empty, so a workspace that never made a group keeps writing the same
      // snapshot shape it wrote before groups existed.
      ...(projectGroups.length > 0 ? { projectGroups } : {}),
      activeProjectId,
      sidebarCollapsed,
      agentPermissionModes,
      composerSendKey,
      // Absent until the user first touches the preference, so older workspaces keep their shape.
      ...(routineDelegation.enabled || routineDelegation.codexWorkerModelId || routineDelegation.claudeWorkerModelId
        ? { routineDelegation }
        : {}),
      // One array per node kind, from the one table that knows how each is persisted - including
      // which of them stay absent from the snapshot rather than being written empty.
      ...serializeCanvasNodes(nodes, (node) => nodeBeforeTemporaryFit(node, nodeFit.state())),
      recentlyClosedNodes,
      attention: [...attention],
      // Absent rather than empty, like `projectGroups`, so a workspace that never saved a slot keeps
      // its snapshot shape.
      ...(Object.keys(layoutSlots).length > 0 ? { layoutSlots } : {}),
      brainDumpPanel,
      ticketBoardPanel
    }),
    [
      activeProjectId,
      agentPermissionModes,
      attention,
      brainDumpPanel,
      composerSendKey,
      nodes,
      projectGroups,
      projects,
      recentlyClosedNodes,
      routineDelegation,
      sidebarCollapsed,
      ticketBoardPanel
    ]
  )

  const [remoteAccessOpen, setRemoteAccessOpen] = useState(false)
  const [adapterManagementOpen, setAdapterManagementOpen] = useState(false)

  /**
   * A chat a phone asked for, created through the canvas's own add-node path so the result is
   * indistinguishable from a right-click on the canvas: same id minting, same working-directory
   * resolution, same launch mode, same persistence. Only the position is decided differently -
   * there is no pointer behind this one - and a spawn into a worktree is deliberately not offered,
   * because choosing one is a decision the phone has no way to make well.
   */
  const startRemoteSpawn = useCallback(
    (request: RemoteChatSpawnRequest): RemoteChatSpawnResult => {
      const project = projectsRef.current.find((candidate) => candidate.id === request.projectId)
      if (!project) return { ok: false, message: 'That project is no longer open on the desktop.' }
      return {
        ok: true,
        chatId: addSessionNode({
          kind: request.kind,
          project,
          position: centredDropPosition(NEW_SESSION_NODE_SIZE),
          initialInput: request.input,
          // A model the phone named travels as ordinary node data, so the session it opens is the
          // same shape as one opened from a right-click that had a model remembered on it.
          modelId: request.modelId
        })
      }
    },
    [addSessionNode, centredDropPosition]
  )

  // One owner for the host's remote-access state, for the canvas projection a paired phone
  // lists, and for the spawns that phone asks for. The projection is derived from the same
  // snapshot that gets persisted, so the phone and the canvas can never be looking at two
  // different sets of nodes.
  const listProjectBranches = useCallback((projectPath: string) => window.worktreeApi.listBranches(projectPath), [])

  /**
   * Sessions mid-turn in the project checkout itself. Worktree nodes do not count: switching the
   * project checkout leaves their directories untouched.
   */
  const countWorkingCheckoutSessions = useCallback(
    (projectId: string): number =>
      nodes
        .filter(isTerminalCanvasNode)
        .filter((node) => node.data.projectId === projectId && !node.data.worktreeId)
        .filter((node) => sessionNodeStatus(node, nodeStatuses) === 'working').length,
    [nodes, nodeStatuses]
  )

  const switchProjectBranch = useCallback(
    async (project: WorkspaceProject, branch: string): Promise<GitCheckoutResult> => {
      // Re-checked here, not only in the menu: a session can start a turn while the list is open.
      const working = countWorkingCheckoutSessions(project.id)
      if (working > 0) {
        return {
          ok: false,
          message:
            working === 1
              ? '1 session started working in this checkout; wait for it to finish'
              : `${working} sessions are working in this checkout; wait for them to finish`
        }
      }
      const result = await window.worktreeApi.checkoutBranch({ path: project.path, branch })
      if (result.ok) setBranchRevision((current) => current + 1)
      return result
    },
    [countWorkingCheckoutSessions]
  )

  /**
   * A phone read one of these chats. It goes through `handleAttention` like every desktop read, and
   * with the very same kinds: `READ_ON_VIEW_KINDS` is what *reaching content* settles, so a pending
   * approval survives being looked at on a phone exactly as it survives being looked at here. An id
   * whose node is gone clears nothing, which is the right answer for a chat closed mid-read.
   */
  const markRemoteChatRead = useCallback(
    (chatId: string) => handleAttention({ type: 'read', nodeId: chatId, kinds: READ_ON_VIEW_KINDS }),
    [handleAttention]
  )

  const remoteAccess = useRemoteAccess(workspaceSnapshot, nodeStatuses, startRemoteSpawn, markRemoteChatRead)
  const appUpdate = useAppUpdate()

  const {
    ready: workspaceReady,
    recovered: workspaceRecovered,
    unrecoverable: workspaceUnrecoverable,
    saveStatus,
    acknowledgeUnrecoverable: acknowledgeUnrecoverableWorkspace
  } = useWorkspacePersistence({ snapshot: workspaceSnapshot, restore: restoreWorkspace, seedFresh: seedFreshWorkspace })

  /*
   * A recovery is reported once and then goes away for good on this launch: it is news the first
   * time the canvas comes back from a backup, and clutter for the rest of the session. A failed
   * save is not dismissible for the same reason inverted - it stays until a save succeeds, because
   * what it reports is work that is not on disk.
   */
  const [recoveryDismissed, setRecoveryDismissed] = useState(false)

  /*
   * Main resolves a project's tickets folder from the *persisted* snapshot, so a board re-listed
   * the moment the setting changed would read the old folder and never hear about the new one.
   * The revision therefore advances when the save lands, not when the user hits Save - and only
   * for a folder change on the project already showing, so switching projects still costs the one
   * listing the board does anyway.
   */
  const [ticketsFolderRevision, setTicketsFolderRevision] = useState(0)
  const activeTicketsFolder = activeProject
    ? `${activeProject.id}:${ticketsDirectoryOrDefault(activeProject.ticketsDirectory)}`
    : ''
  const savedTicketsFolder = useRef(activeTicketsFolder)
  useEffect(() => {
    const persisted = savedTicketsFolder.current
    // Another project entirely: the board re-lists on the switch itself, so there is nothing to
    // advance - only the record of what that project's folder was when it was last written.
    if (persisted.split(':')[0] !== activeTicketsFolder.split(':')[0]) {
      savedTicketsFolder.current = activeTicketsFolder
      return
    }
    if (saveStatus !== 'saved' || persisted === activeTicketsFolder) return
    savedTicketsFolder.current = activeTicketsFolder
    setTicketsFolderRevision((current) => current + 1)
  }, [activeTicketsFolder, saveStatus])

  // One place decides how many nodes a worktree carries, so the count the teardown gate reads
  // and the count the node shows can never drift apart.
  useEffect(() => {
    setNodes((current) => applyAttachedNodeCounts(current, projectsRef.current))
  }, [nodes, projects, setNodes])

  /**
   * A worktree an agent made for itself is discovered with a claim naming the node that asked
   * for the work, but a claim is only an association until the node can safely move. Redeeming
   * it restarts the session in the worktree, so it waits for a boundary where there is no turn
   * to lose - and then the node is genuinely attached, counted, and persisted as such.
   */
  useEffect(() => {
    setNodes((current) => adoptClaimedWorktrees(current, nodeStatuses))
  }, [nodeStatuses, nodes, setNodes])

  /**
   * An edge drawn onto a running session grants nothing until the session carries the read tool,
   * and `mcpServers` is fixed at creation - so the session restarts (resuming its own
   * conversation, cwd unchanged, both providers) at the next safe boundary. The entry is spent
   * before the restart so an unrelated re-render cannot adopt the same node twice while the
   * fresh session's own report is still on its way.
   */
  useEffect(() => {
    const adopting = planTerminalContextAdoptions(nodesRef.current, edges, nodeStatuses, terminalContextSessions)
    if (adopting.length === 0) return
    setTerminalContextSessions((current) => withoutNodeKeys(current, new Set(adopting)))
    setNodes((current) => adoptTerminalContext(current, adopting))
  }, [edges, nodeStatuses, nodes, setNodes, terminalContextSessions])

  /**
   * Worktrees can appear without Toucan creating them - an agent running the worktree skill, a
   * plain `git worktree add` in a terminal. Reconcile only records main positively identified
   * as stale; attached sessions retain their record until closed.
   */
  useEffect(() => {
    if (!workspaceReady) return
    let cancelled = false

    const sweep = async (): Promise<void> => {
      for (const project of projectsRef.current) {
        const known = nodesRef.current
          .filter(isWorktreeCanvasNode)
          .filter((node) => node.data.projectId === project.id)
          .map((node) => node.data.path)

        const result = await window.worktreeApi.discover({ projectPath: project.path, known }).catch(() => null)
        if (
          cancelled ||
          !result ||
          (result.worktrees.length === 0 &&
            result.claims.length === 0 &&
            !result.stalePaths?.length &&
            !result.availablePaths?.length)
        )
          continue

        setNodes((current) => {
          if (!projectsRef.current.some((candidate) => candidate.id === project.id && candidate.path === project.path))
            return current
          const reconciled = reconcileStaleWorktrees(
            current,
            project.id,
            result.stalePaths ?? [],
            result.availablePaths ?? []
          )
          const recorded = new Set(
            reconciled
              .filter(isWorktreeCanvasNode)
              .filter((node) => node.data.projectId === project.id)
              .map((node) => worktreePathKey(node.data.path))
          )
          const fresh = result.worktrees.filter((worktree) => {
            const key = worktreePathKey(worktree.path)
            if (recorded.has(key)) return false
            recorded.add(key)
            return true
          })

          const added = fresh.map((worktree, index) =>
            createWorktreeCanvasNode(
              {
                worktreeId: crypto.randomUUID(),
                branch: worktree.branch,
                path: worktree.path,
                baseRef: worktree.baseRef,
                createdAt: new Date().toISOString(),
                position: { x: 80, y: 80 + (recorded.size + index) * (DEFAULT_WORKTREE_SIZE.height + 48) }
              },
              project,
              worktreeCallbacks
            )
          )

          // Claims are applied against every worktree on the canvas, not just the ones this
          // sweep added: the agent writes its claim after the worktree exists and its setup
          // command has run, so the sweep that records the worktree is routinely earlier.
          return applyWorktreeClaims(added.length === 0 ? reconciled : [...reconciled, ...added], result.claims)
        })
      }
    }

    void sweep()
    const timer = setInterval(() => void sweep(), WORKTREE_SWEEP_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [setNodes, workspaceReady, worktreeCallbacks])

  const addProject = useCallback(async (): Promise<void> => {
    const directory = await window.terminalApi.pickProject()
    if (!directory) return

    const existing = projects.find((project) => project.path.toLocaleLowerCase() === directory.path.toLocaleLowerCase())
    if (existing) {
      setActiveProjectId(existing.id)
      setMenu(null)
      return
    }

    const project = createProject(directory, projects.length)
    setProjects((current) => [...current, project])
    setActiveProjectId(project.id)
    setMenu(null)
  }, [projects])

  const locateProject = useCallback(
    (projectId: string): void => {
      const matchingNodes = nodes.filter((node) => node.data.projectId === projectId)
      if (matchingNodes.length > 0) {
        void fitView({ nodes: matchingNodes, padding: 0.28, duration: 350 })
      }
    },
    [fitView, nodes]
  )

  const removeProject = useCallback(
    (projectId: string): void => {
      if (projects.length <= 1 || nodes.some((node) => node.data.projectId === projectId)) return
      const remaining = projects.filter((project) => project.id !== projectId)
      clearRecentlyClosedNodes()
      setProjects(remaining)
      // A removed project's stored avatar would otherwise sit orphaned in userData forever.
      void window.projectAvatarApi?.remove(projectId)
      if (activeProjectId === projectId) setActiveProjectId(remaining[0].id)
      setMenu(null)
    },
    [activeProjectId, clearRecentlyClosedNodes, nodes, projects]
  )

  const focusNode = useCallback(
    (nodeId: string): void => {
      const target = nodes.find((node) => node.id === nodeId)
      if (!target) return

      // Selecting a node is enough: each node reports its own status once it sees the focus.
      setNodes((current) => current.map((node) => ({ ...node, selected: node.id === nodeId })))
      setMenu(null)
      // Pan only: the user's zoom is theirs, and a snapped node goes back to the side it was snapped to.
      const canvas = canvasRegionRef.current?.getBoundingClientRect()
      const next = canvas && viewportShowingNode(target, nodeFit.state()[nodeId], canvas, getViewport(), NODE_FIT_INSET)
      if (next) void setViewport(next, { duration: 350 })
    },
    [getViewport, nodeFit, nodes, setNodes, setViewport]
  )

  /** The board's live session cards; which report becomes which chip is `ticket-activity.ts`. */
  const ticketSessions = useMemo(
    () =>
      activeProject
        ? ticketSessionsFromNodes(nodes.filter(isTerminalCanvasNode), ticketActivity, activeProject)
        : undefined,
    [activeProject, nodes, ticketActivity]
  )

  const openContextMenu = useCallback(
    (event: MouseEvent | ReactMouseEvent): void => {
      event.preventDefault()
      if (!activeProject) return
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      setMenu({
        clientX: event.clientX,
        clientY: event.clientY,
        flowX: position.x,
        flowY: position.y
      })
    },
    [activeProject, screenToFlowPosition]
  )

  /** Transcripts belong to a working directory, so browsing spans the checkout and its worktrees. */
  const historyDirectories = useMemo(() => {
    if (!activeProject) return []
    const worktreePaths = nodes
      .filter(isWorktreeCanvasNode)
      .filter((node) => node.data.projectId === activeProject.id)
      .map((node) => node.data.path)
    return [...new Set([activeProject.path, ...worktreePaths])]
  }, [activeProject, nodes])

  const historyDirectoryLabels = useMemo(() => {
    const labelsByPath: Record<string, string> = {}
    if (activeProject) labelsByPath[activeProject.path.toLocaleLowerCase()] = activeProject.name
    for (const node of nodes.filter(isWorktreeCanvasNode)) {
      labelsByPath[node.data.path.toLocaleLowerCase()] = node.data.branch
    }
    return labelsByPath
  }, [activeProject, nodes])

  /**
   * One entry of the canvas context menu, run at a canvas position. A node created from the canvas
   * runs in the project checkout; attaching to a worktree is always an explicit act, either from the
   * worktree node or by creating the worktree first.
   */
  const runCreateAction = useCallback(
    (action: Exclude<CreateNodeKeyAction, 'none'>, position: { x: number; y: number }): void => {
      if (!activeProject) return
      const project = activeProject
      switch (action) {
        case 'create-terminal':
        case 'create-claude':
        case 'create-codex':
          addSessionNode({ kind: SESSION_KIND_BY_ACTION[action], project, position })
          break
        case 'create-worktree':
          setWorktreeDraft({ projectId: project.id, branch: '', baseRef: '', position, busy: false, error: null })
          break
        case 'open-history':
          setHistoryDrop(position)
          break
        case 'open-file':
          setFilePickerRequest({
            kind: 'create',
            projectId: project.id,
            projectName: project.name,
            root: project.path,
            position
          })
          break
        case 'open-diff':
          addDiffNode(project, undefined, position)
          break
      }
    },
    [activeProject, addDiffNode, addSessionNode]
  )

  const runCreateActionFromMenu = useCallback(
    (action: Exclude<CreateNodeKeyAction, 'none'>): void => {
      if (!menu) return
      runCreateAction(action, { x: menu.flowX, y: menu.flowY })
      setMenu(null)
    },
    [menu, runCreateAction]
  )

  // While a picker, draft or dialog is open the create shortcuts do nothing, so a node cannot
  // appear behind it. The panels are fine: they dock beside the canvas rather than cover it.
  const dialogOpen = !!(
    filePickerRequest ||
    historyDrop ||
    worktreeDraft ||
    removalPrompt ||
    remoteAccessOpen ||
    adapterManagementOpen
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      // Not every keydown target is an element - the document and window fire these too, and
      // neither has closest()/isContentEditable.
      const target = event.target instanceof HTMLElement ? event.target : null
      const editingTextarea = target instanceof HTMLTextAreaElement
      const editingText =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || !!target?.isContentEditable
      if (brainDumpPanelKeyAction(event, { panelOpen: brainDumpOpenRef.current, editingText }) === 'toggle-panel') {
        event.preventDefault()
        toggleBrainDumpPanel()
        return
      }
      if (ticketBoardKeyAction(event) === 'toggle-panel') {
        event.preventDefault()
        toggleTicketBoardPanel()
        return
      }
      if (closedSessionKeyAction(event, recentlyClosedNodesRef.current.length > 0) === 'reopen') {
        if (reopenLastClosedSession()) event.preventDefault()
        return
      }
      if (nodeSearchKeyAction(event, { editingText, dialogOpen }) === 'open') {
        const nodeId = searchTargetNodeId(target)
        if (nodeId) {
          event.preventDefault()
          setNodeSearchRequest((current) => ({ nodeId, nonce: current.nonce + 1 }))
          return
        }
      }
      const layoutAction = layoutKeyAction(event, { editingText, editingTextarea })
      if (layoutAction.kind !== 'none') {
        if (dialogOpen) return
        event.preventDefault()
        runLayoutAction(layoutAction)
        return
      }
      const editingTerminal = !!target?.closest('.terminal-host')
      const action = createNodeKeyAction(event, { editingTerminal })
      if (action === 'none' || dialogOpen) return
      event.preventDefault()
      setMenu(null)
      runCreateAction(action, centredDropPosition(NEW_NODE_SIZE[action]))
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    dialogOpen,
    reopenLastClosedSession,
    runCreateAction,
    runLayoutAction,
    searchTargetNodeId,
    toggleBrainDumpPanel,
    toggleTicketBoardPanel,
    centredDropPosition
  ])

  /** Puts one file on the canvas as a node; the node reads and watches the file itself. */
  const addFileNode = useCallback(
    (path: string, project: Project, position: { x: number; y: number }): void => {
      const node = createFileCanvasNode({ id: `file-${crypto.randomUUID()}`, path, position }, project, {
        onViewModeChange: handleFileViewModeChange,
        onRequestFilePath: handleRequestFilePath,
        onPathChange: handleFilePathChange
      })
      setNodes((current) => [
        ...current.map((candidate) => ({ ...candidate, selected: false })),
        { ...node, selected: true }
      ])
    },
    [handleFilePathChange, handleFileViewModeChange, handleRequestFilePath, setNodes]
  )

  const openPickedFile = useCallback(
    (path: string): void => {
      if (!filePickerRequest) return
      setFilePickerRequest(null)
      if (filePickerRequest.kind === 'create') {
        const project = projectsRef.current.find((candidate) => candidate.id === filePickerRequest.projectId)
        if (project) addFileNode(path, project, filePickerRequest.position)
        return
      }
      const resolve = filePickerResolver.current
      filePickerResolver.current = null
      resolve?.(path)
    },
    [addFileNode, filePickerRequest]
  )

  const cancelFilePicker = useCallback((): void => {
    setFilePickerRequest(null)
    const resolve = filePickerResolver.current
    filePickerResolver.current = null
    resolve?.(null)
  }, [])

  /**
   * "Open" on a transcript's file card. The file belongs to whichever project's checkout or
   * worktree contains it - a worktree session's file must not be filed under another project just
   * because that one is active - and falls back to the active project only for a path outside
   * every root, where the node will report that the file is not readable.
   */
  const openFileFromCard = useCallback(
    (path: string): void => {
      const owningId = projectOwningPath(path, [
        ...projectsRef.current.map((project) => ({ projectId: project.id, root: project.path })),
        ...nodesRef.current
          .filter(isWorktreeCanvasNode)
          .map((node) => ({ projectId: node.data.projectId, root: node.data.path }))
      ])
      const owner =
        projectsRef.current.find((project) => project.id === owningId) ??
        projectsRef.current.find((project) => project.id === activeProjectId) ??
        projectsRef.current[0]
      if (!owner) return
      addFileNode(path, owner, centredDropPosition(NEW_NODE_SIZE['open-file']))
    },
    [activeProjectId, addFileNode, centredDropPosition]
  )

  /**
   * A browsed conversation reopens as a node resumed onto it, attached to whichever worktree it
   * originally ran in so it keeps writing where it always did.
   */
  const openHistoryConversation = useCallback(
    (entry: ConversationSummary): void => {
      const project =
        projectsRef.current.find((candidate) => candidate.id === activeProjectId) ?? projectsRef.current[0]
      if (!project || !historyDrop) return
      const worktreeNode = nodesRef.current
        .filter(isWorktreeCanvasNode)
        .find((node) => node.data.path.toLocaleLowerCase() === entry.cwd.toLocaleLowerCase())
      addSessionNode({
        kind: entry.provider,
        project,
        worktree: worktreeNode?.data,
        position: historyDrop,
        label: entry.title,
        titleSource: entry.titleSource,
        resumeConversationId: entry.id
      })
      setHistoryDrop(null)
    },
    [activeProjectId, addSessionNode, historyDrop]
  )

  /**
   * A failed capture is still a real provider conversation, so it reopens as an ordinary resumable
   * node rather than growing a second transcript UI inside the panel. The node is owned by whichever
   * registered project the job ran in; an unassigned capture ran in the home directory, so it falls
   * back to the active project.
   */
  const openBrainDumpSession = useCallback(
    (conversation: { provider: TerminalKind; conversationId: string; cwd: string }): void => {
      const identity = pathIdentity(conversation.cwd)
      const project =
        projectsRef.current.find((candidate) => pathIdentity(candidate.path) === identity) ??
        projectsRef.current.find((candidate) => candidate.id === activeProjectId) ??
        projectsRef.current[0]
      if (!project) return
      addSessionNode({
        kind: conversation.provider,
        project,
        position: centredDropPosition(NEW_SESSION_NODE_SIZE),
        label: 'Brain dump capture',
        resumeConversationId: conversation.conversationId
      })
    },
    [activeProjectId, addSessionNode, centredDropPosition]
  )

  const confirmWorktreeDraft = useCallback((): void => {
    const draft = worktreeDraft
    const project = projects.find((candidate) => candidate.id === draft?.projectId)
    if (!draft || !project) return

    setWorktreeDraft({ ...draft, busy: true, error: null })
    void window.worktreeApi
      .create({ projectPath: project.path, branch: draft.branch, baseRef: draft.baseRef.trim() || undefined })
      .then((result) => {
        if (!result.ok || !result.worktree) {
          setWorktreeDraft({ ...draft, busy: false, error: result.message ?? 'The worktree could not be created.' })
          return
        }
        const created = result.worktree
        const worktreeNode = createWorktreeCanvasNode(
          {
            worktreeId: crypto.randomUUID(),
            branch: created.branch,
            path: created.path,
            baseRef: created.baseRef,
            createdAt: new Date().toISOString(),
            position: draft.position,
            selected: true
          },
          project,
          worktreeCallbacks
        )
        setNodes((current) =>
          registerWorktreeNode(
            current.map((node) => ({ ...node, selected: false })),
            worktreeNode
          )
        )
        setWorktreeDraft(null)
      })
  }, [projects, setNodes, worktreeDraft, worktreeCallbacks])

  /**
   * Avatar changes apply immediately rather than on the dialog's Save: the picked file has to be
   * normalized and written by main to be previewable at all, so Save/Cancel govern only the text
   * settings. A successful set bumps `avatarVersion`, which is what makes every chip re-read.
   */
  const chooseProjectAvatar = useCallback(async (projectId: string): Promise<void> => {
    const result = await window.projectAvatarApi.choose(projectId)
    if (result.status === 'set')
      setProjects((current) =>
        current.map((project) => (project.id === projectId ? { ...project, avatarVersion: result.version } : project))
      )
    setAvatarError(result.status === 'refused' ? result.message : null)
  }, [])

  const removeProjectAvatar = useCallback(async (projectId: string): Promise<void> => {
    await window.projectAvatarApi.remove(projectId)
    setProjects((current) =>
      current.map((project) => {
        if (project.id !== projectId) return project
        const { avatarVersion: _removed, ...rest } = project
        return rest
      })
    )
    setAvatarError(null)
  }, [])

  const saveProjectSettings = useCallback((projectId: string, settings: ProjectSettingsDraft): void => {
    setProjects((current) =>
      current.map((project) =>
        project.id === projectId
          ? {
              ...project,
              setupCommand: settings.setupCommand || undefined,
              ticketsDirectory: settings.ticketsDirectory || undefined,
              runCommands: settings.runCommands.length ? settings.runCommands : undefined
            }
          : project
      )
    )
    setSetupProjectId(null)
  }, [])

  /** The colour a project is shown in; `withProjectColor` fans it out across the nodes it owns. */
  const setProjectColor = useCallback(
    (projectId: string, color: string): void => {
      setProjects((current) => current.map((project) => (project.id === projectId ? { ...project, color } : project)))
      setNodes((current) => withProjectColor(current, projectId, color))
    },
    [setNodes]
  )

  /**
   * A drag in flight on a sidebar row. Rows are measured once at `pointerdown` - nothing in the
   * list moves until the drop - and the new order is committed on `pointerup` only, because every
   * change to `projects` re-serialises the whole workspace.
   */
  const [sidebarDrag, setSidebarDrag] = useState<{
    kind: 'project' | 'group'
    id: string
    indicator: { top: number; left: number; width: number } | null
  } | null>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const sidebarRowsRef = useRef(new Map<string, HTMLElement>())

  const registerSidebarRow = useCallback((key: string, element: HTMLElement | null): void => {
    if (element) sidebarRowsRef.current.set(key, element)
    else sidebarRowsRef.current.delete(key)
  }, [])

  const measureSidebarRows = useCallback((): MeasuredRow[] => {
    const measured: MeasuredRow[] = []
    const push = (kind: MeasuredRow['kind'], id: string, groupId?: string): void => {
      const element = sidebarRowsRef.current.get(`${kind}:${id}`)
      if (!element) return
      const rect = element.getBoundingClientRect()
      measured.push({ kind, id, ...(groupId ? { groupId } : {}), top: rect.top, bottom: rect.bottom })
    }
    for (const region of sidebarRegions(projects, projectGroups)) {
      if (region.group) push('group-header', region.group.id)
      if (region.group?.collapsed) continue
      for (const project of region.projects) push('project', project.id, region.group?.id)
    }
    return measured
  }, [projectGroups, projects])

  /**
   * The one drag gesture, shared by project rows and group headers. It only ever starts on the
   * grab handle, so clicking a row or one of its action buttons still does what it always did.
   */
  const startSidebarDrag = useCallback(
    (kind: 'project' | 'group', id: string, event: React.PointerEvent<HTMLElement>): void => {
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.setPointerCapture?.(event.pointerId)
      setProjectMenu(null)

      const rows = measureSidebarRows()
      const sidebar = sidebarRef.current?.getBoundingClientRect()
      const frame = { left: sidebar?.left ?? 0, width: sidebar?.width ?? 0 }
      let target: ReturnType<typeof projectDropTarget> | ReturnType<typeof groupDropTarget> = null
      setSidebarDrag({ kind, id, indicator: null })

      const move = (pointer: PointerEvent): void => {
        target =
          kind === 'project' ? projectDropTarget(rows, pointer.clientY, id) : groupDropTarget(rows, pointer.clientY, id)
        setSidebarDrag({
          kind,
          id,
          indicator: target ? { top: target.indicatorY, ...frame } : null
        })
      }
      const finish = (commit: boolean): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', release)
        window.removeEventListener('keydown', cancel)
        setSidebarDrag(null)
        if (!commit || !target) return
        if (kind === 'project' && 'beforeProjectId' in target) {
          const drop = target
          setProjects((current) => moveProject(current, id, drop))
        } else if (kind === 'group' && 'beforeGroupId' in target) {
          const drop = target
          setProjectGroups((current) => moveGroup(current, id, drop))
        }
      }
      const release = (): void => finish(true)
      const cancel = (key: KeyboardEvent): void => {
        if (key.key === 'Escape') finish(false)
      }

      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', release)
      window.addEventListener('keydown', cancel)
    },
    [measureSidebarRows]
  )

  const toggleProjectGroup = useCallback((groupId: string): void => {
    setProjectGroups((current) =>
      current.map((group) => (group.id === groupId ? { ...group, collapsed: !group.collapsed } : group))
    )
  }, [])

  const moveProjectToGroup = useCallback((projectId: string, groupId: string | undefined): void => {
    setProjects((current) =>
      moveProject(current, projectId, { ...(groupId ? { groupId } : {}), beforeProjectId: null })
    )
  }, [])

  /** Appends an empty group and opens its inline name field, the one way a group is born. */
  const addProjectGroup = useCallback((): ProjectGroup => {
    const group: ProjectGroup = { id: crypto.randomUUID(), name: nextGroupName(projectGroups), collapsed: false }
    setProjectGroups((current) => [...current, group])
    setRenamingGroupId(group.id)
    return group
  }, [projectGroups])

  const createProjectGroup = useCallback(
    (projectId: string): void => {
      moveProjectToGroup(projectId, addProjectGroup().id)
    },
    [addProjectGroup, moveProjectToGroup]
  )

  const renameProjectGroup = useCallback((groupId: string, name: string): void => {
    const trimmed = name.trim()
    setRenamingGroupId(null)
    if (!trimmed) return
    setProjectGroups((current) => current.map((group) => (group.id === groupId ? { ...group, name: trimmed } : group)))
  }, [])

  /** Deleting a group unfiles its members; nothing a group action does may remove a project. */
  const deleteProjectGroup = useCallback((groupId: string): void => {
    setProjects((current) => ungroupProjects(current, groupId))
    setProjectGroups((current) => current.filter((group) => group.id !== groupId))
    setRenamingGroupId((current) => (current === groupId ? null : current))
  }, [])

  const sendKeyPreference = useMemo(
    () => ({ sendKey: composerSendKey, setSendKey: setComposerSendKey }),
    [composerSendKey]
  )

  const routineDelegationSetting = useMemo(
    () => ({ preference: routineDelegation, setPreference: setRoutineDelegation }),
    [routineDelegation]
  )

  return (
    <ComposerSendKeyContext.Provider value={sendKeyPreference}>
      <RoutineDelegationContext.Provider value={routineDelegationSetting}>
        {/* One poll, every node: account usage is per provider, so a chat node reads it from here
        instead of asking for it itself. */}
        <ProviderRateLimitsContext.Provider value={providerRateLimits.limits}>
          <main className="app-shell" onClick={() => setMenu(null)}>
            {workspaceUnrecoverable && (
              <div
                className="unrecoverable-workspace-overlay"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="unrecoverable-workspace-title"
              >
                <div className="unrecoverable-workspace-dialog">
                  <strong id="unrecoverable-workspace-title">Your saved workspace could not be recovered</strong>
                  <p>
                    The saved canvas and its backup were both damaged, likely by a crash or an interrupted write.
                    Nothing has been overwritten yet.
                  </p>
                  <button type="button" onClick={() => void acknowledgeUnrecoverableWorkspace()}>
                    Start a new workspace
                  </button>
                </div>
              </div>
            )}
            <header className="app-header">
              <div>
                <img className="brand-mark" src={toucanLogo} alt="" aria-hidden="true" />
                <strong>Toucan</strong>
                <span className="prototype-label">Agentic Development Environment</span>
              </div>
              <div className="header-target">
                {(statusSummary.working > 0 ||
                  statusSummary.stalled > 0 ||
                  unreadTotal > 0 ||
                  saveStatus === 'error' ||
                  (workspaceRecovered && !recoveryDismissed)) && (
                  <div className="global-status-summary" role="status">
                    {statusSummary.working > 0 && (
                      <span className="global-status-chip" data-kind="working">
                        <span className="global-status-dot" />
                        {statusSummary.working} working
                      </span>
                    )}
                    {statusSummary.stalled > 0 && (
                      <span
                        className="global-status-chip"
                        data-kind="stalled"
                        title="No progress for a while - these sessions may be stuck"
                      >
                        <span className="global-status-dot" />
                        {statusSummary.stalled} may be stuck
                      </span>
                    )}
                    {/* Not recomputed from node status: this is the same durable record set the
                  project rows and the nodes themselves count, so the numbers agree. */}
                    {unreadTotal > 0 && (
                      <span className="global-status-chip" data-kind="attention" title={describeUnread()}>
                        <span className="global-status-dot" />
                        {unreadTotal} unread
                      </span>
                    )}
                    {/* In the header rather than the sidebar because the sidebar collapses and
                  these two must not: a canvas that is not reaching disk is worth reporting in
                  every layout the window has. */}
                    {saveStatus === 'error' && (
                      <span
                        className="global-status-chip"
                        data-kind="save-error"
                        title="The canvas could not be written to disk. Recent changes are only in memory until a save succeeds."
                      >
                        <span className="global-status-dot" />
                        Save failed
                      </span>
                    )}
                    {workspaceRecovered && !recoveryDismissed && (
                      <button
                        type="button"
                        className="global-status-chip"
                        data-kind="recovered"
                        title="The saved workspace was damaged or incomplete, so this canvas was restored from the last known-good backup. Click to dismiss."
                        onClick={() => setRecoveryDismissed(true)}
                      >
                        <span className="global-status-dot" />
                        Recovered from backup
                      </button>
                    )}
                  </div>
                )}
                {(providerRateLimits.providers.claude || providerRateLimits.providers.codex) && (
                  <div className="global-usage-summary">
                    {providerRateLimits.providers.claude && (
                      <ProviderUsageChip
                        provider="claude"
                        entry={providerRateLimits.providers.claude}
                        onRefresh={providerRateLimits.refresh}
                      />
                    )}
                    {providerRateLimits.providers.codex && (
                      <ProviderUsageChip
                        provider="codex"
                        entry={providerRateLimits.providers.codex}
                        onRefresh={providerRateLimits.refresh}
                      />
                    )}
                  </div>
                )}
                <AppUpdateChip
                  snapshot={appUpdate.snapshot}
                  announceError={appUpdate.announceError}
                  busy={appUpdate.busy}
                  onCheck={appUpdate.check}
                  onRestart={appUpdate.restart}
                />
                <button
                  type="button"
                  className="header-remote-access"
                  title="Agent adapters"
                  aria-label="Agent adapters"
                  onClick={(event) => {
                    event.stopPropagation()
                    setMenu(null)
                    setAdapterManagementOpen(true)
                  }}
                >
                  <Settings aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="header-remote-access"
                  title={
                    remoteAccess.state?.listening
                      ? `Remote access is on (port ${remoteAccess.state.boundPort ?? remoteAccess.state.settings.port})`
                      : 'Remote access is off - open to serve the mobile companion'
                  }
                  data-listening={remoteAccess.state?.listening ? 'true' : undefined}
                  onClick={(event) => {
                    event.stopPropagation()
                    setMenu(null)
                    setRemoteAccessOpen(true)
                  }}
                >
                  <Smartphone aria-hidden="true" />
                </button>
                {activeProject && (
                  <span className="target-chip" title={activeProject.path}>
                    <span style={{ background: activeProject.color }} />
                    {activeProject.name}
                  </span>
                )}
              </div>
            </header>

            <div className="workspace-shell">
              <aside ref={sidebarRef} className={`project-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
                <div className="sidebar-heading">
                  {!sidebarCollapsed && <span>Projects</span>}
                  <button
                    type="button"
                    className="sidebar-toggle"
                    title={sidebarCollapsed ? 'Expand projects' : 'Collapse projects'}
                    onClick={(event) => {
                      event.stopPropagation()
                      setMenu(null)
                      setSidebarCollapsed((current) => !current)
                    }}
                  >
                    {sidebarCollapsed ? <ChevronRight aria-hidden="true" /> : <ChevronLeft aria-hidden="true" />}
                  </button>
                </div>

                <div className="project-list" data-dragging={sidebarDrag ? 'true' : undefined}>
                  {sidebarRegions(projects, projectGroups).map((region) => {
                    const group = region.group
                    return (
                      <div className="project-region" key={group?.id ?? 'ungrouped'} data-group={group?.id}>
                        {group && (
                          <div
                            className="project-group-header"
                            ref={(element) => registerSidebarRow(`group-header:${group.id}`, element)}
                            data-expanded={group.collapsed ? undefined : 'true'}
                            data-dragging={
                              sidebarDrag?.kind === 'group' && sidebarDrag.id === group.id ? 'true' : undefined
                            }
                            onContextMenu={(event) => {
                              event.preventDefault()
                              setMenu(null)
                              setProjectMenu({ x: event.clientX, y: event.clientY, target: { kind: 'group', group } })
                            }}
                          >
                            <span
                              className="project-drag-handle"
                              title={`Drag to re-order ${group.name}`}
                              onPointerDown={(event) => startSidebarDrag('group', group.id, event)}
                            >
                              <GripVertical aria-hidden="true" />
                            </span>
                            {renamingGroupId === group.id ? (
                              <input
                                className="project-group-rename"
                                autoFocus
                                defaultValue={group.name}
                                aria-label={`Rename ${group.name}`}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') renameProjectGroup(group.id, event.currentTarget.value)
                                  if (event.key === 'Escape') {
                                    event.stopPropagation()
                                    setRenamingGroupId(null)
                                  }
                                }}
                                onBlur={(event) => renameProjectGroup(group.id, event.currentTarget.value)}
                              />
                            ) : (
                              <button
                                type="button"
                                className="project-group-toggle"
                                aria-expanded={!group.collapsed}
                                title={`${group.name} · ${region.projects.length} project${
                                  region.projects.length === 1 ? '' : 's'
                                }`}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  toggleProjectGroup(group.id)
                                }}
                              >
                                <span className="project-group-chevron" aria-hidden="true">
                                  <ChevronDown />
                                </span>
                                {sidebarCollapsed ? (
                                  <span className="project-avatar project-group-avatar">
                                    {group.name.slice(0, 1).toUpperCase()}
                                  </span>
                                ) : (
                                  <>
                                    <strong>{group.name}</strong>
                                    <span className="project-group-count">{region.projects.length}</span>
                                  </>
                                )}
                              </button>
                            )}
                          </div>
                        )}
                        {!group?.collapsed &&
                          region.projects.map((project) => {
                            const projectNodes = nodes
                              .filter(isTerminalCanvasNode)
                              .filter((node) => node.data.projectId === project.id)
                            const projectWorktrees = nodes
                              .filter(isWorktreeCanvasNode)
                              .filter((node) => node.data.projectId === project.id)
                            const nodeCount = projectNodes.length + projectWorktrees.length
                            // Summed from the same records as the header chip and the nodes, never re-derived.
                            const projectNodeIds = projectNodes.map((node) => node.id)
                            const projectUnread = countUnread(projectNodeIds)
                            const selected = project.id === activeProject?.id
                            return (
                              <div className="project-section" key={project.id}>
                                <div
                                  className={`project-row ${selected ? 'active' : ''}`}
                                  ref={(element) => registerSidebarRow(`project:${project.id}`, element)}
                                  data-dragging={
                                    sidebarDrag?.kind === 'project' && sidebarDrag.id === project.id
                                      ? 'true'
                                      : undefined
                                  }
                                  onContextMenu={(event) => {
                                    event.preventDefault()
                                    setMenu(null)
                                    setProjectMenu({
                                      x: event.clientX,
                                      y: event.clientY,
                                      target: { kind: 'project', project }
                                    })
                                  }}
                                >
                                  <span
                                    className="project-drag-handle"
                                    title={`Drag to re-order ${project.name}`}
                                    onPointerDown={(event) => startSidebarDrag('project', project.id, event)}
                                  >
                                    <GripVertical aria-hidden="true" />
                                  </span>
                                  <button
                                    type="button"
                                    className="project-select"
                                    title={sidebarCollapsed ? `${project.name}\n${project.path}` : undefined}
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      setActiveProjectId(project.id)
                                      setMenu(null)
                                    }}
                                  >
                                    <ProjectAvatar project={project} avatarUrl={projectAvatars[project.id] ?? null}>
                                      {projectUnread > 0 && (
                                        <span
                                          className="unread-badge project-unread"
                                          title={describeUnread(projectNodeIds)}
                                        >
                                          {projectUnread}
                                        </span>
                                      )}
                                    </ProjectAvatar>
                                    {!sidebarCollapsed && (
                                      <span className="project-copy">
                                        <strong title={project.path}>{project.name}</strong>
                                      </span>
                                    )}
                                  </button>
                                  {!sidebarCollapsed && (
                                    <div className="project-actions">
                                      <button
                                        type="button"
                                        className="project-setup"
                                        title={projectSettingsTitle(project)}
                                        data-configured={
                                          project.setupCommand ||
                                          project.ticketsDirectory ||
                                          project.runCommands?.length
                                            ? 'true'
                                            : undefined
                                        }
                                        onClick={(event) => {
                                          event.stopPropagation()
                                          setAvatarError(null)
                                          setSetupProjectId(project.id)
                                          setMenu(null)
                                        }}
                                      >
                                        <Settings aria-hidden="true" />
                                      </button>
                                      <button
                                        type="button"
                                        className="project-locate"
                                        title={
                                          nodeCount > 0 ? `Show ${project.name} nodes` : 'No nodes on the canvas yet'
                                        }
                                        disabled={nodeCount === 0}
                                        onClick={(event) => {
                                          event.stopPropagation()
                                          locateProject(project.id)
                                        }}
                                      >
                                        {nodeCount}
                                      </button>
                                      <button
                                        type="button"
                                        className="project-remove"
                                        title={
                                          nodeCount > 0
                                            ? 'Delete this project’s nodes first'
                                            : projects.length === 1
                                              ? 'Toucan needs at least one project'
                                              : `Remove ${project.name}`
                                        }
                                        disabled={nodeCount > 0 || projects.length === 1}
                                        onClick={(event) => {
                                          event.stopPropagation()
                                          removeProject(project.id)
                                        }}
                                      >
                                        <X aria-hidden="true" />
                                      </button>
                                    </div>
                                  )}
                                  {!sidebarCollapsed && (
                                    <div className="project-branch-line">
                                      <ProjectBranchChip
                                        directory={project.path}
                                        revision={branchRevision}
                                        onOpen={(anchor) => {
                                          setMenu(null)
                                          setProjectMenu({
                                            x: anchor.left,
                                            y: anchor.bottom + 4,
                                            target: { kind: 'project', project },
                                            page: 'branches'
                                          })
                                        }}
                                      />
                                    </div>
                                  )}
                                </div>

                                {!sidebarCollapsed && projectWorktrees.length > 0 && (
                                  <div className="project-node-list project-worktree-list">
                                    {projectWorktrees.map((node) => (
                                      <button
                                        type="button"
                                        className={`project-node-row ${node.selected ? 'selected' : ''}`}
                                        key={node.id}
                                        title={`Focus worktree ${node.data.branch}\n${node.data.path}`}
                                        onClick={(event) => {
                                          event.stopPropagation()
                                          focusNode(node.id)
                                        }}
                                      >
                                        <span className="project-node-kind">
                                          <GitBranch aria-hidden="true" />
                                        </span>
                                        <span className="project-node-name">{node.data.branch}</span>
                                        <span className="project-node-state" data-status="worktree">
                                          {node.data.attachedNodeCount}
                                        </span>
                                      </button>
                                    ))}
                                  </div>
                                )}

                                {!sidebarCollapsed && projectNodes.length > 0 && (
                                  <div className="project-node-list">
                                    {projectNodes.map((node) => {
                                      const status = sessionNodeStatus(node, nodeStatuses)
                                      const nodeUnread = unreadByNode[node.id] ?? 0
                                      return (
                                        <button
                                          type="button"
                                          className={`project-node-row ${node.selected ? 'selected' : ''}`}
                                          key={node.id}
                                          data-kind={node.data.kind}
                                          data-unread={nodeUnread > 0 ? 'true' : undefined}
                                          title={[
                                            `Focus ${node.data.label} · ${statusLabels[status]}`,
                                            nodeUnread > 0 ? describeUnread([node.id]) : null
                                          ]
                                            .filter(Boolean)
                                            .join('\n')}
                                          onClick={(event) => {
                                            event.stopPropagation()
                                            focusNode(node.id)
                                          }}
                                        >
                                          <span className="project-node-kind">
                                            <SessionKindIcon kind={node.data.kind} />
                                          </span>
                                          <span className="project-node-name">{node.data.label}</span>
                                          {nodeUnread > 0 && <span className="unread-badge">{nodeUnread}</span>}
                                          {node.data.kind === 'terminal' && (
                                            <SidebarTerminalLiveness liveness={node.data.terminalLiveness} />
                                          )}
                                          <span className="project-node-state" data-status={status}>
                                            <span className="node-status-indicator" />
                                            {statusLabels[status]}
                                          </span>
                                        </button>
                                      )
                                    })}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                      </div>
                    )
                  })}
                </div>

                {sidebarDrag?.indicator && (
                  <div
                    className="project-drop-indicator"
                    aria-hidden="true"
                    style={{
                      position: 'fixed',
                      top: sidebarDrag.indicator.top,
                      left: sidebarDrag.indicator.left,
                      width: sidebarDrag.indicator.width
                    }}
                  />
                )}

                {/* The sidebar's chrome, below the scrolling project list: global destinations,
                  the create actions, and the canvas controls. One block with one alignment and one
                  border language so the footer reads as chrome rather than as four loose widgets.
                  The canvas controls live here rather than floating on the canvas because a
                  floating group overlaps auto-laid-out nodes. */}
                <div className="sidebar-footer">
                  <div className="sidebar-footer-group">
                    <button
                      type="button"
                      className="sidebar-global-entry"
                      aria-pressed={brainDumpPanel.open}
                      title={sidebarCollapsed ? 'Open brain-dump library' : 'Brain dumps (Ctrl+Shift+B)'}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleBrainDumpPanel()
                      }}
                    >
                      <span className="sidebar-global-icon" aria-hidden="true">
                        <BookOpen />
                      </span>
                      {!sidebarCollapsed && <span>Brain dumps</span>}
                      {sidebarCollapsed && <span className="visually-hidden">Open brain-dump library</span>}
                    </button>

                    <button
                      type="button"
                      className="sidebar-global-entry"
                      aria-pressed={ticketBoardPanel.open}
                      title={sidebarCollapsed ? 'Open the ticket board' : 'Tickets (Ctrl+Shift+K)'}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleTicketBoardPanel()
                      }}
                    >
                      <span className="sidebar-global-icon" aria-hidden="true">
                        <ClipboardList />
                      </span>
                      {!sidebarCollapsed && <span>Tickets</span>}
                      {sidebarCollapsed && <span className="visually-hidden">Open the ticket board</span>}
                    </button>
                  </div>

                  <div className="sidebar-add-row">
                    <button
                      type="button"
                      className="add-project"
                      title="Add project folder"
                      onClick={(event) => {
                        event.stopPropagation()
                        void addProject()
                      }}
                    >
                      <Plus aria-hidden="true" />
                      {!sidebarCollapsed && 'Add project'}
                    </button>
                    <button
                      type="button"
                      className="add-project add-project-group"
                      title="New group"
                      aria-label="New group"
                      onClick={(event) => {
                        event.stopPropagation()
                        addProjectGroup()
                      }}
                    >
                      <FolderPlus aria-hidden="true" />
                    </button>
                  </div>

                  {/* One segmented group, not five loose buttons: they all steer the canvas, so they
                    share a single border and are divided by hairlines, like the stock React Flow
                    controls. The readout is the group's own reset affordance, which is why it is a
                    button rather than a label. */}
                  <div className="canvas-zoom-row" role="group" aria-label="Canvas zoom">
                    <button
                      type="button"
                      className="canvas-zoom-button"
                      title="Zoom out"
                      aria-label="Zoom out"
                      onClick={() => void zoomOut()}
                    >
                      <ZoomOut aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="canvas-zoom-level"
                      title="Reset zoom to 100%"
                      aria-label={`Canvas zoom ${Math.round(canvasZoom * 100)} percent, reset to 100 percent`}
                      onClick={() => void zoomTo(1, { duration: 160 })}
                    >
                      {Math.round(canvasZoom * 100)}%
                    </button>
                    <button
                      type="button"
                      className="canvas-zoom-button"
                      title="Zoom in"
                      aria-label="Zoom in"
                      onClick={() => void zoomIn()}
                    >
                      <ZoomIn aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="canvas-zoom-button"
                      title="Fit view"
                      aria-label="Fit view"
                      onClick={() => void fitView()}
                    >
                      <Maximize aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="canvas-zoom-button"
                      title={`Tile nodes as ${tileMode} (${LAYOUT_SHORTCUT_LABELS.tile})`}
                      aria-label="Tile nodes"
                      onClick={tileCanvas}
                    >
                      <LayoutGrid aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </aside>

              <section ref={canvasRegionRef} className="canvas-region">
                <NodeFitContext.Provider value={nodeFit.toggle}>
                  <NodeSearchContext.Provider value={nodeSearchRequest}>
                    <OpenFileContext.Provider value={openFileFromCard}>
                      <ReactFlow
                        nodes={nodes}
                        nodeTypes={nodeTypes}
                        edges={canvasEdges}
                        onEdgesChange={onEdgesChange}
                        onConnect={connectTerminalContext}
                        isValidConnection={isValidCanvasConnection}
                        onNodesChange={handleNodesChange}
                        onPaneContextMenu={openContextMenu}
                        onPaneClick={() => setMenu(null)}
                        minZoom={0.25}
                        maxZoom={2}
                        /* Plain wheel is reserved for scrolling inside nodes; only a Ctrl-held
                           wheel moves the canvas, so a stray scroll over the pane never zooms.
                           Ctrl is the whole gate - a trackpad pinch arrives as one too, which is
                           what `zoomOnPinch` then lets through. `preventScrolling` has to go with
                           it: React Flow otherwise calls preventDefault on every wheel that bubbles
                           out of a node, which would freeze the very scrolling this reserves the
                           gesture for. Nodes can then leave the wheel alone entirely - no
                           `nowheel`, no stopPropagation - so a Ctrl+wheel over a transcript or a
                           grown composer still zooms. */
                        zoomOnScroll={false}
                        zoomOnPinch
                        panOnScroll={false}
                        preventScrolling={false}
                        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
                        colorMode="dark"
                        deleteKeyCode={['Backspace', 'Delete']}
                      >
                        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="#303744" />
                      </ReactFlow>
                    </OpenFileContext.Provider>
                  </NodeSearchContext.Provider>
                </NodeFitContext.Provider>
              </section>

              {/* Docked, never overlaid: the panel is a sibling of the canvas region, so opening it
                only narrows React Flow's box. Once mounted it stays mounted and merely hides, which
                is what preserves selection, search, scroll, and an unsent draft across a close. */}
              {brainDumpMounted && (
                <BrainDumpLibraryPanel
                  panel={brainDumpPanel}
                  workspaceWidth={workspaceWidth}
                  projects={projects}
                  activeProjectPath={activeProject?.path}
                  api={window.brainDumpApi}
                  today={localCalendarDate()}
                  onPanelChange={(patch) => setBrainDumpPanel((current) => ({ ...current, ...patch }))}
                  onOpenSessionOnCanvas={openBrainDumpSession}
                />
              )}

              {ticketBoardMounted && (
                <TicketBoardPanel
                  panel={ticketBoardPanel}
                  revision={ticketsFolderRevision}
                  workspaceWidth={workspaceWidth}
                  projectPath={activeProject?.path}
                  projectName={activeProject?.name}
                  sources={ticketSources}
                  today={localCalendarDate()}
                  sessions={ticketSessions}
                  onFocusSession={focusNode}
                  onPanelChange={(patch) => setTicketBoardPanel((current) => ({ ...current, ...patch }))}
                />
              )}
            </div>

            {projectMenu && (
              <ProjectRowMenu
                x={projectMenu.x}
                y={projectMenu.y}
                target={projectMenu.target}
                initialPage={projectMenu.page}
                groups={projectGroups}
                onClose={() => setProjectMenu(null)}
                onListBranches={listProjectBranches}
                onSwitchBranch={switchProjectBranch}
                workingSessions={countWorkingCheckoutSessions}
                onColorChange={setProjectColor}
                onMoveToGroup={moveProjectToGroup}
                onCreateGroup={createProjectGroup}
                onRunCommand={handleRunProjectCommand}
                onRenameGroup={setRenamingGroupId}
                onDeleteGroup={deleteProjectGroup}
              />
            )}

            {menu && activeProject && (
              <div
                className="context-menu"
                style={{ left: menu.clientX, top: menu.clientY }}
                role="menu"
                onClick={(event) => event.stopPropagation()}
              >
                <p>Create in {activeProject.name}</p>
                {CREATE_NODE_ACTIONS.map((entry) => (
                  <button
                    key={entry.action}
                    type="button"
                    role="menuitem"
                    onClick={() => runCreateActionFromMenu(entry.action)}
                  >
                    <span className={`menu-icon ${CREATE_ACTION_ICONS[entry.action].className}`}>
                      {CREATE_ACTION_ICONS[entry.action].icon}
                    </span>
                    <span>
                      <strong>{entry.title}</strong>
                      <small>{entry.description}</small>
                    </span>
                    <kbd>{NODE_SHORTCUT_LABELS[entry.action]}</kbd>
                  </button>
                ))}
              </div>
            )}

            {filePickerRequest && (
              <FilePickerDialog
                projectName={filePickerRequest.projectName}
                root={filePickerRequest.root}
                onCancel={cancelFilePicker}
                onOpen={openPickedFile}
              />
            )}

            {historyDrop && activeProject && (
              <ConversationHistoryDialog
                projectName={activeProject.name}
                directories={historyDirectories}
                directoryLabels={historyDirectoryLabels}
                onCancel={() => setHistoryDrop(null)}
                onOpen={openHistoryConversation}
              />
            )}

            {worktreeDraft && activeWorktreeDraftProject && (
              <WorktreeCreateDialog
                draft={worktreeDraft}
                project={activeWorktreeDraftProject}
                onChange={(patch) => setWorktreeDraft((current) => (current ? { ...current, ...patch } : current))}
                onCancel={() => setWorktreeDraft(null)}
                onConfirm={confirmWorktreeDraft}
              />
            )}

            {remoteAccessOpen && (
              <RemoteAccessDialog
                state={remoteAccess.state}
                busy={remoteAccess.busy}
                onApply={(settings) => void remoteAccess.applySettings(settings)}
                onRegenerate={() => void remoteAccess.regenerateToken()}
                onCopyToken={(token) => window.terminalApi.copyText(token)}
                onClose={() => setRemoteAccessOpen(false)}
              />
            )}

            {adapterManagementOpen && <AdapterManagementDialog onClose={() => setAdapterManagementOpen(false)} />}

            {removalPrompt && (
              <WorktreeRemoveDialog
                prompt={removalPrompt}
                onCancel={() => setRemovalPrompt(null)}
                onConfirm={confirmWorktreeRemoval}
              />
            )}

            {setupProject && (
              <ProjectSettingsDialog
                project={setupProject}
                avatarUrl={projectAvatars[setupProject.id] ?? null}
                avatarError={avatarError}
                onChooseAvatar={() => void chooseProjectAvatar(setupProject.id)}
                onRemoveAvatar={() => void removeProjectAvatar(setupProject.id)}
                onCancel={() => setSetupProjectId(null)}
                onSave={(settings) => saveProjectSettings(setupProject.id, settings)}
              />
            )}
          </main>
        </ProviderRateLimitsContext.Provider>
      </RoutineDelegationContext.Provider>
    </ComposerSendKeyContext.Provider>
  )
}

export default function App(): JSX.Element {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  )
}
