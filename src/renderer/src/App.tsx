import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type NodeTypes
} from '@xyflow/react'
import type {
  AgentPermissionModes,
  ComposerSendKey,
  ConversationPreview,
  TerminalLiveness,
  ProjectDirectory,
  TerminalKind,
  WorkspaceProject,
  WorkspaceState
} from '../../shared/terminal'
import {
  DEFAULT_WORKTREE_SIZE,
  isTerminalCanvasNode,
  isWorktreeCanvasNode,
  restoreCanvasWorkspace,
  serializeCanvasNode,
  serializeWorktreeNode,
  type CanvasNode,
  type TerminalCanvasNode,
  type TerminalNodeStatus,
  type WorktreeCanvasNode
} from './canvas-workspace'
import type { AgentRateLimitStatus, AgentRateLimitWindow, ProviderRateLimits } from '../../shared/agent'
import type { WorktreeRemovalBlocker } from '../../shared/worktree'
import { branchNameProblem, describeWorktreeBlocker, deriveWorktreeDirectory } from '../../shared/worktree'
import { describeForcedRemovalCost, planWorktreeRemoval, type WorktreeRemovalPlan } from './worktree-removal'
import type { ConversationSummary } from '../../shared/conversation'
import ConversationHistoryDialog from './ConversationHistoryDialog'
import { COMPOSER_SEND_KEY_DEFAULT } from './composer-keys'
import { ComposerSendKeyContext } from './composer-send-key-context'
import { ProviderRateLimitsContext } from './provider-rate-limits'
import { describeRateLimitWindow } from './session-usage'
import SessionNode from './SessionNode'
import WorktreeNode from './WorktreeNode'
import { terminalLivenessLabels } from './terminal-liveness'
import { SidebarTerminalLiveness } from './TerminalLivenessPresentation'

type Project = WorkspaceProject

interface ContextMenuState {
  clientX: number
  clientY: number
  flowX: number
  flowY: number
}

interface WorktreeDraft {
  projectId: string
  branch: string
  baseRef: string
  position: { x: number; y: number }
  busy: boolean
  error: string | null
}

interface WorktreeRemovalPrompt {
  worktreeId: string
  branch: string
  path: string
  plan: WorktreeRemovalPlan
  busy: boolean
  error: string | null
}

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

/** The main process caches these reads, so this cadence only decides display freshness. */
const PROVIDER_USAGE_POLL_MS = 60_000

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
  ].filter(Boolean).join('\n')

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

function WorktreeCreateDialog({ draft, project, onChange, onCancel, onConfirm }: {
  draft: WorktreeDraft
  project: Project
  onChange(patch: Partial<WorktreeDraft>): void
  onCancel(): void
  onConfirm(): void
}): JSX.Element {
  const problem = draft.branch ? branchNameProblem(draft.branch) : null
  const directory = problem ? null : deriveWorktreeDirectory(project.path, draft.branch)

  return (
    <div className="worktree-dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="worktree-create-title" onClick={(event) => event.stopPropagation()}>
      <form
        className="worktree-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (!problem && !draft.busy) onConfirm()
        }}
      >
        <strong id="worktree-create-title">New worktree in {project.name}</strong>
        <label>
          <span>Branch name</span>
          <input
            autoFocus
            value={draft.branch}
            placeholder="feature/login"
            disabled={draft.busy}
            onChange={(event) => onChange({ branch: event.target.value, error: null })}
          />
        </label>
        <label>
          <span>Branch from</span>
          <input
            value={draft.baseRef}
            placeholder="current HEAD"
            disabled={draft.busy}
            onChange={(event) => onChange({ baseRef: event.target.value, error: null })}
          />
        </label>
        {directory && <p className="worktree-dialog-path" title={directory}>Directory: {directory}</p>}
        {problem && draft.branch.length > 0 && <p className="worktree-dialog-error">{problem}</p>}
        {draft.error && <p className="worktree-dialog-error">{draft.error}</p>}
        <div className="worktree-dialog-actions">
          <button type="button" disabled={draft.busy} onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary" disabled={draft.busy || Boolean(problem) || !draft.branch}>
            {draft.busy ? 'Creating…' : 'Create worktree'}
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * The teardown gate. It never offers a one-click removal for a worktree holding unique
 * work: it names every blocker, and only lets the user force past the ones whose cost it
 * can state exactly.
 */
