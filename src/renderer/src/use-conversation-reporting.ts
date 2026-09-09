/**
 * The chat node's upward reporting, in one hook: attention records, sidebar status, the stall
 * clock, the generated title, persisted turn outcomes and ticket activity. Every *decision* is a
 * pure function in `conversation-reporting.ts`; this hook owns only the refs that carry state
 * across renders and the effects that hand the verdicts to the workspace. `ChatNode` mounts it
 * and renders - it computes none of this itself.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentTurnOutcome } from '../../shared/agent'
import { READ_ON_VIEW_KINDS, type AttentionAction, type AttentionKind } from '../../shared/attention'
import type { ConversationTitleSource } from '../../shared/conversation-title'
import type { TerminalNodeStatus } from '../../shared/terminal'
import { recentlyWrittenPaths, type TicketActivityReport } from './ticket-activity'
import type { AgentConversationController } from './use-agent-conversation'
import {
  STALL_CHECK_INTERVAL_MS,
  authAttentionAction,
  failureAttentionAction,
  generatedConversationTitle,
  initialTicketTurnTracking,
  initialTurnResultTracking,
  isStalled,
  pendingRequestActions,
  sidebarStatus,
  ticketActivityDigest,
  trackTicketTurn,
  trackTurnResult,
  type ReportingIdentity,
  type TicketTurnTracking,
  type TurnResultTracking
} from './conversation-reporting'

/** What the reporting policy observes and where its reports go; a subset of TerminalNodeData. */
export interface ConversationReportingOptions {
  id: string
  label: string
  selected: boolean
  dormant: boolean
  /** Unread attention records on this node, pushed down from the workspace. */
  unread: number
  unreadKind?: AttentionKind
  /**
   * The ACP conversation once there is one; until then the node's durable session id, so an
   * early approval or failure is never persisted without any source identity at all.
   */
  sourceId: string
  conversationId?: string
  titleSource?: ConversationTitleSource
  /** Outcomes already persisted with the node, so replay does not re-report them. */
  persistedOutcomes?: readonly AgentTurnOutcome[]
  conversation: Pick<
    AgentConversationController,
    | 'status'
    | 'approval'
    | 'decisionRequest'
    | 'detail'
    | 'failure'
    | 'failureKey'
    | 'messages'
    | 'activities'
    | 'plan'
    | 'transcript'
    | 'outcomes'
  >
  onAttention?(action: AttentionAction): void
  onStatusChange(nodeId: string, status: TerminalNodeStatus): void
  onTicketActivity?(nodeId: string, report: TicketActivityReport): void
  onTurnOutcome?(nodeId: string, outcome: AgentTurnOutcome): void
  onTitleChange(nodeId: string, title: string, source: ConversationTitleSource): Promise<boolean>
}

export interface ConversationReporting {
  /** True while a working session has shown no progress for too long; drives the header dot. */
  stalled: boolean
  /** True when the last generated title failed to save; manual renames track their own errors. */
  generatedTitleError: boolean
  /** The header toggle's handler; holds "mark unread" against the read-on-view effect. */
  toggleUnread(next: 'read' | 'unread'): void
}

