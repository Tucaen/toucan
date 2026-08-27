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
  ConversationPreview,
  TerminalLiveness,
  ProjectDirectory,
  TerminalKind,
  WorkspaceProject,
  WorkspaceState
} from '../../shared/terminal'
import {
  restoreCanvasWorkspace,
  serializeCanvasNode,
  type TerminalCanvasNode,
  type TerminalNodeStatus
} from './canvas-workspace'
import type { AgentRateLimitStatus, AgentRateLimitWindow, ProviderRateLimits } from '../../shared/agent'
import SessionNode from './SessionNode'
import { terminalLivenessLabels } from './terminal-liveness'
import { SidebarTerminalLiveness } from './TerminalLivenessPresentation'

type Project = WorkspaceProject

interface ContextMenuState {
  clientX: number
  clientY: number
  flowX: number
  flowY: number
}

const nodeTypes: NodeTypes = { terminalNode: SessionNode }

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

function formatResetsAt(epochMs: number): string {
  const delta = epochMs - Date.now()
  if (delta <= 0) return 'now'
  const minutes = Math.ceil(delta / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

function UsageWindow({ label, window }: { label: string; window: AgentRateLimitWindow }): JSX.Element {
  const percent = Math.max(0, Math.min(100, window.usedPercent))
  const kind = percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : 'normal'
  return (
    <span className="usage-window" data-kind={kind}>
      <span className="usage-window-label">{label}</span>
      <span className="usage-window-bar">
        <span className="usage-window-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="usage-window-pct">{Math.round(percent)}%</span>
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
    status.fiveHour ? `5h: ${Math.round(status.fiveHour.usedPercent)}%${status.fiveHour.resetsAt ? ` (resets in ${formatResetsAt(status.fiveHour.resetsAt)})` : ''}` : null,
    status.weekly ? `Weekly: ${Math.round(status.weekly.usedPercent)}%${status.weekly.resetsAt ? ` (resets in ${formatResetsAt(status.weekly.resetsAt)})` : ''}` : null,
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

function Canvas(): JSX.Element {
  const [nodes, setNodes, onNodesChange] = useNodesState<TerminalCanvasNode>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [nodeStatuses, setNodeStatuses] = useState<Record<string, TerminalNodeStatus>>({})
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [agentPermissionModes, setAgentPermissionModes] = useState<AgentPermissionModes>({})
  const [workspaceReady, setWorkspaceReady] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'saving' | 'saved' | 'error'>('saving')
  const [workspaceRecovered, setWorkspaceRecovered] = useState(false)
  const [workspaceUnrecoverable, setWorkspaceUnrecoverable] = useState(false)
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const { fitView, screenToFlowPosition } = useReactFlow()
  const nextSessionNumber = useRef(1)

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? projects[0],
    [activeProjectId, projects]
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

  const handleConversationId = useCallback((nodeId: string, conversationId: string): void => {
    setNodes((current) => current.map((node) => node.id === nodeId
      ? { ...node, data: { ...node.data, conversationId } }
      : node))
  }, [setNodes])

  const handleTerminalLiveness = useCallback((nodeId: string, liveness: TerminalLiveness): void => {
    setNodes((current) => current.map((node) => node.id === nodeId
      ? { ...node, data: { ...node.data, terminalLiveness: liveness } }
      : node))
  }, [setNodes])

  const handlePreview = useCallback((nodeId: string, preview: ConversationPreview): void => {
    setNodes((current) => current.map((node) => node.id === nodeId
      ? {
          ...node,
          data: {
            ...node.data,
            preview: {
              ...node.data.preview,
              ...preview,
              user: preview.user ?? node.data.preview?.user,
              assistant: preview.assistant ?? node.data.preview?.assistant
            }
          }
        }
      : node))
  }, [setNodes])

  const handleWorklogCollapsed = useCallback((nodeId: string, collapsed: boolean): void => {
    setNodes((current) => current.map((node) => node.id === nodeId
      ? { ...node, data: { ...node.data, worklogCollapsed: collapsed } }
      : node))
  }, [setNodes])

  const handlePermissionModeChange = useCallback((provider: keyof AgentPermissionModes, modeId: string): void => {
    setAgentPermissionModes((current) => current[provider] === modeId
      ? current
      : { ...current, [provider]: modeId })
    setNodes((current) => current.map((node) => node.data.dormant && node.data.kind === provider
      ? { ...node, data: { ...node.data, preferredPermissionMode: modeId } }
      : node))
  }, [setNodes])

  // A model choice belongs to its conversation, so it is remembered per node rather than per provider.
  const handleModelChange = useCallback((nodeId: string, modelId: string): void => {
    setNodes((current) => current.map((node) => node.id === nodeId
      ? { ...node, data: { ...node.data, modelId } }
      : node))
  }, [setNodes])

  const resumeNode = useCallback((nodeId: string): void => {
    setNodes((current) => current.map((node) => node.id === nodeId
      ? {
          ...node,
          selected: true,
          data: {
            ...node.data,
            dormant: false,
            launchMode: node.data.kind === 'terminal' || node.data.conversationId ? 'resume' : 'new'
          }
        }
      : { ...node, selected: false }))
    setNodeStatuses((current) => ({ ...current, [nodeId]: 'starting' }))
  }, [setNodes])

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
          onPermissionModeChange: handlePermissionModeChange,
          onModelChange: handleModelChange,
          onResume: resumeNode,
          onTerminalLiveness: handleTerminalLiveness
        })

        setProjects(saved.projects)
        setNodes(restored.nodes)
        setNodeStatuses(restored.statuses)
        nextSessionNumber.current = restored.nextSessionNumber
        setActiveProjectId(restored.activeProjectId)
        setSidebarCollapsed(saved.sidebarCollapsed)
        setAgentPermissionModes(saved.agentPermissionModes ?? {})
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
  }, [handleConversationId, handleModelChange, handlePermissionModeChange, handlePreview, handleStatusChange, handleTerminalLiveness, handleWorklogCollapsed, resumeNode, seedFreshWorkspace, setNodes])

  useEffect(() => {
    if (!workspaceReady) return
    setSaveStatus('saving')
    const timeout = setTimeout(() => {
      const state: WorkspaceState = {
        version: 2,
        projects,
        activeProjectId,
        sidebarCollapsed,
        agentPermissionModes,
        nodes: nodes.map(serializeCanvasNode)
      }
      void window.terminalApi.saveWorkspace(state).then((result) => {
        setSaveStatus(result.ok ? 'saved' : 'error')
      })
    }, 180)
    return () => clearTimeout(timeout)
  }, [activeProjectId, agentPermissionModes, nodes, projects, sidebarCollapsed, workspaceReady])

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

  const createNode = useCallback(
    (kind: TerminalKind): void => {
      if (!menu || !activeProject) return
      const id = crypto.randomUUID()
      const label = `${labels[kind]} ${nextSessionNumber.current}`
      const conversationId = kind === 'claude' ? crypto.randomUUID() : undefined
      nextSessionNumber.current += 1
      setNodes((current) => [
        ...current.map((node) => ({ ...node, selected: false })),
        {
          id,
          type: 'terminalNode',
          selected: true,
          position: { x: menu.flowX, y: menu.flowY },
          data: {
            kind,
            sessionId: crypto.randomUUID(),
            terminalLiveness: 'unverifiable',
            label,
            projectId: activeProject.id,
            projectName: activeProject.name,
            projectPath: activeProject.path,
            projectColor: activeProject.color,
            conversationId,
            worklogCollapsed: kind !== 'terminal',
            preferredPermissionMode: kind === 'terminal' ? undefined : agentPermissionModes[kind],
            dormant: false,
            launchMode: 'new',
            onStatusChange: handleStatusChange,
            onConversationId: handleConversationId,
            onPreview: handlePreview,
            onWorklogCollapsed: handleWorklogCollapsed,
            onPermissionModeChange: handlePermissionModeChange,
            onModelChange: handleModelChange,
            onResume: resumeNode,
            onTerminalLiveness: handleTerminalLiveness
          },
          style: { width: 520, height: 340 }
        }
      ])
      setNodeStatuses((current) => ({ ...current, [id]: 'starting' }))
      setMenu(null)
    },
    [activeProject, agentPermissionModes, handleConversationId, handleModelChange, handlePermissionModeChange, handlePreview, handleStatusChange, handleTerminalLiveness, handleWorklogCollapsed, menu, resumeNode, setNodes]
  )

  return (
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
              const projectNodes = nodes.filter((node) => node.data.projectId === project.id)
              const nodeCount = projectNodes.length
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
        </div>
      )}
    </main>
  )
}

export default function App(): JSX.Element {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  )
}
