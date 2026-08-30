import type { JSX } from 'react'

interface UnreadToggleProps {
  /** Unread attention records on this node, pushed down from the workspace. */
  unread: number
  onToggle(next: 'read' | 'unread'): void
}

/**
 * One control for the node's unread state, in both directions. Reading a node normally clears it
 * on its own, so the button's job is mostly the deliberate move back: it shows the count while
 * anything is unread and offers "mark unread" once nothing is, which is what lets a user park
 * something they have looked at but not dealt with.
 */
export default function UnreadToggle({ unread, onToggle }: UnreadToggleProps): JSX.Element {
  const isUnread = unread > 0
  return (
    <button
      type="button"
      className="node-unread-toggle nodrag"
      data-unread={isUnread ? 'true' : undefined}
      aria-pressed={isUnread}
      aria-label={isUnread ? `${unread} unread - mark read` : 'Mark unread'}
      title={isUnread ? `${unread} unread - mark read` : 'Mark unread'}
      onClick={(event) => {
        event.stopPropagation()
        onToggle(isUnread ? 'read' : 'unread')
      }}
    >
      {isUnread ? unread : ''}
    </button>
  )
}
