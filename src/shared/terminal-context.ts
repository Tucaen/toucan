/**
 * The terminal-context edge: a user-drawn canvas connection from a terminal node to a chat node
 * granting exactly one capability - the chat node's agent may read that terminal's output on
 * demand (design in `docs/plans/terminal-context-edge.md`). This module owns the wire shape the
 * renderer mirrors across the privilege seam: the durable terminal `sessionId` paired with the
 * agent session id (the chat node's id, which is what `AgentCreateRequest.id` keys sessions by in
 * `acp-session-manager.ts`).
 *
 * Edges are runtime-only by design - never persisted, never part of `WorkspaceState` - so the
 * mirror is a full-set replace on every change: idempotent, last-write-wins, and self-healing
 * after a renderer reload (a fresh renderer's first publish is the empty set, which is correct).
 */

export interface TerminalContextEdge {
  /** The durable terminal session id (`TerminalNodeData.sessionId`), which outlives incarnations. */
  terminalSessionId: string
  /** The agent session id: the chat node's id, the key every `AgentApi` call addresses main with. */
  agentId: string
}

export interface TerminalContextApi {
  /** Replaces the whole edge set; the previous set is gone, whatever it was. */
  replaceEdges(edges: TerminalContextEdge[]): void
}

/**
 * The registry sits in main, on the far side of the privilege seam, so it re-validates what the
 * renderer sent rather than trusting the shape: anything that is not a well-formed edge is
 * dropped, never guessed at. Duplicates collapse to the first occurrence.
 */
export function parseTerminalContextEdges(value: unknown): TerminalContextEdge[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const edges: TerminalContextEdge[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const { terminalSessionId, agentId } = entry as Record<string, unknown>
    if (typeof terminalSessionId !== 'string' || terminalSessionId.length === 0) continue
    if (typeof agentId !== 'string' || agentId.length === 0) continue
    // NUL-separated so no id content can make two different pairs share a key.
    const key = `${agentId}\u0000${terminalSessionId}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ terminalSessionId, agentId })
  }
  return edges
}
