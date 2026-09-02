import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type NodeChange,
  type NodeTypes
} from '@xyflow/react'
import { BookOpen, ChevronLeft, ChevronRight, GitBranch, History, Plus, Settings, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  AGENT_TURN_OUTCOME_LIMIT,
  type AgentRateLimitStatus,
  type AgentRateLimitWindow,
  type AgentTurnOutcome
} from '../../shared/agent'
import type { ConversationSummary } from '../../shared/conversation'
import { normalizeConversationTitle, type ConversationTitleSource } from '../../shared/conversation-title'
import type {
  AgentPermissionModes,
  BrainDumpPanelState,
  ComposerSendKey,
  ConversationPreview,
  ProjectDirectory,
  TerminalKind,
  TerminalLiveness,
  WorkspaceProject,
  WorkspaceState,
  WorkspaceTerminalNode
} from '../../shared/terminal'
import type { WorktreeRemovalBlocker } from '../../shared/worktree'
import toucanLogo from './assets/toucan-logo.svg'
import { placeholderBranchName, type WorktreeHandoffPlan } from '../../shared/worktree-handoff'
import {
  BRAIN_DUMP_PANEL_DEFAULT_WIDTH,
  brainDumpPanelKeyAction,
  clampBrainDumpPanelWidth
} from './brain-dump-panel-layout'
import { brainDumpPathIdentity } from './brain-dump-topics'
import BrainDumpLibraryPanel from './BrainDumpLibraryPanel'
import {
  closedSessionKeyAction,
  DEFAULT_WORKTREE_SIZE,
  isTerminalCanvasNode,
  isWorktreeCanvasNode,
  NODE_DRAG_HANDLE,
  rememberClosedSessionNodes,
  reopenClosedSession,
  restoreCanvasWorkspace,
  serializeCanvasNode,
  serializeWorktreeNode,
  type CanvasNode,
  type TerminalCanvasNode,
  type TerminalNodeCallbacks,
  type TerminalNodeStatus,
  type WorktreeCanvasNode
} from './canvas-workspace'
import { COMPOSER_SEND_KEY_DEFAULT } from './composer-keys'
import { ComposerSendKeyContext } from './composer-send-key-context'
import ConversationHistoryDialog from './ConversationHistoryDialog'
import { ProviderRateLimitsContext } from './provider-rate-limits'
import { describeRateLimitWindow } from './session-usage'
import SessionKindIcon from './SessionKindIcon'
import SessionNode from './SessionNode'
import { terminalLivenessLabels } from './terminal-liveness'
import { SidebarTerminalLiveness } from './TerminalLivenessPresentation'
import { useProviderRateLimits } from './use-provider-rate-limits'
import { useWorkspaceAttention } from './workspace-attention'
import { useWorkspacePersistence } from './workspace-persistence'
import {
  SetupCommandDialog,
  WorktreeCreateDialog,
  WorktreeRemoveDialog,
  type WorktreeDraft,
  type WorktreeRemovalPrompt
} from './WorkspaceDialogs'
import { planWorktreeRemoval } from './worktree-removal'
import WorktreeNode from './WorktreeNode'

type Project = WorkspaceProject

interface ContextMenuState {
  clientX: number
  clientY: number
  flowX: number
  flowY: number
}

/** How often Toucan re-checks git for worktrees it has no record of. */
const WORKTREE_SWEEP_INTERVAL_MS = 15000

const nodeTypes: NodeTypes = { terminalNode: SessionNode, worktreeNode: WorktreeNode }

const labels: Record<TerminalKind, string> = {
  terminal: 'Terminal',
  claude: 'Claude Code',
  codex: 'Codex'
}

const projectColors = ['#71a9ff', '#e69a71', '#74d8a2', '#c992ff', '#f1c75b', '#e8799b']

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

function UsageWindow({ label, window }: { label: string; window: AgentRateLimitWindow }): JSX.Element {
  // Thresholds, clamping and wording are shared with the per-node usage bar so one window never
  // reads as two different states in the two places it is shown.
  const { level, displayPercent } = describeRateLimitWindow(label, window)
  return (
    <span className="usage-window" data-level={level}>
      <span className="usage-window-label">{label}</span>
      <span className="usage-window-bar">
        <span className="usage-window-fill" style={{ width: `${displayPercent}%` }} />
      </span>
      <span className="usage-window-pct">{displayPercent}%</span>
    </span>
  )
}

