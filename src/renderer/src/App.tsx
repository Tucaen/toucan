import { useCallback, useState, type MouseEvent as ReactMouseEvent } from 'react'
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
import type { TerminalKind } from '../../shared/terminal'
import TerminalNode from './TerminalNode'

export interface TerminalNodeData extends Record<string, unknown> {
  kind: TerminalKind
  label: string
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

function Canvas(): JSX.Element {
  const [nodes, setNodes, onNodesChange] = useNodesState<TerminalCanvasNode>([])
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const { screenToFlowPosition } = useReactFlow()

  const openContextMenu = useCallback(
    (event: MouseEvent | ReactMouseEvent): void => {
      event.preventDefault()
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      setMenu({
        clientX: event.clientX,
        clientY: event.clientY,
        flowX: position.x,
        flowY: position.y
      })
    },
    [screenToFlowPosition]
  )

  const createNode = useCallback(
    (kind: TerminalKind): void => {
      if (!menu) return
      setNodes((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          type: 'terminalNode',
          position: { x: menu.flowX, y: menu.flowY },
          data: { kind, label: labels[kind] },
          style: { width: 520, height: 340 }
        }
      ])
      setMenu(null)
    },
    [menu, setNodes]
  )

  return (
    <main className="app-shell" onClick={() => setMenu(null)}>
      <header className="app-header">
        <div>
          <span className="brand-mark" aria-hidden="true" />
          <strong>ADE</strong>
          <span className="prototype-label">canvas terminal prototype</span>
        </div>
        <span className="hint">Right-click anywhere to create a session</span>
      </header>

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

      {menu && (
        <div
          className="context-menu"
          style={{ left: menu.clientX, top: menu.clientY }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
        >
          <p>Start session</p>
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
