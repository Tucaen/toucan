import { useEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { RemoteChatSummary } from '../../src/shared/remote-access'
import { canSendDraft, sendBlockedReason } from './chat-connection'
import { chatStatusSummary, deriveChatViewItems, type ChatViewItem } from './chat-view'
import { fetchWorkspace } from './remote-client'
import { useChatConnection, type ChatConnection } from './use-chat-connection'

/**
 * One chat, read live and written to. The transcript is the shared reducer state the connection
 * hook maintains; this component only renders what `chat-view.ts` derived from it, and the
 * composer only renders what `chat-connection.ts` decided - whether a send is possible, why not,
 * and what happened to the last one. Nothing here pretends a stale transcript is live, and nothing
 * here renders a sent message: that arrives as the provider's echo like every other message.
 *
 * An unsent draft is retained on this device (see `rememberDraft`), which is what carries the
 * typed text through the one failure that unmounts this screen - a revoked token, on its way back
 * to pairing. It is retention, not drafts sync: the desktop never sees it.
 */
export default function ChatScreen({
  token,
  chatId,
  summary: initialSummary,
  onBack,
  onUnauthorized
}: {
  token: string
  chatId: string
  /** What the chat list knew when it navigated here; null on a reloaded deep link. */
  summary: RemoteChatSummary | null
  onBack(): void
  onUnauthorized(): void
}): JSX.Element {
  const connection = useChatConnection(token, chatId, onUnauthorized)
  const [summary, setSummary] = useState(initialSummary)

  // A reloaded deep link arrives without the list's knowledge of the chat; one workspace read
  // restores the title. Unauthorized here means unauthorized everywhere - straight back to pairing.
  useEffect(() => {
    if (summary) return
    let cancelled = false
    void fetchWorkspace(token).then((result) => {
      if (cancelled) return
      if (!result.ok) {
        if (result.kind === 'unauthorized') onUnauthorized()
        return
      }
      setSummary(result.value.chats.find((chat) => chat.id === chatId) ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [summary, token, chatId, onUnauthorized])

  const items = useMemo(
    () => (connection.transcript ? deriveChatViewItems(connection.transcript) : []),
    [connection.transcript]
  )
  const status = connection.transcript ? chatStatusSummary(connection.transcript) : null

  // Follow the tail the way a chat should: stick to the bottom while the reader is there, and
  // stop following the moment they scroll up to read history.
  const endRef = useRef<HTMLDivElement | null>(null)
  const following = useRef(true)
  useEffect(() => {
    const onScroll = (): void => {
      const root = document.documentElement
      following.current = root.scrollHeight - root.scrollTop - root.clientHeight < 120
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
    if (following.current) endRef.current?.scrollIntoView()
  }, [items])

  return (
    <main className="screen chat-screen">
      <header className="chat-head">
        <button type="button" className="back" onClick={onBack} aria-label="Back to chats">
          ‹
        </button>
        <div className="chat-head-copy">
          <h1>{summary?.title ?? 'Chat'}</h1>
          {status && (
            <span className="chat-status" data-tone={status.tone}>
              {status.label}
            </span>
          )}
        </div>
        {summary && (
          <span className="chat-kind" data-kind={summary.kind}>
            {summary.kind === 'claude' ? 'CL' : 'CX'}
          </span>
        )}
      </header>

      {/* A transcript that is not live must say so; a silently stale one is the failure mode. */}
      {connection.phase === 'connecting' && <p className="connection-banner">Connecting…</p>}
      {connection.phase === 'reconnecting' && <p className="connection-banner stale">Disconnected — reconnecting…</p>}
      {connection.phase === 'gone' && (
        <p className="connection-banner gone">This chat is no longer open on the desktop.</p>
      )}

      <div className="transcript" data-stale={connection.phase === 'reconnecting' || undefined}>
        {items.map((item) => (
          <TranscriptItem key={item.key} item={item} />
        ))}
        {connection.phase === 'live' && items.length === 0 && (
          <p className="empty">Nothing in this conversation yet.</p>
        )}
        <div ref={endRef} />
      </div>

      <Composer connection={connection} />
    </main>
  )
}

/**
 * Multiline text and a send button; no slash commands, no mentions, no drafts sync. The busy
 * policy is visible rather than clever: while a turn is working the button is disabled and says
 * so, so a prompt is never queued invisibly on the phone nor steered into a turn in flight. A
 * refused or unconfirmed send puts the text straight back and reports the reason.
 */
function Composer({ connection }: { connection: ChatConnection }): JSX.Element {
  const blocked = sendBlockedReason(connection)
  const canSend = canSendDraft(connection)
  const failure = connection.send.status === 'failed' ? connection.send.message : null

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault()
        connection.onSend()
      }}
    >
      {failure && (
        <p className="send-error" role="alert">
          {failure}
        </p>
      )}
      <div className="composer-row">
        <textarea
          className="composer-input"
          value={connection.draft}
          rows={1}
          // The phone keyboard's Enter inserts a newline: on a touch composer the button is the
          // only send, so a stray return can never fire a prompt.
          onChange={(event) => connection.onDraftChange(event.target.value)}
          placeholder={blocked ?? 'Message…'}
          aria-label="Message"
        />
        <button type="submit" className="composer-send" disabled={!canSend}>
          {connection.send.status === 'sending' ? '…' : 'Send'}
        </button>
      </div>
      {/* Only reasons that are about the session, not about an empty box, are worth stating. */}
      {blocked && connection.send.status !== 'sending' && <p className="composer-hint">{blocked}</p>}
    </form>
  )
}

function TranscriptItem({ item }: { item: ChatViewItem }): JSX.Element {
  if (item.type === 'reasoning') {
    return (
      <p className="reasoning" data-streaming={item.streaming || undefined}>
        {item.streaming ? 'Thinking…' : 'Thought for a while'}
      </p>
    )
  }
  if (item.type === 'activity') {
    return (
      <p className="activity" data-state={item.state}>
        <span className="activity-glyph" aria-hidden />
        {item.label}
      </p>
    )
  }
  if (item.type === 'outcome') {
    return (
      <p className="turn-outcome" data-status={item.status}>
        {item.status === 'failed' ? 'Turn failed' : 'Turn cancelled'} — {item.message}
      </p>
    )
  }
  if (item.role === 'user') {
    return (
      <div className="bubble user">
        <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
      </div>
    )
  }
  return (
    <div
      className="bubble assistant"
      data-provisional={!item.final || undefined}
      data-streaming={item.streaming || undefined}
    >
      <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
    </div>
  )
}
