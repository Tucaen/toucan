import { createContext, useContext } from 'react'

/**
 * Whether the user switched the command guard off for every new session (ticket 03). A node's own
 * switch (ticket 04) cannot turn it back on, so the composer menu shows that switch off and locked.
 */
export const CommandGuardGloballyOffContext = createContext(false)

export function useCommandGuardGloballyOff(): boolean {
  return useContext(CommandGuardGloballyOffContext)
}
