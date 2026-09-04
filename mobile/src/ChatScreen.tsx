import { useEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentDecisionQuestion, AgentDecisionResponseContent } from '../../src/shared/agent'
import type { RemoteChatSummary } from '../../src/shared/remote-access'
import {
  answerFailure,
  answerInFlight,
  canSendDraft,
  composerHidden,
  pendingRequest,
  sendBlockedReason
} from './chat-connection'
import {
  activitySummaryLine,
  chatStatusSummary,
  deriveChatViewItems,
  type ChatViewItem,
  type PendingRequest
} from './chat-view'
import {
  advancesOnAnswer,
  answeredCount,
  answerFieldText,
  chooseOption,
  customAnswerText,
  initialDecisionAnswers,
  isBooleanAnswer,
  isOptionSelected,
  isQuestionAnswered,
  setBooleanAnswer,
  setCustomAnswer,
  setNumberAnswer,
  setTextAnswer,
  submitDecisionProblem
} from './decision-answers'
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
  const pending = pendingRequest(connection)

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

      {/* One decision at a time, and while it stands the plain composer is gone rather than
          disabled: free text must not be able to bypass the channel the agent is waiting on. */}
      {pending && <PendingRequestCard key={pending.id} pending={pending} connection={connection} />}
      {!composerHidden(connection) && <Composer connection={connection} />}
    </main>
  )
}

/**
 * The pending request, as the phone's answer surface. Both shapes route through the connection's
 * answer path rather than through the composer, and both are inert while an answer is on the wire
 * or once the request has been resolved elsewhere - the state decides that, not this component.
 */
function PendingRequestCard({
  pending,
  connection
}: {
  pending: PendingRequest
  connection: ChatConnection
}): JSX.Element {
  const failure = answerFailure(connection)
  const busy = answerInFlight(connection)
  return (
    <section className="pending-request" data-kind={pending.kind} aria-label="Pending request">
      {failure && (
        <p className="send-error" role="alert">
          {failure}
        </p>
      )}
      {pending.kind === 'approval' ? (
        <ApprovalCard pending={pending} busy={busy} onApprove={connection.onApprove} />
      ) : (
        <DecisionCard pending={pending} busy={busy} onAnswer={connection.onAnswerDecision} />
      )}
    </section>
  )
}

function ApprovalCard({
  pending,
  busy,
  onApprove
}: {
  pending: Extract<PendingRequest, { kind: 'approval' }>
  busy: boolean
  onApprove(optionId?: string): void
}): JSX.Element {
  return (
    <>
      <header className="pending-request-head">
        <strong>{pending.title}</strong>
        {/* What the agent is about to do, in the same one-line form the transcript uses. */}
        {pending.activity && <small>{activitySummaryLine(pending.activity)}</small>}
      </header>
      <div className="pending-request-options">
        {pending.options.map((option) => (
          <button
            type="button"
            key={option.id}
            data-kind={option.kind}
            disabled={busy}
            onClick={() => onApprove(option.id)}
          >
            {option.label}
          </button>
        ))}
        {/* The agent's own option set may not contain a refusal, so dismissing stays available. */}
        <button type="button" className="pending-request-dismiss" disabled={busy} onClick={() => onApprove()}>
          Dismiss
        </button>
      </div>
    </>
  )
}

/**
 * A question set, one question on screen at a time - the desktop's rule, and on a phone the only
 * readable one. Answers accumulate locally and are submitted as a single response, because that is
 * what the elicitation is: one form, not a question per turn.
 */
function DecisionCard({
  pending,
  busy,
  onAnswer
}: {
  pending: Extract<PendingRequest, { kind: 'decision' }>
  busy: boolean
  onAnswer(content?: AgentDecisionResponseContent): void
}): JSX.Element {
  const request = pending.request
  const [active, setActive] = useState(0)
  const [answers, setAnswers] = useState<AgentDecisionResponseContent>(initialDecisionAnswers)
  const question = request.questions[Math.min(active, request.questions.length - 1)]
  const problem = submitDecisionProblem(request, answers)
  const last = request.questions.length - 1

  // Choosing a single-value option is also an answer to "what next", so it advances. A
  // multi-select must not: the reader is still adding to it.
  const advanceAfter = (item: AgentDecisionQuestion): void => {
    if (advancesOnAnswer(item) && active < last) setActive(active + 1)
  }

  if (!question) return <p className="empty">This question set is empty.</p>

  return (
    <>
      <header className="pending-request-head">
        <strong>{question.title ?? 'Decision questions'}</strong>
        <small>{request.message}</small>
      </header>
      <p className="decision-progress">
        Question {active + 1} of {request.questions.length} · {answeredCount(request, answers)} answered
        {question.required && <span className="decision-required">Required</span>}
      </p>
      <p className="decision-question">{question.question}</p>

      {question.input === 'select' && (
        <div className="pending-request-options" role="group" aria-label={question.question}>
          {question.options.map((option) => (
            <button
              type="button"
              key={option.value}
              aria-pressed={isOptionSelected(answers, question, option.value)}
              disabled={busy}
              onClick={() => {
                setAnswers((current) => chooseOption(current, question, option.value))
                advanceAfter(question)
              }}
            >
              <span>{option.label}</span>
              {option.description && <small>{option.description}</small>}
            </button>
          ))}
        </div>
      )}
      {question.input === 'boolean' && (
        <div className="pending-request-options" role="group" aria-label={question.question}>
          {[true, false].map((value) => (
            <button
              type="button"
              key={String(value)}
              aria-pressed={isBooleanAnswer(answers, question, value)}
              disabled={busy}
              onClick={() => {
                setAnswers((current) => setBooleanAnswer(current, question, value))
                advanceAfter(question)
              }}
            >
              {value ? 'Yes' : 'No'}
            </button>
          ))}
        </div>
      )}
      {question.input === 'text' && (
        <input
          className="decision-value"
          type="text"
          aria-label={question.question}
          disabled={busy}
          value={answerFieldText(answers, question)}
          onChange={(event) => setAnswers((current) => setTextAnswer(current, question, event.target.value))}
        />
      )}
      {question.input === 'number' && (
        <input
          className="decision-value"
          type="number"
          aria-label={question.question}
          disabled={busy}
          value={answerFieldText(answers, question)}
          onChange={(event) => setAnswers((current) => setNumberAnswer(current, question, event.target.value))}
        />
      )}
      {question.customAnswerId && (
        <label className="decision-other">
          <span>Other answer</span>
          <input
            type="text"
            disabled={busy}
            value={customAnswerText(answers, question)}
            onChange={(event) => setAnswers((current) => setCustomAnswer(current, question, event.target.value))}
          />
        </label>
      )}

      {request.questions.length > 1 && (
        <nav className="decision-navigation" aria-label="Question navigation">
          <button type="button" disabled={active === 0} onClick={() => setActive(active - 1)}>
            Previous
          </button>
          <span>{request.questions.map((item) => (isQuestionAnswered(answers, item) ? '●' : '○')).join(' ')}</span>
          <button type="button" disabled={active >= last} onClick={() => setActive(active + 1)}>
            Next
          </button>
        </nav>
      )}

      <footer className="decision-actions">
        <button type="button" className="decision-skip" disabled={busy} onClick={() => onAnswer()}>
          Skip
        </button>
        <button type="button" disabled={busy || problem !== null} onClick={() => onAnswer(answers)}>
          {busy ? 'Answering…' : 'Submit answers'}
        </button>
      </footer>
      {problem && <p className="composer-hint">{problem}</p>}
    </>
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
