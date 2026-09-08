import { createContext, useContext, useEffect, useRef } from 'react'

/**
 * How the canvas asks one node to open its own search. The canvas owns the shortcut - only it
 * knows which node the reader is on, and which dialogs are in the way - while what "search" means
 * belongs to the node: rendered prose gets a find bar, a CodeMirror editor gets its own panel.
 * The nonce is what makes a repeated Ctrl+F on an already-open search re-focus it.
 */
export interface NodeSearchRequest {
  nodeId: string | null
  nonce: number
}

export const NO_NODE_SEARCH_REQUEST: NodeSearchRequest = { nodeId: null, nonce: 0 }

export const NodeSearchContext = createContext<NodeSearchRequest>(NO_NODE_SEARCH_REQUEST)

/**
 * Calls `onOpen` once per search request addressed to this node. Whatever the canvas last asked of
 * some node is already spent by the time a node mounts, and a request must also survive re-runs
 * the caller's own state changes cause, so each nonce is honoured exactly once. What "open" means
 * stays with the node: `onOpen` decides which surface searches, or refuses while the node is in a
 * state that cannot.
 */
export function useNodeSearchRequest(nodeId: string, onOpen: () => void): void {
  const request = useContext(NodeSearchContext)
  const handledNonce = useRef(request.nonce)
  useEffect(() => {
    if (request.nodeId !== nodeId || request.nonce === handledNonce.current) return
    handledNonce.current = request.nonce
    onOpen()
  }, [nodeId, onOpen, request])
}
