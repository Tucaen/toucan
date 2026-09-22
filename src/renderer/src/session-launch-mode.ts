import type { TerminalKind } from '../../shared/terminal'
import type { ConversationLineage } from '../../shared/workspace'

/**
 * How a session node's next launch opens, and the two decisions that settle it.
 *
 * Its own module rather than part of `conversation-lineage.ts`, where the rest of the fork
 * vocabulary lives: `canvas-workspace.ts` has to decide a launch mode while restoring a node, and
 * the lineage module reads canvas node types, so putting the decision there would make the two
 * files a cycle. Keeping it here also means both decisions are reachable without importing
 * anything that renders.
 */
export type SessionLaunchMode = 'new' | 'resume' | 'fork'

/**
 * What a node's launch mode becomes once it reports a conversation id of its own. A fork is a
 * one-shot launch: leaving it standing would make the *next* restart of that node - a
 * terminal-context adoption bumping `terminalContextNonce`, say - fork the parent a second time
 * and discard every turn the child had taken. Anything else is already what it should be.
 */
export function launchModeAfterConversation(launchMode: SessionLaunchMode): SessionLaunchMode {
  return launchMode === 'fork' ? 'resume' : launchMode
}

/** The little of a node this decision reads, so a saved node can ask without being a canvas one. */
export interface LaunchModeCandidate {
  kind: TerminalKind
  conversationId?: string
  branchedFrom?: ConversationLineage
}

/**
 * The launch mode a node gets when it is (re)opened - restored from a snapshot, reopened from the
 * recently-closed stack, or woken from dormancy by its resume panel. One place decides it because
 * those routes differ only in where the node data came from, and a fork one route keeps while
 * another re-derives it as `new` silently discards the transcript the child was branched from.
 *
 * A branch that never reached a conversation of its own is still a branch: it opens as the fork it
 * was launched as. Everything else resumes - for an already-forked child that means loading the
 * conversation the fork produced - and a chat with nothing to load starts new.
 */
export function launchModeOnOpen(node: LaunchModeCandidate): SessionLaunchMode {
  if (!node.conversationId && node.branchedFrom) return 'fork'
  return node.kind === 'terminal' || node.conversationId ? 'resume' : 'new'
}
