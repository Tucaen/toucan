import { createContext } from 'react'

/**
 * How a surface deep inside a node - a transcript's file card - asks the canvas to open a file
 * as a node beside it. Null where no canvas is behind the surface (tests, the mobile projection),
 * so the "Open" affordance only appears where it can do something.
 */
export const OpenFileContext = createContext<((path: string) => void) | null>(null)
