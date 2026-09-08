import { createContext } from 'react'

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
