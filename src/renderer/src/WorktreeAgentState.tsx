import type { AttentionKind } from '../../shared/attention'
import { mostUrgentAttention, worktreeAttentionTotal, type WorktreeSummary } from './worktree-overview'

/** A chat's most blocking unread kind, said in one word where a row has room for one. */
export const ATTENTION_KIND_LABELS: Record<AttentionKind, string> = {
  approval: 'Approval',
  auth: 'Sign-in',
  failure: 'Failed',
  result: 'Result',
  output: 'Output'
}

interface WorktreeAgentStateProps {
  summary: WorktreeSummary
  /** Makes the unread count a button that reveals the most urgent chat; absent, it is a label. */
  onReveal?(nodeId: string): void
}

/**
 * What a worktree's agents are doing, said the same way on its header and in the navigator - both
 * render this from the same `WorktreeSummary`, so their counts agree by construction. Agent state
 * only, deliberately styled apart from the header's git state: a clean checkout is not a finished
 * turn.
 */
export default function WorktreeAgentState({ summary, onReveal }: WorktreeAgentStateProps): JSX.Element | null {
  const unread = worktreeAttentionTotal(summary)
  const urgent = mostUrgentAttention(summary)
  if (summary.working === 0 && !urgent) return null

  const description = summary.attention.map((item) => `${item.label}: ${item.description}`).join('\n')
  const label = `${unread} unread`
  return (
    <span className="worktree-agent-state">
      {summary.working > 0 && (
        <span className="worktree-agent-working" data-kind="working" title="Chats mid-turn in this worktree">
          <span className="worktree-agent-dot" aria-hidden="true" />
          {summary.working} working
        </span>
      )}
      {urgent &&
        (onReveal ? (
          <button
            type="button"
            className="worktree-agent-unread nodrag"
            data-kind={urgent.kind}
            title={`${description}\nShow ${urgent.label}`}
            aria-label={`${label} - show ${urgent.label}`}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              // A click that reached the main canvas would select this worktree's frame instead.
              event.stopPropagation()
              onReveal(urgent.nodeId)
            }}
          >
            {label}
          </button>
        ) : (
          <span className="worktree-agent-unread" data-kind={urgent.kind} title={description}>
            {label}
          </span>
        ))}
    </span>
  )
}
