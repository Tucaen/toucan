import { createContext } from 'react'

/**
 * The directories a chat's paths are worth showing relative to: the one the agent actually runs
 * in (the worktree when the node has one) and the project checkout it belongs to. Tool cards
 * shorten absolute paths against them, and they sit deep inside the shell's rendering, so they
 * travel as context rather than through every card signature.
 */
export const WorkspaceRootsContext = createContext<readonly string[]>([])
