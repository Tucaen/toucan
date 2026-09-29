import type { Connection, Edge } from '@xyflow/react'
import { Link2 } from 'lucide-react'
import { createContext, useContext, useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { isChatCanvasNode, isTerminalCanvasNode, isWorktreeCanvasNode, type CanvasNode } from './canvas-workspace'
import { ModalDialog } from './ModalDialog'
import { isValidTerminalContextConnection } from './terminal-context-edges'

const ConnectionsContext = createContext<{
  edges: readonly Edge[]
  openId: string | null
  onOpen: (nodeId: string) => void
} | null>(null)

/** A visible, keyboard-accessible route to relationships even when their ends use different canvases. */
export function SessionConnectionsButton({ nodeId, label }: { nodeId: string; label: string }): JSX.Element | null {
  const context = useContext(ConnectionsContext)
  if (!context) return null
  const count = context.edges.filter((edge) => edge.source === nodeId || edge.target === nodeId).length
  return (
    <button
      type="button"
      className="node-action nodrag session-connections-button"
      aria-label={`Connections for ${label} (${count})`}
      aria-haspopup="dialog"
      aria-expanded={context.openId === nodeId}
      title="Manage terminal access and view conversation branches, including other canvases"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        context.onOpen(nodeId)
      }}
    >
      <Link2 size={14} aria-hidden="true" />
      {count > 0 && <span>{count}</span>}
    </button>
  )
}

/**
 * Views the workspace's existing edge set, never a second relationship store. A grant is changed
 * only by an explicit button or canvas connection; moving an endpoint affects its location label
 * and line drawing, not its authority. Lineage arrives as the same read-only projection the canvas uses.
 */
export function SessionConnectionsProvider({
  nodes,
  edges,
  onConnect,
  onDisconnect,
  onReveal,
  children
}: {
  nodes: readonly CanvasNode[]
  edges: readonly Edge[]
  onConnect: (connection: Connection) => void
  onDisconnect: (edgeId: string) => void
  onReveal: (nodeId: string) => void
  children: ReactNode
}): JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null)
  const headingId = useId()
  const node = nodes.find((candidate) => candidate.id === openId)
  const session = node && isTerminalCanvasNode(node) ? node : undefined
  const close = (): void => setOpenId(null)
  const location = (candidate: CanvasNode): string => {
    if (!isTerminalCanvasNode(candidate)) return ''
    const host = nodes.find(
      (other) => isWorktreeCanvasNode(other) && other.data.worktreeId === candidate.data.worktreeId
    )
    return `${candidate.data.projectName} / ${host && isWorktreeCanvasNode(host) ? host.data.branch : 'Main canvas'}`
  }
  const candidates = session
    ? nodes.filter((candidate) =>
        isValidTerminalContextConnection(nodes, {
          source: session.data.kind === 'terminal' ? session.id : candidate.id,
          target: session.data.kind === 'terminal' ? candidate.id : session.id
        })
      )
    : []
  const branches = session
    ? edges.filter(
        (edge) => edge.className === 'lineage-edge' && (edge.source === session.id || edge.target === session.id)
      )
    : []

  return (
    <ConnectionsContext.Provider value={{ edges, openId, onOpen: setOpenId }}>
      {children}
      {session &&
        createPortal(
          <ModalDialog labelledBy={headingId} onClose={close}>
            <div className="dialog session-connections-dialog">
              <h2 id={headingId}>Connections for {session.data.label}</h2>
              <p>{location(session)}</p>
              <h3>Terminal access</h3>
              <p>
                {session.data.kind === 'terminal'
                  ? 'Choose which chats may read this terminal’s output.'
                  : 'Choose which terminals this chat may read.'}{' '}
                Access is read-only and lasts until disconnected or either node is closed. A running chat adopts new
                access between turns.
              </p>
              {candidates.length === 0 && (
                <p>No {session.data.kind === 'terminal' ? 'chats' : 'terminals'} on the workspace yet.</p>
              )}
              <ul className="session-connections-list">
                {candidates.filter(isTerminalCanvasNode).map((candidate) => {
                  const source = session.data.kind === 'terminal' ? session.id : candidate.id
                  const target = session.data.kind === 'terminal' ? candidate.id : session.id
                  const edge = edges.find((existing) => existing.source === source && existing.target === target)
                  return (
                    <li key={candidate.id}>
                      <span>
                        <strong>{candidate.data.label}</strong>
                        <small>{location(candidate)}</small>
                      </span>
                      <button
                        type="button"
                        aria-label={`${edge ? 'Disconnect' : 'Connect'} ${candidate.data.label}`}
                        onClick={() =>
                          edge
                            ? onDisconnect(edge.id)
                            : onConnect({ source, target, sourceHandle: null, targetHandle: null })
                        }
                      >
                        {edge ? 'Disconnect' : 'Connect'}
                      </button>
                    </li>
                  )
                })}
              </ul>
              {isChatCanvasNode(session) && (
                <>
                  <h3>Conversation branches</h3>
                  <p>Branch history grants no terminal access.</p>
                  {branches.length === 0 && <p>No related conversations on the workspace.</p>}
                  <ul className="session-connections-list">
                    {branches.map((edge) => {
                      const parent = edge.target === session.id
                      const related = nodes.find((candidate) => candidate.id === (parent ? edge.source : edge.target))
                      if (!related || !isChatCanvasNode(related)) return null
                      return (
                        <li key={edge.id}>
                          <span>
                            <strong>
                              {parent ? 'Branched from' : 'Branch'}: {related.data.label}
                            </strong>
                            <small>{location(related)}</small>
                          </span>
                          <button
                            type="button"
                            aria-label={`Show ${related.data.label}`}
                            onClick={() => {
                              close()
                              onReveal(related.id)
                            }}
                          >
                            Show
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </>
              )}
              <div className="dialog-actions">
                <button type="button" onClick={close}>
                  Done
                </button>
              </div>
            </div>
          </ModalDialog>,
          document.body
        )}
    </ConnectionsContext.Provider>
  )
}
