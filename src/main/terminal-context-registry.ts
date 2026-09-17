import { TERMINAL_CONTEXT_CHANNELS } from '../shared/ipc-channels'
import { parseTerminalContextEdges, type TerminalContextEdge } from '../shared/terminal-context'
import type { IpcEventRegistrar } from './ipc-registrar'

/**
 * Main's copy of the canvas's terminal-context edges, injected at the composition root like the
 * event broker. Main is the privilege boundary: every terminal read the future MCP tool serves is
 * checked against this registry *at call time*, so a tool definition being present in a session
 * never implies the capability - only a currently standing edge does.
 *
 * The renderer replaces the full set on every change (see `shared/terminal-context.ts` for why a
 * full-set replace rather than deltas), which is also what revokes: an edge absent from the newest
 * set is gone, whether it was deleted, its node closed, or the renderer reloaded into an empty
 * canvas. There is nothing to persist and nothing to prune on a timer - the set is exactly what
 * the last publish said it is.
 */
export interface TerminalContextRegistry {
  replaceEdges(edges: TerminalContextEdge[]): void
  /** Whether `agentId` may read `terminalSessionId` right now. The call-time capability check. */
  hasEdge(agentId: string, terminalSessionId: string): boolean
  /** Every terminal the agent is connected to, in publish order - the tool's "connected set". */
  terminalSessionIdsFor(agentId: string): string[]
}

export function createTerminalContextRegistry(): TerminalContextRegistry {
  let edges: readonly TerminalContextEdge[] = []
  return {
    replaceEdges(next) {
      edges = parseTerminalContextEdges(next)
    },
    hasEdge(agentId, terminalSessionId) {
      return edges.some((edge) => edge.agentId === agentId && edge.terminalSessionId === terminalSessionId)
    },
    terminalSessionIdsFor(agentId) {
      return edges.filter((edge) => edge.agentId === agentId).map((edge) => edge.terminalSessionId)
    }
  }
}

/**
 * Fire-and-forget on purpose: the renderer needs no verdict, and the newest publish always wins.
 * Validation is `replaceEdges`'s own (it parses whatever it is handed), so the handler forwards raw.
 */
export function registerTerminalContextIpc(ipc: IpcEventRegistrar, registry: TerminalContextRegistry): void {
  ipc.on(TERMINAL_CONTEXT_CHANNELS.replaceEdges, (_event, edges) => {
    registry.replaceEdges(edges as TerminalContextEdge[])
  })
}
