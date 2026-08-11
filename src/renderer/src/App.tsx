import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Node,
  type NodeTypes
} from '@xyflow/react'
import type { ProjectDirectory, TerminalKind } from '../../shared/terminal'
import TerminalNode from './TerminalNode'

interface Project extends ProjectDirectory {
  id: string
  color: string
}

export interface TerminalNodeData extends Record<string, unknown> {
  kind: TerminalKind
  label: string
  projectId: string
  projectName: string
  projectPath: string
  projectColor: string
}

export type TerminalCanvasNode = Node<TerminalNodeData, 'terminalNode'>

interface ContextMenuState {
  clientX: number
  clientY: number
  flowX: number
  flowY: number
}

const nodeTypes: NodeTypes = { terminalNode: TerminalNode }

const labels: Record<TerminalKind, string> = {
  terminal: 'Terminal',
  claude: 'Claude Code',
  codex: 'Codex'
}

const projectColors = ['#71a9ff', '#e69a71', '#74d8a2', '#c992ff', '#f1c75b', '#e8799b']

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
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const { fitView, screenToFlowPosition } = useReactFlow()

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? projects[0],
    [activeProjectId, projects]
  )

  useEffect(() => {
    let active = true
    void window.terminalApi.getInitialProject().then((directory) => {
      if (!active) return
      const project = createProject(directory, 0)
      setProjects([project])
      setActiveProjectId(project.id)
    })
    return () => { active = false }
  }, [])

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
      setNodes((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          type: 'terminalNode',
          position: { x: menu.flowX, y: menu.flowY },
          data: {
            kind,
            label: labels[kind],
            projectId: activeProject.id,
            projectName: activeProject.name,
            projectPath: activeProject.path,
            projectColor: activeProject.color
          },
          style: { width: 520, height: 340 }
        }
      ])
      setMenu(null)
    },
    [activeProject, menu, setNodes]
  )

  return (
    <main className="app-shell" onClick={() => setMenu(null)}>
      <header className="app-header">
        <div>
          <span className="brand-mark" aria-hidden="true" />
          <strong>ADE</strong>
          <span className="prototype-label">canvas terminal prototype</span>
        </div>
        <div className="header-target">
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
              const nodeCount = nodes.filter((node) => node.data.projectId === project.id).length
              const selected = project.id === activeProject?.id
              return (
                <div className={`project-row ${selected ? 'active' : ''}`} key={project.id}>
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
            <span><strong>Claude Code</strong><small>Launch claude CLI</small></span>
          </button>
          <button type="button" role="menuitem" onClick={() => createNode('codex')}>
            <span className="menu-icon codex-icon">&lt;&gt;</span>
            <span><strong>Codex</strong><small>Launch codex CLI</small></span>
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