export function useConversationReporting(options: ConversationReportingOptions): ConversationReporting {
  const { id, label, selected, sourceId, onAttention: reportAttention } = options
  const { status, approval, decisionRequest, detail, failure, failureKey, messages, activities, plan } =
    options.conversation

  // Attention is a durable record owned by the workspace, not a flag this node recomputes: the
  // node only reports the condition and the key that identifies it. Every key is stable across
  // ACP session replay, which is what keeps a restored conversation from re-raising something
  // the user already dealt with (see shared/attention.ts and conversation-reporting.ts). The
  // identity is a dependency of every raising effect, so a standing condition re-reports itself
  // - and its record absorbs the newer label or source - when either changes.
  const identity = useMemo((): ReportingIdentity => ({ nodeId: id, label, sourceId }), [id, label, sourceId])

  const persistedOutcomeIdsRef = useRef<Set<string> | null>(null)
  if (persistedOutcomeIdsRef.current === null) {
    persistedOutcomeIdsRef.current = new Set((options.persistedOutcomes ?? []).map((outcome) => outcome.id))
  }
  const reportTurnOutcome = options.onTurnOutcome
  useEffect(() => {
    for (const outcome of options.conversation.outcomes) {
      if (persistedOutcomeIdsRef.current!.has(outcome.id)) continue
      persistedOutcomeIdsRef.current!.add(outcome.id)
      reportTurnOutcome?.(id, outcome)
    }
  }, [options.conversation.outcomes, reportTurnOutcome, id])

  const [generatedTitleError, setGeneratedTitleError] = useState(false)
  const onTitleChange = options.onTitleChange
  useEffect(() => {
    // A title source means a title has saved (a manual rename outranks generation for good), so
    // a failure from an earlier generated attempt is no longer worth an error icon.
    if (options.titleSource) {
      setGeneratedTitleError(false)
      return
    }
    if (!options.conversationId || status !== 'ready') return
    const title = generatedConversationTitle(messages)
    if (title) void onTitleChange(id, title, 'generated').then((saved) => setGeneratedTitleError(!saved))
  }, [onTitleChange, options.conversationId, options.titleSource, id, messages, status])

  // A turn that finished while the user was looking elsewhere is a result they have not read.
  const turnResultRef = useRef<TurnResultTracking>(initialTurnResultTracking)
  useEffect(() => {
    const { state, raise } = trackTurnResult(turnResultRef.current, identity, {
      status,
      messages,
      selected
    })
    turnResultRef.current = state
    if (raise) reportAttention?.(raise)
  }, [identity, messages, reportAttention, selected, status])

  // A request the session is parked on - a tool permission or a structured question set - is one
  // standing condition, keyed by the ACP request id (see pendingRequestActions).
  const requestId = approval?.id ?? decisionRequest?.id ?? null
  const requestTitle = approval?.title ?? decisionRequest?.message
  const previousRequestRef = useRef<string | null>(null)
  useEffect(() => {
    const previous = previousRequestRef.current
    previousRequestRef.current = requestId
    const request = requestId ? { id: requestId, title: requestTitle } : null
    for (const action of pendingRequestActions(previous, request, identity)) {
      reportAttention?.(action)
    }
  }, [identity, reportAttention, requestId, requestTitle])

  // Sign-in is a standing condition rather than an event, so it is raised while it holds and
  // retired the moment the session gets past it.
  const authRequired = status === 'auth_required'
  useEffect(() => {
    reportAttention?.(authAttentionAction(authRequired, identity))
  }, [authRequired, identity, reportAttention])

  useEffect(() => {
    const action = failureAttentionAction(failure, failureKey, identity)
    if (action) reportAttention?.(action)
  }, [failure, failureKey, identity, reportAttention])

  /**
   * Having the node open is the user reaching its content, so anything raised while it is
   * selected clears too - but only the kinds reading actually settles. A pending approval or
   * sign-in request stays unread until it is answered (READ_ON_VIEW_KINDS), because glancing at
   * a blocked turn is not unblocking it. Marking unread on a node you are looking at would
   * otherwise be undone by this effect on the very next render, so that hold survives until the
   * node is left and re-entered.
   */
  const unreadHoldRef = useRef(false)
  useEffect(() => {
    if (!selected) unreadHoldRef.current = false
    if (!selected || options.dormant || options.unread === 0 || unreadHoldRef.current) return
    reportAttention?.({ type: 'read', nodeId: id, kinds: READ_ON_VIEW_KINDS })
  }, [options.dormant, id, reportAttention, selected, options.unread])

  const toggleUnread = useCallback(
    (next: 'read' | 'unread'): void => {
      unreadHoldRef.current = next === 'unread'
      reportAttention?.(
        next === 'unread' ? { type: 'unread', nodeId: id } : { type: 'read', nodeId: id, kinds: READ_ON_VIEW_KINDS }
      )
    },
    [id, reportAttention]
  )

  // Any new message text, tool activity, or plan update counts as progress and resets the stall clock.
  const [stalled, setStalled] = useState(false)
  const lastProgressAtRef = useRef(Date.now())
  useEffect(() => {
    lastProgressAtRef.current = Date.now()
  }, [messages, activities, plan, detail])

  // While working, periodically check whether progress has gone quiet for too long.
  useEffect(() => {
    if (status !== 'working') {
      setStalled(false)
      return
    }
    lastProgressAtRef.current = Date.now()
    setStalled(false)
    const interval = setInterval(() => {
      setStalled(isStalled(Date.now(), lastProgressAtRef.current))
    }, STALL_CHECK_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [status])

  const onStatusChange = options.onStatusChange
  useEffect(() => {
    if (options.dormant) return
    // Either kind of pending request is the same thing to a list: the agent is waiting on you.
    const waiting = approval !== null || decisionRequest !== null
    onStatusChange(id, sidebarStatus(status, waiting, options.unreadKind, stalled))
  }, [approval, options.dormant, onStatusChange, options.unreadKind, decisionRequest, id, status, stalled])

  /**
   * What this session has been writing, for the ticket board's live card. Paths go up, not
   * tickets: which of them is a ticket depends on the project's tickets folder, which the
   * workspace knows and a node does not (`ticket-activity.ts`). Where the running turn began is
   * observed here because this is the only place that sees the status change - a steer sent
   * mid-turn is another message from the captain, and the transcript alone cannot tell the two
   * apart. The report fires on a change of *contents*, not on every streamed event.
   */
  const reportTicketActivity = options.onTicketActivity
  const ticketTurnRef = useRef<TicketTurnTracking>(initialTicketTurnTracking)
  const reportedTurnRef = useRef<string | undefined>(undefined)
  const transcript = options.conversation.transcript
  useEffect(() => {
    const working = status === 'working'
    ticketTurnRef.current = trackTicketTurn(ticketTurnRef.current, { working, transcriptLength: transcript.length })
    const paths = recentlyWrittenPaths(transcript, activities, {
      working,
      startedAt: ticketTurnRef.current.startedAt
    })
    const reported = ticketActivityDigest(working, paths)
    if (reported === reportedTurnRef.current) return
    reportedTurnRef.current = reported
    reportTicketActivity?.(id, { paths, working })
  }, [activities, transcript, id, reportTicketActivity, status])

  return { stalled, generatedTitleError, toggleUnread }
}
