import { memo } from 'react'
import MarkdownMessage from './MarkdownMessage'
import type { SessionMessagingEntry, SessionMessagingNotice } from './session-messaging-view'

/** The slice of messaging one chat renders: its own entries and the notices that name it. */
export interface ChatMessagingProps {
  entries: readonly SessionMessagingEntry[]
  notices: readonly SessionMessagingNotice[]
  dismissNotice(key: string): void
}

const SessionMessagingEntryCard = memo(function SessionMessagingEntryCard(props: {
  entry: SessionMessagingEntry
}): JSX.Element {
  const { entry } = props
  return (
    <article
      className="session-message"
      data-tone={entry.tone}
      title={new Date(entry.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
    >
      <strong>{entry.label}</strong>
      <MarkdownMessage text={entry.text} />
      {entry.status && <small className="session-message-status">{entry.status}</small>}
    </article>
  )
})

/** A refused ask, for the human: it names what the agent tried and the limit it hit. */
export function SessionMessagingNotices(props: Pick<ChatMessagingProps, 'notices' | 'dismissNotice'>): JSX.Element {
  return (
    <>
      {props.notices.map((notice) => (
        <article className="session-message-notice" role="alert" key={notice.key}>
          <span>{notice.text}</span>
          <button type="button" aria-label="Dismiss notice" onClick={() => props.dismissNotice(notice.key)}>
            Dismiss
          </button>
        </article>
      ))}
    </>
  )
}

export function SessionMessagingEntries(props: Pick<ChatMessagingProps, 'entries'>): JSX.Element {
  return (
    <>
      {props.entries.map((entry) => (
        <SessionMessagingEntryCard key={entry.key} entry={entry} />
      ))}
    </>
  )
}
