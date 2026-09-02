import { createContext } from 'react'

export const NodeFitContext = createContext<(nodeId: string) => void>(() => undefined)
