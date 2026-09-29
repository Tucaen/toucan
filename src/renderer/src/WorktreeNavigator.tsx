import { useState, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronRight, GitBranch } from 'lucide-react'
import WorktreeAgentState from './WorktreeAgentState'
import { ATTENTION_KIND_LABELS, type WorktreeSummary } from './worktree-overview'

interface WorktreeNavigatorProps {
  summaries: readonly WorktreeSummary[]
  /** Brings a node into view and selects it: a worktree's own node, or one of its chats. */
  onReveal(nodeId: string): void
}

/**
 * Every worktree on the canvas in one short list over its corner: task and branch, what its agents
 * are doing, and each chat that has something unread. It is an overview aid, never a second place
 * the chats live - picking an entry reveals the real node on the canvas.
 *
 * Going to a worktree selects its frame, which reads nothing; only an entry for a chat selects that
 * chat, and the chat's own read-on-view policy decides what that settles. Entries stay in canvas
 * and chat order whatever their state, so nothing moves under the pointer when a turn finishes.
 */
export default function WorktreeNavigator({ summaries, onReveal }: WorktreeNavigatorProps): JSX.Element | null {
  const [open, setOpen] = useState(true)
  if (summaries.length === 0) return null
  const unread = summaries.reduce((total, summary) => total + summary.unread, 0)

  // Up and Down walk every entry in order, so the list is usable without the pointer or Tab alone.
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const entries = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
    const at = entries.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    event.preventDefault()
    event.stopPropagation()
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? entries.length - 1
          : Math.min(entries.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))
    entries[next].focus()
  }

  return (
    <nav className="worktree-navigator" aria-label="Worktrees" onKeyDown={handleKeyDown}>
      <button
        type="button"
        className="worktree-navigator-toggle"
        aria-expanded={open}
        title={open ? 'Hide the worktree list' : 'Show every worktree and what needs you'}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        <GitBranch aria-hidden="true" />
        Worktrees
        <span className="worktree-navigator-count">{summaries.length}</span>
        {unread > 0 && (
          <span className="unread-badge" aria-label={`${unread} unread`}>
            {unread}
          </span>
        )}
      </button>
      {open && (
        <ul className="worktree-navigator-list">
          {summaries.map((summary) => (
            <li key={summary.worktreeId} className="worktree-navigator-entry">
              <button
                type="button"
                className="worktree-navigator-worktree"
                data-collapsed={summary.collapsed ? 'true' : undefined}
                style={{ '--project-color': summary.projectColor } as React.CSSProperties}
                title={`${summary.task ? `${summary.task}\n` : ''}${summary.branch} · ${summary.projectName}${
                  summary.collapsed ? '\nCollapsed; its chats keep running' : ''
                }`}
                onClick={() => onReveal(summary.nodeId)}
              >
                <span className="project-color-dot" aria-hidden="true" />
                <span className="worktree-navigator-name">{summary.task ?? summary.branch}</span>
                {summary.task && <span className="worktree-navigator-branch">{summary.branch}</span>}
                <WorktreeAgentState summary={summary} />
              </button>
              {summary.attention.length > 0 && (
                <ul className="worktree-navigator-chats" aria-label={`Needs attention in ${summary.branch}`}>
                  {summary.attention.map((item) => (
                    <li key={item.nodeId}>
                      <button
                        type="button"
                        className="worktree-navigator-chat"
                        data-kind={item.kind}
                        title={item.description}
                        onClick={() => onReveal(item.nodeId)}
                      >
                        <span className="worktree-navigator-kind">{ATTENTION_KIND_LABELS[item.kind]}</span>
                        <span className="worktree-navigator-chat-label">{item.label}</span>
                        {item.count > 1 && <span className="worktree-navigator-chat-count">{item.count}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </nav>
  )
}