/**
 * Not every plan meters both windows - a Codex plan may report only the one it bills against - so
 * a chip renders just the windows its provider actually reported.
 */
function ProviderUsageChip({ provider, status }: { provider: string; status: AgentRateLimitStatus }): JSX.Element {
  const title = [
    `${provider} account usage`,
    status.fiveHour ? describeRateLimitWindow('5h', status.fiveHour).text : null,
    status.weekly ? describeRateLimitWindow('7d', status.weekly).text : null,
    status.rejected ? 'Limit reached' : null
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <span className="provider-usage-chip" data-rejected={status.rejected ? 'true' : undefined} title={title}>
      <span className="provider-usage-name">{provider}</span>
      {status.fiveHour && <UsageWindow label="5h" window={status.fiveHour} />}
      {status.weekly && <UsageWindow label="7d" window={status.weekly} />}
    </span>
  )
}

function createProject(directory: ProjectDirectory, index: number): Project {
  return {
    ...directory,
    id: crypto.randomUUID(),
    color: projectColors[index % projectColors.length]
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

function Canvas(): JSX.Element {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [nodeStatuses, setNodeStatuses] = useState<Record<string, TerminalNodeStatus>>({})
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [agentPermissionModes, setAgentPermissionModes] = useState<AgentPermissionModes>({})
  const [composerSendKey, setComposerSendKey] = useState<ComposerSendKey>(COMPOSER_SEND_KEY_DEFAULT)
  const [recentlyClosedNodes, setRecentlyClosedNodes] = useState<WorkspaceTerminalNode[]>([])
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [worktreeDraft, setWorktreeDraft] = useState<WorktreeDraft | null>(null)
  const [removalPrompt, setRemovalPrompt] = useState<WorktreeRemovalPrompt | null>(null)
  const [setupProjectId, setSetupProjectId] = useState<string | null>(null)
  // Where a conversation picked from the history browser lands, captured when the browser opens
  // so the node still appears where the user right-clicked.
  const [historyDrop, setHistoryDrop] = useState<{ x: number; y: number } | null>(null)
  // The brain-dump library is global rather than per-project, so the workspace owns its persisted
  // panel state and the panel itself only renders it.
  const [brainDumpPanel, setBrainDumpPanel] = useState<BrainDumpPanelState>({
    open: false,
    width: BRAIN_DUMP_PANEL_DEFAULT_WIDTH
  })
  const [brainDumpMounted, setBrainDumpMounted] = useState(false)
  const [workspaceWidth, setWorkspaceWidth] = useState(() => window.innerWidth)
  const { fitView, screenToFlowPosition } = useReactFlow()
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
        return { conversationId }
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
  const projectsRef = useRef<Project[]>([])
  const permissionModesRef = useRef<AgentPermissionModes>({})
  const recentlyClosedNodesRef = useRef<WorkspaceTerminalNode[]>([])
  const brainDumpOpenRef = useRef(false)
  // Held in a ref because the handler is declared after the node factories that hand it out,
  // and because a node's stored callback must not go stale as the handler is recreated.
  const handleWorktreeHandoffRef = useRef<TerminalNodeCallbacks['onWorktreeHandoff']>(undefined)
  /** Stable identity for node data; reads the ref at call time so it can never go stale. */
  const dispatchWorktreeHandoff = useCallback<NonNullable<TerminalNodeCallbacks['onWorktreeHandoff']>>(
    (nodeId, request) => handleWorktreeHandoffRef.current?.(nodeId, request),
    []
  )
  nodesRef.current = nodes
  projectsRef.current = projects
  permissionModesRef.current = agentPermissionModes
  recentlyClosedNodesRef.current = recentlyClosedNodes
  brainDumpOpenRef.current = brainDumpPanel.open

  const clearRecentlyClosedNodes = useCallback((): void => {
    recentlyClosedNodesRef.current = []
    setRecentlyClosedNodes([])
  }, [])

  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]): void => {
      const removedIds = new Set(changes.flatMap((change) => (change.type === 'remove' ? [change.id] : [])))
      if (removedIds.size > 0) {
        const removedNodes = nodesRef.current.filter((node) => removedIds.has(node.id))
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
        const next = rememberClosedSessionNodes(recentlyClosedNodesRef.current, removedNodes)
        recentlyClosedNodesRef.current = next
        setRecentlyClosedNodes(next)
        setNodeStatuses((current) =>
          Object.fromEntries(Object.entries(current).filter(([nodeId]) => !removedIds.has(nodeId)))
        )
        // A closed node cannot be reached any more, so its attention records go with it rather
        // than propping up a count nothing can clear.
        forgetNodeAttention(removedIds)
      }
      onNodesChange(changes)
    },
    [forgetNodeAttention, onNodesChange]
  )

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
        onWorktreeHandoff: dispatchWorktreeHandoff
      }
    )
    recentlyClosedNodesRef.current = result.recentlyClosedNodes
    setRecentlyClosedNodes(result.recentlyClosedNodes)
    if (!result.node) return false

    const reopened = result.node
    setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), reopened])
    setNodeStatuses((current) => ({
      ...current,
      [reopened.id]: reopened.data.dormant ? 'dormant' : 'starting'
    }))
    return true
  }, [
    dispatchWorktreeHandoff,
    handleConversationId,
    handleDraftChange,
    handleFocusModeChange,
    handleModelChange,
    handleTurnOutcome,
    handlePermissionModeChange,
    handlePreview,
    handleStatusChange,
    handleTerminalLiveness,
    handleTitleChange,
    resumeNode,
    setNodes
  ])

  const toggleBrainDumpPanel = useCallback((): void => {
    setBrainDumpMounted(true)
    setBrainDumpPanel((current) => ({
      ...current,
      open: !current.open,
      width: clampBrainDumpPanelWidth(current.width, window.innerWidth)
    }))
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const editingText =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || !!target?.isContentEditable
      if (brainDumpPanelKeyAction(event, { panelOpen: brainDumpOpenRef.current, editingText }) === 'toggle-panel') {
        event.preventDefault()
        toggleBrainDumpPanel()
        return
      }
      if (closedSessionKeyAction(event, recentlyClosedNodesRef.current.length > 0) !== 'reopen') return
      if (reopenLastClosedSession()) event.preventDefault()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [reopenLastClosedSession, toggleBrainDumpPanel])

  // The panel takes real layout width, so a smaller window must narrow it rather than let it push
  // the canvas off-screen.
  useEffect(() => {
    const onResize = (): void => {
      setWorkspaceWidth(window.innerWidth)
      setBrainDumpPanel((current) => {
        const width = clampBrainDumpPanelWidth(current.width, window.innerWidth)
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
    }): void => {
      const { kind, project, worktree, position, resumeConversationId } = options
      const id = crypto.randomUUID()
      const label = options.label ?? `${labels[kind]} ${nextSessionNumber.current}`
      const conversationId = resumeConversationId ?? (kind === 'claude' ? crypto.randomUUID() : undefined)
      nextSessionNumber.current += 1
      setNodes((current) => [
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
            dormant: false,
            launchMode: resumeConversationId ? 'resume' : 'new',
            initialInput: options.initialInput,
            onStatusChange: handleStatusChange,
            onAttention: handleAttention,
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
            onWorktreeHandoff: dispatchWorktreeHandoff
          },
          style: { width: 750, height: 660 }
        }
      ])
      setNodeStatuses((current) => ({ ...current, [id]: 'starting' }))
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

  /** New sessions land beside their worktree node, fanned out so they do not stack on one spot. */
  const openInWorktree = useCallback(
    (worktreeId: string, kind: TerminalKind, initialInput?: string): void => {
      const worktreeNode = findWorktreeNode(worktreeId)
      const project = projectsRef.current.find((candidate) => candidate.id === worktreeNode?.data.projectId)
      if (!worktreeNode || !project) return
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
      const command = worktreeNode?.data.setupCommand?.trim()
      if (!command) return
      // A visible terminal node, not a hidden background process: setup can fail, prompt, or
      // hang, and the user needs to see it and be able to interrupt it.
      openInWorktree(worktreeId, 'terminal', `${command}\r`)
    },
    [findWorktreeNode, openInWorktree]
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
            setNodes((current) =>
              current.filter((node) => !(isWorktreeCanvasNode(node) && node.data.worktreeId === worktreeId))
            )
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
          setNodes((current) => [
            ...current.map((candidate) => ({ ...candidate, selected: false })),
            {
              id: `worktree:${worktreeId}`,
              type: 'worktreeNode',
              dragHandle: NODE_DRAG_HANDLE,
              selected: false,
              deletable: false,
              position: { x: node.position.x, y: node.position.y + (node.height ?? 340) + 64 },
              data: {
                worktreeId,
                branch: created.branch,
                path: created.path,
                baseRef: created.baseRef,
                createdAt: new Date().toISOString(),
                projectId: project.id,
                projectName: project.name,
                projectPath: project.path,
                projectColor: project.color,
                setupCommand: project.setupCommand,
                attachedNodeCount: 0,
                onRemoveWorktree: handleRemoveWorktree,
                onCreateNodeInWorktree: handleCreateNodeInWorktree,
                onRunSetupCommand: handleRunSetupCommand
              },
              style: { ...DEFAULT_WORKTREE_SIZE }
            }
          ])

          if (request.mode !== 'rehome') {
            openInWorktree(worktreeId, node.data.kind, request.prompt)
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
                      worktreeId,
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
    [
      handleCreateNodeInWorktree,
      handleDraftChange,
      handleRemoveWorktree,
      handleRunSetupCommand,
      openInWorktree,
      setNodes
    ]
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
            setNodes((current) =>
              current.filter((node) => !(isWorktreeCanvasNode(node) && node.data.worktreeId === prompt.worktreeId))
            )
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
        onWorktreeHandoff: dispatchWorktreeHandoff,
        onRemoveWorktree: handleRemoveWorktree,
        onCreateNodeInWorktree: handleCreateNodeInWorktree,
        onRunSetupCommand: handleRunSetupCommand
      })

      setProjects(saved.projects)
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
      setAgentPermissionModes(saved.agentPermissionModes ?? {})
      setComposerSendKey(saved.composerSendKey ?? COMPOSER_SEND_KEY_DEFAULT)
      setRecentlyClosedNodes(saved.recentlyClosedNodes ?? [])
      restoreAttention(
        saved.attention ?? [],
        restored.nodes.map((node) => node.id)
      )
    },
    [
      handleConversationId,
      handleCreateNodeInWorktree,
      handleDraftChange,
      handleFocusModeChange,
      handleModelChange,
      handleTurnOutcome,
      handlePermissionModeChange,
      handlePreview,
      handleRemoveWorktree,
      handleRunSetupCommand,
      handleStatusChange,
      handleTerminalLiveness,
      handleTitleChange,
      resumeNode,
      restoreAttention,
      setNodes
    ]
  )

  const workspaceSnapshot = useMemo<WorkspaceState>(
    () => ({
      version: 3,
      projects,
      activeProjectId,
      sidebarCollapsed,
      agentPermissionModes,
      composerSendKey,
      nodes: nodes.filter(isTerminalCanvasNode).map(serializeCanvasNode),
      recentlyClosedNodes,
      attention: [...attention],
      worktrees: nodes.filter(isWorktreeCanvasNode).map(serializeWorktreeNode),
      brainDumpPanel
    }),
    [
      activeProjectId,
      agentPermissionModes,
      attention,
      brainDumpPanel,
      composerSendKey,
      nodes,
      projects,
      recentlyClosedNodes,
      sidebarCollapsed
    ]
  )

  const {
    ready: workspaceReady,
    recovered: workspaceRecovered,
    unrecoverable: workspaceUnrecoverable,
    saveStatus,
    acknowledgeUnrecoverable: acknowledgeUnrecoverableWorkspace
  } = useWorkspacePersistence({ snapshot: workspaceSnapshot, restore: restoreWorkspace, seedFresh: seedFreshWorkspace })

  // One place decides how many nodes a worktree carries, so the count the teardown gate reads
  // and the count the node shows can never drift apart.
  useEffect(() => {
    setNodes((current) => {
      const counts = new Map<string, number>()
      for (const node of current) {
        if (isTerminalCanvasNode(node) && node.data.worktreeId) {
          counts.set(node.data.worktreeId, (counts.get(node.data.worktreeId) ?? 0) + 1)
        }
      }
      let changed = false
      const next = current.map((node) => {
        if (!isWorktreeCanvasNode(node)) return node
        const project = projectsRef.current.find((candidate) => candidate.id === node.data.projectId)
        const attachedNodeCount = counts.get(node.data.worktreeId) ?? 0
        const setupCommand = project?.setupCommand
        if (node.data.attachedNodeCount === attachedNodeCount && node.data.setupCommand === setupCommand) return node
        changed = true
        return { ...node, data: { ...node.data, attachedNodeCount, setupCommand } }
      })
      return changed ? next : current
    })
  }, [nodes, projects, setNodes])

  /**
   * Worktrees can appear without Toucan creating them - an agent running the worktree skill, a
   * plain `git worktree add` in a terminal. Discovery only ever adds records, so a worktree
   * Toucan already knows about, or one whose directory has gone, is left to the normal flows.
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
        if (cancelled || !result || result.worktrees.length === 0) continue

        setNodes((current) => {
          const recorded = new Set(current.filter(isWorktreeCanvasNode).map((node) => node.data.path.toLowerCase()))
          const fresh = result.worktrees.filter((worktree) => !recorded.has(worktree.path.toLowerCase()))
          if (fresh.length === 0) return current

          const claimed = new Map<string, string>()
          const added = fresh.map((worktree, index) => {
            const worktreeId = crypto.randomUUID()
            if (worktree.claimedByNodeId) claimed.set(worktree.claimedByNodeId, worktreeId)
            return {
              id: `worktree:${worktreeId}`,
              type: 'worktreeNode' as const,
              dragHandle: NODE_DRAG_HANDLE,
              deletable: false,
              position: { x: 80, y: 80 + (recorded.size + index) * (DEFAULT_WORKTREE_SIZE.height + 48) },
              data: {
                worktreeId,
                branch: worktree.branch,
                path: worktree.path,
                baseRef: worktree.baseRef,
                createdAt: new Date().toISOString(),
                projectId: project.id,
                projectName: project.name,
                projectPath: project.path,
                projectColor: project.color,
                setupCommand: project.setupCommand,
                attachedNodeCount: 0,
                onRemoveWorktree: handleRemoveWorktree,
                onCreateNodeInWorktree: handleCreateNodeInWorktree,
                onRunSetupCommand: handleRunSetupCommand
              },
              style: { ...DEFAULT_WORKTREE_SIZE }
            }
          })

          const linked =
            claimed.size === 0
              ? current
              : current.map((node) => {
                  if (!isTerminalCanvasNode(node)) return node
                  const worktreeId = claimed.get(node.id)
                  if (!worktreeId) return node
                  const branch = added.find((candidate) => candidate.data.worktreeId === worktreeId)?.data.branch
                  return { ...node, data: { ...node.data, activeWorktreeId: worktreeId, activeWorktreeBranch: branch } }
                })

          return [...linked, ...added]
        })
      }
    }

    void sweep()
    const timer = setInterval(() => void sweep(), WORKTREE_SWEEP_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [handleCreateNodeInWorktree, handleRemoveWorktree, handleRunSetupCommand, setNodes, workspaceReady])

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
      void fitView({ nodes: [target], padding: 0.32, duration: 350, maxZoom: 1.15 })
    },
    [fitView, nodes, setNodes]
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

  // A node created from the canvas runs in the project checkout; attaching to a worktree is
  // always an explicit act, either from the worktree node or by creating the worktree first.
  const createNode = useCallback(
    (kind: TerminalKind): void => {
      if (!menu || !activeProject) return
      addSessionNode({ kind, project: activeProject, position: { x: menu.flowX, y: menu.flowY } })
      setMenu(null)
    },
    [activeProject, addSessionNode, menu]
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

  const openHistoryBrowser = useCallback((): void => {
    if (!menu || !activeProject) return
    setHistoryDrop({ x: menu.flowX, y: menu.flowY })
    setMenu(null)
  }, [activeProject, menu])

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
      const identity = brainDumpPathIdentity(conversation.cwd)
      const project =
        projectsRef.current.find((candidate) => brainDumpPathIdentity(candidate.path) === identity) ??
        projectsRef.current.find((candidate) => candidate.id === activeProjectId) ??
        projectsRef.current[0]
      if (!project) return
      addSessionNode({
        kind: conversation.provider,
        project,
        position: screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }),
        label: 'Brain dump capture',
        resumeConversationId: conversation.conversationId
      })
    },
    [activeProjectId, addSessionNode, screenToFlowPosition]
  )

  const startWorktreeDraft = useCallback((): void => {
    if (!menu || !activeProject) return
    setWorktreeDraft({
      projectId: activeProject.id,
      branch: '',
      baseRef: '',
      position: { x: menu.flowX, y: menu.flowY },
      busy: false,
      error: null
    })
    setMenu(null)
  }, [activeProject, menu])

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
        const worktreeId = crypto.randomUUID()
        const created = result.worktree
        setNodes((current) => [
          ...current.map((node) => ({ ...node, selected: false })),
          {
            id: `worktree:${worktreeId}`,
            type: 'worktreeNode',
            dragHandle: NODE_DRAG_HANDLE,
            selected: true,
            // Teardown is a deliberate, evidence-gated act; the Delete key must never be able
            // to drop the record and orphan the directory git still knows about.
            deletable: false,
            position: draft.position,
            data: {
              worktreeId,
              branch: created.branch,
              path: created.path,
              baseRef: created.baseRef,
              createdAt: new Date().toISOString(),
              projectId: project.id,
              projectName: project.name,
              projectPath: project.path,
              projectColor: project.color,
              setupCommand: project.setupCommand,
              attachedNodeCount: 0,
              onRemoveWorktree: handleRemoveWorktree,
              onCreateNodeInWorktree: handleCreateNodeInWorktree,
              onRunSetupCommand: handleRunSetupCommand
            },
            style: { ...DEFAULT_WORKTREE_SIZE }
          }
        ])
        setWorktreeDraft(null)
      })
  }, [handleCreateNodeInWorktree, handleRemoveWorktree, handleRunSetupCommand, projects, setNodes, worktreeDraft])

  const saveSetupCommand = useCallback((projectId: string, command: string): void => {
    setProjects((current) =>
      current.map((project) =>
        project.id === projectId
          ? { ...project, ...(command ? { setupCommand: command } : { setupCommand: undefined }) }
          : project
      )
    )
    setSetupProjectId(null)
  }, [])

  const sendKeyPreference = useMemo(
    () => ({ sendKey: composerSendKey, setSendKey: setComposerSendKey }),
    [composerSendKey]
  )

  return (
    <ComposerSendKeyContext.Provider value={sendKeyPreference}>
      {/* One poll, every node: account usage is per provider, so a chat node reads it from here
        instead of asking for it itself. */}
      <ProviderRateLimitsContext.Provider value={providerRateLimits}>
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
                  The saved canvas and its backup were both damaged, likely by a crash or an interrupted write. Nothing
                  has been overwritten yet.
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
              {(statusSummary.working > 0 || statusSummary.stalled > 0 || unreadTotal > 0) && (
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
                </div>
              )}
              {(providerRateLimits.claude || providerRateLimits.codex) && (
                <div className="global-usage-summary">
                  {providerRateLimits.claude && (
                    <ProviderUsageChip provider="Claude" status={providerRateLimits.claude} />
                  )}
                  {providerRateLimits.codex && <ProviderUsageChip provider="Codex" status={providerRateLimits.codex} />}
                </div>
              )}
              {activeProject && (
                <span className="target-chip" title={activeProject.path}>
                  <span style={{ background: activeProject.color }} />
                  {activeProject.name}
                </span>
              )}
            </div>
          </header>

          <div className="workspace-shell">
            <aside className={`project-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
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

              <div className="project-list">
                {projects.map((project) => {
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
                      <div className={`project-row ${selected ? 'active' : ''}`}>
                        <button
                          type="button"
                          className="project-select"
                          title={sidebarCollapsed ? `${project.name}\n${project.path}` : project.path}
                          onClick={(event) => {
                            event.stopPropagation()
                            setActiveProjectId(project.id)
                            setMenu(null)
                          }}
                        >
                          <span
                            className="project-avatar"
                            style={{ '--project-color': project.color } as React.CSSProperties}
                          >
                            {project.name.slice(0, 1).toUpperCase()}
                            {projectUnread > 0 && (
                              <span className="unread-badge project-unread" title={describeUnread(projectNodeIds)}>
                                {projectUnread}
                              </span>
                            )}
                          </span>
                          {!sidebarCollapsed && (
                            <span className="project-copy">
                              <strong>{project.name}</strong>
                              <small>{project.path}</small>
                            </span>
                          )}
                        </button>
                        {!sidebarCollapsed && (
                          <div className="project-actions">
                            <button
                              type="button"
                              className="project-setup"
                              title={
                                project.setupCommand
                                  ? `Worktree setup command: ${project.setupCommand}`
                                  : 'Set a command that prepares a new worktree'
                              }
                              data-configured={project.setupCommand ? 'true' : undefined}
                              onClick={(event) => {
                                event.stopPropagation()
                                setSetupProjectId(project.id)
                                setMenu(null)
                              }}
                            >
                              <Settings aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="project-locate"
                              title={nodeCount > 0 ? `Show ${project.name} nodes` : 'No nodes on the canvas yet'}
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
                            const status = nodeStatuses[node.id] ?? (node.data.dormant ? 'dormant' : 'starting')
                            const nodeUnread = unreadByNode[node.id] ?? 0
                            return (
                              <button
                                type="button"
                                className={`project-node-row ${node.selected ? 'selected' : ''}`}
                                key={node.id}
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

              {/* Separated from the project rows on purpose: the library is global Toucan
                  functionality, not something the active project owns. */}
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
                {sidebarCollapsed && <span className="brain-dump-visually-hidden">Open brain-dump library</span>}
              </button>

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

              {!sidebarCollapsed && activeProject && (
                <div className="creation-target">
                  <small>New nodes open in</small>
                  <strong>{activeProject.name}</strong>
                  <span className="save-state" data-status={saveStatus}>
                    <span />
                    {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved locally' : 'Save failed'}
                  </span>
                  {workspaceRecovered && (
                    <span
                      className="save-state"
                      data-status="recovered"
                      title="The saved workspace was damaged or incomplete, so this canvas was restored from the last known-good backup."
                    >
                      <span />
                      Recovered from backup
                    </span>
                  )}
                </div>
              )}
            </aside>

            <section className="canvas-region">
              <ReactFlow
                nodes={nodes}
                nodeTypes={nodeTypes}
                onNodesChange={handleNodesChange}
                onPaneContextMenu={openContextMenu}
                onPaneClick={() => setMenu(null)}
                minZoom={0.25}
                maxZoom={2}
                defaultViewport={{ x: 0, y: 0, zoom: 1 }}
                colorMode="dark"
                deleteKeyCode={['Backspace', 'Delete']}
              >
                <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="#303744" />
                <Controls showInteractive={false} position="bottom-left" />
              </ReactFlow>
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
          </div>

          {menu && activeProject && (
            <div
              className="context-menu"
              style={{ left: menu.clientX, top: menu.clientY }}
              role="menu"
              onClick={(event) => event.stopPropagation()}
            >
              <p>Create in {activeProject.name}</p>
              <button type="button" role="menuitem" onClick={() => createNode('terminal')}>
                <span className="menu-icon terminal-icon">
                  <SessionKindIcon kind="terminal" />
                </span>
                <span>
                  <strong>Terminal</strong>
                  <small>Windows shell</small>
                </span>
              </button>
              <button type="button" role="menuitem" onClick={() => createNode('claude')}>
                <span className="menu-icon claude-icon">
                  <SessionKindIcon kind="claude" />
                </span>
                <span>
                  <strong>Claude</strong>
                  <small>Unified ACP chat</small>
                </span>
              </button>
              <button type="button" role="menuitem" onClick={() => createNode('codex')}>
                <span className="menu-icon codex-icon">
                  <SessionKindIcon kind="codex" />
                </span>
                <span>
                  <strong>Codex</strong>
                  <small>Unified ACP chat</small>
                </span>
              </button>
              <button type="button" role="menuitem" onClick={() => startWorktreeDraft()}>
                <span className="menu-icon worktree-icon">
                  <GitBranch aria-hidden="true" />
                </span>
                <span>
                  <strong>Worktree</strong>
                  <small>Isolated branch for parallel work</small>
                </span>
              </button>
              <button type="button" role="menuitem" onClick={() => openHistoryBrowser()}>
                <span className="menu-icon history-icon">
                  <History aria-hidden="true" />
                </span>
                <span>
                  <strong>History</strong>
                  <small>Resume a past conversation</small>
                </span>
              </button>
            </div>
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

          {removalPrompt && (
            <WorktreeRemoveDialog
              prompt={removalPrompt}
              onCancel={() => setRemovalPrompt(null)}
              onConfirm={confirmWorktreeRemoval}
            />
          )}

          {setupProject && (
            <SetupCommandDialog
              project={setupProject}
              onCancel={() => setSetupProjectId(null)}
              onSave={(command) => saveSetupCommand(setupProject.id, command)}
            />
          )}
        </main>
      </ProviderRateLimitsContext.Provider>
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