function WorktreeRemoveDialog({ prompt, onCancel, onConfirm }: {
  prompt: WorktreeRemovalPrompt
  onCancel(): void
  onConfirm(force: boolean): void
}): JSX.Element {
  const { plan } = prompt
  return (
    <div className="worktree-dialog-overlay" role="alertdialog" aria-modal="true" aria-labelledby="worktree-remove-title" onClick={(event) => event.stopPropagation()}>
      <div className="worktree-dialog">
        <strong id="worktree-remove-title">Remove worktree {prompt.branch}?</strong>
        <p className="worktree-dialog-path" title={prompt.path}>{prompt.path}</p>

        {plan.decision === 'ready' && (
          <p>Nothing unique lives here: the tree is clean, and its commits are already merged or pushed.</p>
        )}
        {plan.hard.length > 0 && (
          <>
            <p>This worktree cannot be removed yet:</p>
            <ul className="worktree-blockers" data-kind="hard">
              {plan.hard.map((blocker: WorktreeRemovalBlocker, index) => (
                <li key={`${blocker.kind}-${index}`}>{describeWorktreeBlocker(blocker)}</li>
              ))}
            </ul>
          </>
        )}
        {plan.hard.length === 0 && plan.forcible.length > 0 && (
          <>
            <p>This worktree still holds work that exists nowhere else:</p>
            <ul className="worktree-blockers" data-kind="forcible">
              {plan.forcible.map((blocker: WorktreeRemovalBlocker, index) => (
                <li key={`${blocker.kind}-${index}`}>{describeWorktreeBlocker(blocker)}</li>
              ))}
            </ul>
            <p className="worktree-dialog-cost">{describeForcedRemovalCost(plan.forcible)}</p>
          </>
        )}
        {prompt.error && <p className="worktree-dialog-error">{prompt.error}</p>}

        <div className="worktree-dialog-actions">
          <button type="button" disabled={prompt.busy} onClick={onCancel}>
            {plan.decision === 'blocked' ? 'Close' : 'Cancel'}
          </button>
          {plan.decision === 'ready' && (
            <button type="button" className="primary" disabled={prompt.busy} onClick={() => onConfirm(false)}>
              {prompt.busy ? 'Removing…' : 'Remove worktree'}
            </button>
          )}
          {plan.decision === 'confirm' && (
            <button type="button" className="danger" disabled={prompt.busy} onClick={() => onConfirm(true)}>
              {prompt.busy ? 'Removing…' : 'Remove and discard'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function SetupCommandDialog({ project, onCancel, onSave }: {
  project: Project
  onCancel(): void
  onSave(command: string): void
}): JSX.Element {
  const [value, setValue] = useState(project.setupCommand ?? '')
  return (
    <div className="worktree-dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="setup-command-title" onClick={(event) => event.stopPropagation()}>
      <form
        className="worktree-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          onSave(value.trim())
        }}
      >
        <strong id="setup-command-title">Setup command for {project.name}</strong>
        <p>Run in a terminal node inside a new worktree to make it usable. Leave empty for none.</p>
        <label>
          <span>Command</span>
          <input autoFocus value={value} placeholder="npm install" onChange={(event) => setValue(event.target.value)} />
        </label>
        <div className="worktree-dialog-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary">Save</button>
        </div>
      </form>
    </div>
  )
}

function Canvas(): JSX.Element {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [nodeStatuses, setNodeStatuses] = useState<Record<string, TerminalNodeStatus>>({})
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [agentPermissionModes, setAgentPermissionModes] = useState<AgentPermissionModes>({})
  const [composerSendKey, setComposerSendKey] = useState<ComposerSendKey>(COMPOSER_SEND_KEY_DEFAULT)
  const [workspaceReady, setWorkspaceReady] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'saving' | 'saved' | 'error'>('saving')
  const [workspaceRecovered, setWorkspaceRecovered] = useState(false)
  const [workspaceUnrecoverable, setWorkspaceUnrecoverable] = useState(false)
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [worktreeDraft, setWorktreeDraft] = useState<WorktreeDraft | null>(null)
  const [removalPrompt, setRemovalPrompt] = useState<WorktreeRemovalPrompt | null>(null)
  const [setupProjectId, setSetupProjectId] = useState<string | null>(null)
  // Where a conversation picked from the history browser lands, captured when the browser opens
  // so the node still appears where the user right-clicked.
  const [historyDrop, setHistoryDrop] = useState<{ x: number; y: number } | null>(null)
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

  // A global, always-visible read on the whole workspace: no need to open a node to see
  // whether anything is still busy or looks stuck.
  const statusSummary = useMemo(() => {
    let working = 0
    let stalled = 0
    let attention = 0
    for (const status of Object.values(nodeStatuses)) {
      if (status === 'working') working += 1
      else if (status === 'stalled') stalled += 1
      else if (status === 'attention') attention += 1
    }
    return { working, stalled, attention, needsAttention: stalled + attention }
  }, [nodeStatuses])

  const [providerRateLimits, setProviderRateLimits] = useState<ProviderRateLimits>({})

  // Both providers report account usage outside any conversation, so this reads on mount rather
  // than waiting for a node to exist - the header is populated before the canvas is touched.
  useEffect(() => {
    let active = true
    const refresh = async (): Promise<void> => {
      const limits = await window.usageApi.rateLimits().catch(() => null)
      if (active && limits) setProviderRateLimits(limits)
    }
    void refresh()
    const interval = setInterval(() => void refresh(), PROVIDER_USAGE_POLL_MS)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [])

  const handleStatusChange = useCallback((nodeId: string, status: TerminalNodeStatus): void => {
    setNodeStatuses((current) => {
      if (current[nodeId] === status) return current
      return { ...current, [nodeId]: status }
    })
  }, [])

  /** Every session-node update funnels through here so worktree nodes are never mistaken for one. */
  const patchTerminalNode = useCallback(
    (nodeId: string, patch: (data: TerminalCanvasNode['data']) => Partial<TerminalCanvasNode['data']>): void => {
      setNodes((current) => current.map((node) => (
        isTerminalCanvasNode(node) && node.id === nodeId
          ? { ...node, data: { ...node.data, ...patch(node.data) } }
          : node
      )))
    },
    [setNodes]
  )

  const handleConversationId = useCallback((nodeId: string, conversationId: string): void => {
    patchTerminalNode(nodeId, () => ({ conversationId }))
  }, [patchTerminalNode])

  const handleTerminalLiveness = useCallback((nodeId: string, liveness: TerminalLiveness): void => {
    patchTerminalNode(nodeId, () => ({ terminalLiveness: liveness }))
  }, [patchTerminalNode])

  const handlePreview = useCallback((nodeId: string, preview: ConversationPreview): void => {
    patchTerminalNode(nodeId, (data) => ({
      preview: {
        ...data.preview,
        ...preview,
        user: preview.user ?? data.preview?.user,
        assistant: preview.assistant ?? data.preview?.assistant
      }
    }))
  }, [patchTerminalNode])

  const handleWorklogCollapsed = useCallback((nodeId: string, collapsed: boolean): void => {
    patchTerminalNode(nodeId, () => ({ worklogCollapsed: collapsed }))
  }, [patchTerminalNode])

  // A draft belongs to its node, so it is patched in like any other node state and rides the
  // ordinary workspace autosave out to disk.
  const handleDraftChange = useCallback((nodeId: string, draft: string): void => {
    patchTerminalNode(nodeId, (data) => (data.draft === draft ? {} : { draft }))
  }, [patchTerminalNode])

  const handlePermissionModeChange = useCallback((provider: keyof AgentPermissionModes, modeId: string): void => {
    setAgentPermissionModes((current) => current[provider] === modeId
      ? current
      : { ...current, [provider]: modeId })
    setNodes((current) => current.map((node) => (
      isTerminalCanvasNode(node) && node.data.dormant && node.data.kind === provider
        ? { ...node, data: { ...node.data, preferredPermissionMode: modeId } }
        : node
    )))
  }, [setNodes])

  // A model choice belongs to its conversation, so it is remembered per node rather than per provider.
  const handleModelChange = useCallback((nodeId: string, modelId: string): void => {
    patchTerminalNode(nodeId, () => ({ modelId }))
  }, [patchTerminalNode])

  const resumeNode = useCallback((nodeId: string): void => {
    setNodes((current) => current.map((node) => {
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
    }))
    setNodeStatuses((current) => ({ ...current, [nodeId]: 'starting' }))
  }, [setNodes])

  // Node-data callbacks must keep a stable identity or every worktree node re-renders on each
  // canvas change, so they read the latest workspace through refs instead of dependencies.
  const nodesRef = useRef<CanvasNode[]>([])
  const projectsRef = useRef<Project[]>([])
  const permissionModesRef = useRef<AgentPermissionModes>({})
  nodesRef.current = nodes
  projectsRef.current = projects
  permissionModesRef.current = agentPermissionModes

  const addSessionNode = useCallback((options: {
    kind: TerminalKind
    project: Project
    worktree?: WorktreeCanvasNode['data']
    position: { x: number; y: number }
    initialInput?: string
    label?: string
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
        selected: true,
        position,
        data: {
          kind,
          sessionId: crypto.randomUUID(),
          terminalLiveness: 'unverifiable',
          label,
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          projectColor: project.color,
          worktreeId: worktree?.worktreeId,
          worktreeBranch: worktree?.branch,
          workingDirectory: worktree?.path ?? project.path,
          conversationId,
          worklogCollapsed: kind !== 'terminal',
          preferredPermissionMode: kind === 'terminal' ? undefined : permissionModesRef.current[kind],
          dormant: false,
          launchMode: resumeConversationId ? 'resume' : 'new',
          initialInput: options.initialInput,
          onStatusChange: handleStatusChange,
          onConversationId: handleConversationId,
          onPreview: handlePreview,
          onWorklogCollapsed: handleWorklogCollapsed,
          onDraftChange: handleDraftChange,
          onPermissionModeChange: handlePermissionModeChange,
          onModelChange: handleModelChange,
          onResume: resumeNode,
          onTerminalLiveness: handleTerminalLiveness
        },
        style: { width: 520, height: 340 }
      }
    ])
    setNodeStatuses((current) => ({ ...current, [id]: 'starting' }))
  }, [handleConversationId, handleDraftChange, handleModelChange, handlePermissionModeChange, handlePreview, handleStatusChange, handleTerminalLiveness, handleWorklogCollapsed, resumeNode, setNodes])

  const findWorktreeNode = useCallback((worktreeId: string): WorktreeCanvasNode | undefined => (
    nodesRef.current.filter(isWorktreeCanvasNode).find((node) => node.data.worktreeId === worktreeId)
  ), [])

  /** New sessions land beside their worktree node, fanned out so they do not stack on one spot. */
  const openInWorktree = useCallback((worktreeId: string, kind: TerminalKind, initialInput?: string): void => {
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
  }, [addSessionNode, findWorktreeNode])

  const handleCreateNodeInWorktree = useCallback((worktreeId: string, kind: TerminalKind): void => {
    openInWorktree(worktreeId, kind)
  }, [openInWorktree])

  const handleRunSetupCommand = useCallback((worktreeId: string): void => {
    const worktreeNode = findWorktreeNode(worktreeId)
    const command = worktreeNode?.data.setupCommand?.trim()
    if (!command) return
    // A visible terminal node, not a hidden background process: setup can fail, prompt, or
    // hang, and the user needs to see it and be able to interrupt it.
    openInWorktree(worktreeId, 'terminal', `${command}\r`)
  }, [findWorktreeNode, openInWorktree])

  const handleRemoveWorktree = useCallback((worktreeId: string): void => {
    const worktreeNode = findWorktreeNode(worktreeId)
    const project = projectsRef.current.find((candidate) => candidate.id === worktreeNode?.data.projectId)
    if (!worktreeNode || !project) return

    const attached = worktreeNode.data.attachedNodeCount
    const open = (blockers: WorktreeRemovalBlocker[]): void => setRemovalPrompt({
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
    void window.worktreeApi
      .remove({
        projectPath: project.path,
        path: worktreeNode.data.path,
        branch: worktreeNode.data.branch,
        baseRef: worktreeNode.data.baseRef
      })
      .then((result) => {
        if (result.ok) {
          setNodes((current) => current.filter(
            (node) => !(isWorktreeCanvasNode(node) && node.data.worktreeId === worktreeId)
          ))
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
  }, [findWorktreeNode, setNodes])

  const confirmWorktreeRemoval = useCallback((force: boolean): void => {
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
          setNodes((current) => current.filter(
            (node) => !(isWorktreeCanvasNode(node) && node.data.worktreeId === prompt.worktreeId)
          ))
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
  }, [findWorktreeNode, removalPrompt, setNodes])

  const seedFreshWorkspace = useCallback(async (): Promise<void> => {
    const directory = await window.terminalApi.getInitialProject()
    const project = createProject(directory, 0)
    setProjects([project])
    setActiveProjectId(project.id)
  }, [])

  const acknowledgeUnrecoverableWorkspace = useCallback((): void => {
    void seedFreshWorkspace().then(() => {
      setWorkspaceUnrecoverable(false)
      setWorkspaceReady(true)
    })
  }, [seedFreshWorkspace])

  useEffect(() => {
    let active = true
    void (async () => {
      const { state: saved, recovered, unrecoverable } = await window.terminalApi.loadWorkspace()
      if (!active) return
      setWorkspaceRecovered(recovered)

      if (saved && saved.projects.length > 0) {
        const restored = restoreCanvasWorkspace(saved, {
          onStatusChange: handleStatusChange,
          onConversationId: handleConversationId,
          onPreview: handlePreview,
          onWorklogCollapsed: handleWorklogCollapsed,
          onDraftChange: handleDraftChange,
          onPermissionModeChange: handlePermissionModeChange,
          onModelChange: handleModelChange,
          onResume: resumeNode,
          onTerminalLiveness: handleTerminalLiveness,
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
        setAgentPermissionModes(saved.agentPermissionModes ?? {})
        setComposerSendKey(saved.composerSendKey ?? COMPOSER_SEND_KEY_DEFAULT)
      } else if (unrecoverable) {
        // Never silently seed and autosave a fresh default over damaged state the user might
        // still be able to recover by hand; wait for an explicit acknowledgement instead.
        setWorkspaceUnrecoverable(true)
        return
      } else {
        await seedFreshWorkspace()
        if (!active) return
      }
      setWorkspaceReady(true)
    })()
    return () => { active = false }
  }, [handleConversationId, handleCreateNodeInWorktree, handleDraftChange, handleModelChange, handlePermissionModeChange, handlePreview, handleRemoveWorktree, handleRunSetupCommand, handleStatusChange, handleTerminalLiveness, handleWorklogCollapsed, resumeNode, seedFreshWorkspace, setNodes])

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

  useEffect(() => {
    if (!workspaceReady) return
    setSaveStatus('saving')
    const timeout = setTimeout(() => {
      const state: WorkspaceState = {
        version: 3,
        projects,
        activeProjectId,
        sidebarCollapsed,
        agentPermissionModes,
        composerSendKey,
        nodes: nodes.filter(isTerminalCanvasNode).map(serializeCanvasNode),
        worktrees: nodes.filter(isWorktreeCanvasNode).map(serializeWorktreeNode)
      }
      void window.terminalApi.saveWorkspace(state).then((result) => {
        setSaveStatus(result.ok ? 'saved' : 'error')
      })
    }, 180)
    return () => clearTimeout(timeout)
  }, [activeProjectId, agentPermissionModes, composerSendKey, nodes, projects, sidebarCollapsed, workspaceReady])

  const addProject = useCallback(async (): Promise<void> => {
    const directory = await window.terminalApi.pickProject()
    if (!directory) return

    const existing = projects.find(
      (project) => project.path.toLocaleLowerCase() === directory.path.toLocaleLowerCase()
    )
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

  const locateProject = useCallback((projectId: string): void => {
    const matchingNodes = nodes.filter((node) => node.data.projectId === projectId)
    if (matchingNodes.length > 0) {
      void fitView({ nodes: matchingNodes, padding: 0.28, duration: 350 })
    }
  }, [fitView, nodes])

  const removeProject = useCallback((projectId: string): void => {
    if (projects.length <= 1 || nodes.some((node) => node.data.projectId === projectId)) return
    const remaining = projects.filter((project) => project.id !== projectId)
    setProjects(remaining)
    if (activeProjectId === projectId) setActiveProjectId(remaining[0].id)
    setMenu(null)
  }, [activeProjectId, nodes, projects])

  const focusNode = useCallback((nodeId: string): void => {
    const target = nodes.find((node) => node.id === nodeId)
    if (!target) return

    // Selecting a node is enough: each node reports its own status once it sees the focus.
    setNodes((current) => current.map((node) => ({ ...node, selected: node.id === nodeId })))
    setMenu(null)
    void fitView({ nodes: [target], padding: 0.32, duration: 350, maxZoom: 1.15 })
  }, [fitView, nodes, setNodes])

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
      labelsByPath[node.data.path.toLocaleLowerCase()] = `⑂ ${node.data.branch}`
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
  const openHistoryConversation = useCallback((entry: ConversationSummary): void => {
    const project = projectsRef.current.find((candidate) => candidate.id === activeProjectId)
      ?? projectsRef.current[0]
    if (!project || !historyDrop) return
    const worktreeNode = nodesRef.current
      .filter(isWorktreeCanvasNode)
      .find((node) => node.data.path.toLocaleLowerCase() === entry.cwd.toLocaleLowerCase())
    addSessionNode({
      kind: entry.provider,
      project,
      worktree: worktreeNode?.data,
      position: historyDrop,
      label: entry.title.slice(0, 48),
      resumeConversationId: entry.id
    })
    setHistoryDrop(null)
  }, [activeProjectId, addSessionNode, historyDrop])

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
    setProjects((current) => current.map((project) => (
      project.id === projectId
        ? { ...project, ...(command ? { setupCommand: command } : { setupCommand: undefined }) }
        : project
    )))
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
        <div className="unrecoverable-workspace-overlay" role="alertdialog" aria-modal="true" aria-labelledby="unrecoverable-workspace-title">
          <div className="unrecoverable-workspace-dialog">
            <strong id="unrecoverable-workspace-title">Your saved workspace could not be recovered</strong>
            <p>
              The saved canvas and its backup were both damaged, likely by a crash or an interrupted
              write. Nothing has been overwritten yet.
            </p>
            <button type="button" onClick={() => acknowledgeUnrecoverableWorkspace()}>
              Start a new workspace
            </button>
          </div>
        </div>
      )}
      <header className="app-header">
        <div>
          <span className="brand-mark" aria-hidden="true" />
          <strong>ADE</strong>
          <span className="prototype-label">canvas agent prototype</span>
        </div>
        <div className="header-target">
          {(statusSummary.working > 0 || statusSummary.needsAttention > 0) && (
            <div className="global-status-summary" role="status">
              {statusSummary.working > 0 && (
                <span className="global-status-chip" data-kind="working">
                  <span className="global-status-dot" />
                  {statusSummary.working} working
                </span>
              )}
              {statusSummary.needsAttention > 0 && (
                <span
                  className="global-status-chip"
                  data-kind="attention"
                  title={[
                    statusSummary.stalled > 0 ? `${statusSummary.stalled} may be stuck` : null,
                    statusSummary.attention > 0 ? `${statusSummary.attention} waiting on you` : null
                  ].filter(Boolean).join(' · ')}
                >
                  <span className="global-status-dot" />
                  {statusSummary.needsAttention} need attention
                </span>
              )}
            </div>
          )}
          {(providerRateLimits.claude || providerRateLimits.codex) && (
            <div className="global-usage-summary">
              {providerRateLimits.claude && (
                <ProviderUsageChip provider="Claude" status={providerRateLimits.claude} />
              )}
              {providerRateLimits.codex && (
                <ProviderUsageChip provider="Codex" status={providerRateLimits.codex} />
              )}
            </div>
          )}
          <span className="hint">Right-click to create a session</span>
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
              {sidebarCollapsed ? '›' : '‹'}
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
                      <span className="project-avatar" style={{ '--project-color': project.color } as React.CSSProperties}>
                        {project.name.slice(0, 1).toUpperCase()}
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
                          title={project.setupCommand
                            ? `Worktree setup command: ${project.setupCommand}`
                            : 'Set a command that prepares a new worktree'}
                          data-configured={project.setupCommand ? 'true' : undefined}
                          onClick={(event) => {
                            event.stopPropagation()
                            setSetupProjectId(project.id)
                            setMenu(null)
                          }}
                        >
                          ⚙
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
                          title={nodeCount > 0
                            ? 'Delete this project’s nodes first'
                            : projects.length === 1
                              ? 'ADE needs at least one project'
                              : `Remove ${project.name}`}
                          disabled={nodeCount > 0 || projects.length === 1}
                          onClick={(event) => {
                            event.stopPropagation()
                            removeProject(project.id)
                          }}
                        >
                          &times;
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
                          <span className="project-node-kind">⑂</span>
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
                        return (
                          <button
                            type="button"
                            className={`project-node-row ${node.selected ? 'selected' : ''}`}
                            key={node.id}
                            title={`Focus ${node.data.label} · ${statusLabels[status]}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              focusNode(node.id)
                            }}
                          >
                            <span className="project-node-kind">{node.data.kind === 'terminal' ? '>_' : node.data.kind === 'claude' ? 'C' : '<>'}</span>
                            <span className="project-node-name">{node.data.label}</span>
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

          <button
            type="button"
            className="add-project"
            title="Add project folder"
            onClick={(event) => {
              event.stopPropagation()
              void addProject()
            }}
          >
            <span>+</span>{!sidebarCollapsed && 'Add project'}
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
                <span className="save-state" data-status="recovered" title="The saved workspace was damaged or incomplete, so this canvas was restored from the last known-good backup.">
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
            onNodesChange={onNodesChange}
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
            <span className="menu-icon terminal-icon">&gt;_</span>
            <span><strong>Terminal</strong><small>Windows shell</small></span>
          </button>
          <button type="button" role="menuitem" onClick={() => createNode('claude')}>
            <span className="menu-icon claude-icon">C</span>
            <span><strong>Claude</strong><small>Unified ACP chat</small></span>
          </button>
          <button type="button" role="menuitem" onClick={() => createNode('codex')}>
            <span className="menu-icon codex-icon">&lt;&gt;</span>
            <span><strong>Codex</strong><small>Unified ACP chat</small></span>
          </button>
          <button type="button" role="menuitem" onClick={() => startWorktreeDraft()}>
            <span className="menu-icon worktree-icon">⑂</span>
            <span><strong>Worktree</strong><small>Isolated branch for parallel work</small></span>
          </button>
          <button type="button" role="menuitem" onClick={() => openHistoryBrowser()}>
            <span className="menu-icon history-icon">↺</span>
            <span><strong>History</strong><small>Resume a past conversation</small></span>
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
