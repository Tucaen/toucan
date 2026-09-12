import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentDecisionResponseContent } from '../../src/shared/agent'
import {
  REMOTE_CHAT_PROTOCOL,
  remoteChatBearerProtocol,
  remoteChatSocketPath,
  type RemoteChatClientMessage
} from '../../src/shared/remote-chat'
import {
  answerFailed,
  applyServerFrame,
  chatGone,
  connectionLost,
  draftChanged,
  pendingRequest,
  plannedAnswer,
  plannedSend,
  readReportKey,
  reconnectDelayMs,
  restoredChatConnectionState,
  sendFailed,
  withAnswer,
  withSend,
  type ChatConnectionState
} from './chat-connection'
import { hostSocketUrl, type SavedHost } from './hosts'
import { fetchWorkspace, rememberDraft, storedDraft } from './remote-client'

/**
 * Owns the WebSocket for one chat on one host; every decision about what frames and drops *mean*
 * lives in `chat-connection.ts`. The token rides in the subprotocol list because a browser cannot
 * put an `Authorization` header on an upgrade request.
 *
 * The socket's URL is the *host's*, not the page's: this client may be served by one host while
 * reading a chat on another, so the scheme follows the host's own origin. A browser applies no CORS
 * to a WebSocket, so the token in the subprotocol is the whole gate cross-host as well - but it
 * does refuse `ws:` from an HTTPS page, which surfaces here as an ordinary failure to connect and
 * is named for what it is by `hostBlockedByPageScheme` where the reader can act on it.
 *
 * A closed socket is ambiguous on purpose - the browser will not say whether the handshake was
 * refused with 401, refused with 404, or the network blinked - so every drop is classified through
 * one authenticated HTTP probe: a revoked token unpaired this host, a chat the desktop no longer
 * lists is gone, and anything else is a blip worth rejoining after a bounded backoff.
 */
export interface ChatConnection extends ChatConnectionState {
  onDraftChange(draft: string): void
  /** Sends the current draft, if the state allows it. Ignored otherwise, so a stale tap is inert. */
  onSend(): void
  /**
   * Answers the pending tool permission; an omitted option cancels it. Every guard is the state's,
   * so a tap on a card the desktop answered a moment ago is inert here rather than a second answer
   * on the wire - and if it does reach the host, the host refuses it on the request id anyway.
   */
  onApprove(optionId?: string): void
  /** Answers the pending question set, or skips it when `content` is omitted. */
  onAnswerDecision(content?: AgentDecisionResponseContent): void
}

export function useChatConnection(host: SavedHost, chatId: string, onUnauthorized: () => void): ChatConnection {
  const [state, setState] = useState<ChatConnectionState>(() =>
    restoredChatConnectionState(storedDraft(host.id, chatId))
  )
  const unauthorized = useRef(onUnauthorized)
  unauthorized.current = onUnauthorized
  // The live socket, readable by the send path. A send is only ever attempted on the socket that
  // is open right now; a superseded one is never written to.
  const live = useRef<WebSocket | null>(null)
  // The send path reads state outside a render, and it must read the newest committed one.
  const stateRef = useRef(state)
  stateRef.current = state

  /** The last read this connection reported, so an unchanged one is not sent twice. */
  const reportedRead = useRef<string | null>(null)

  useEffect(() => {
    setState(restoredChatConnectionState(storedDraft(host.id, chatId)))
    reportedRead.current = null
    let disposed = false
    let socket: WebSocket | null = null
    let timer: number | undefined
    let attempt = 0

    const classifyThenRetry = async (): Promise<void> => {
      const workspace = await fetchWorkspace(host)
      if (disposed) return
      if (!workspace.ok) {
        if (workspace.kind === 'unauthorized') {
          unauthorized.current()
          return
        }
        // Host unreachable: nothing to learn until it is back; keep probing on the same schedule.
      } else if (workspace.value.updatedAt > 0 && !workspace.value.chats.some((chat) => chat.id === chatId)) {
        // The desktop has reported and this chat is not in it. Said out loud, but not terminal:
        // a restarted desktop re-lists its chats moments later, so the probe keeps running and a
        // successful rejoin's snapshot flips the state back to live. An `updatedAt` of zero means
        // the desktop has not reported *anything* yet - that is a restart window, not a closure.
        setState(chatGone)
      }
      timer = window.setTimeout(connect, reconnectDelayMs(attempt))
      attempt += 1
    }

    const connect = (): void => {
      if (disposed) return
      const next = new WebSocket(hostSocketUrl(host.origin, remoteChatSocketPath(chatId)), [
        REMOTE_CHAT_PROTOCOL,
        remoteChatBearerProtocol(host.token)
      ])
      socket = next
      next.onopen = () => {
        attempt = 0
        live.current = next
      }
      next.onmessage = (event) => {
        if (!disposed) setState((current) => applyServerFrame(current, event.data, Date.now()))
      }
      next.onclose = () => {
        // A superseded socket's close must not tear down its replacement's state.
        if (disposed || socket !== next) return
        socket = null
        if (live.current === next) live.current = null
        setState(connectionLost)
        void classifyThenRetry()
      }
    }

    connect()
    return () => {
      disposed = true
      live.current = null
      window.clearTimeout(timer)
      socket?.close()
    }
    // Re-addressing or re-pairing the host is a different connection, so it tears this one down and
    // starts over rather than leaving a socket authorized by a token that is gone.
  }, [host.id, host.origin, host.token, chatId])

  /**
   * Reading is reported from an effect rather than from a gesture, because on a phone it *is* not a
   * gesture: having the chat on screen is the reading, exactly as having the node selected is on the
   * desktop. `readReportKey` names the moments worth reporting; a frame that never reached the
   * socket is simply not recorded, so the next key change retries it. There is nothing to await -
   * the badge it retires comes back in the host's next workspace projection.
   */
  const readKey = readReportKey(state)
  useEffect(() => {
    if (readKey === null || reportedRead.current === readKey) return
    if (writeToSocket(live.current, { type: 'read' })) reportedRead.current = readKey
  }, [readKey])

  // Retention mirrors the state rather than the keystrokes, so every path that changes the draft -
  // typing, a cleared send, a recovered refusal - is covered by one write.
  useEffect(() => {
    rememberDraft(host.id, chatId, state.draft)
  }, [host.id, chatId, state.draft])

  const onDraftChange = useCallback((draft: string) => {
    setState((current) => draftChanged(current, draft))
  }, [])

  const onSend = useCallback(() => {
    // `plannedSend` is the gate: null means the composer had nothing to offer or the session was
    // not a send target, and nothing must reach the socket in that case.
    const planned = plannedSend(stateRef.current, newRequestId())
    if (!planned) return
    const message: RemoteChatClientMessage = { type: 'prompt', requestId: planned.requestId, text: planned.text }
    const delivered = writeToSocket(live.current, message)
    // The socket write happens exactly once, out here. The updater then *applies* that one
    // decision rather than re-deciding it: the frame is already on the wire, so the composer has
    // to clear and the slot has to hold the verdict, whatever else landed in the same tick.
    setState((current) => {
      const applied = withSend(current, planned)
      return delivered ? applied : sendFailed(applied, 'Not connected — your message was not sent.')
    })
  }, [])

  /**
   * The two answer paths share everything but the frame they build, so they share the write too:
   * plan against the newest committed state, write once, then apply the decision already made.
   */
  const answerPending = useCallback(
    (build: (requestId: string, target: string) => RemoteChatClientMessage | null): void => {
      const target = pendingRequest(stateRef.current)
      if (!target) return
      const requestId = newRequestId()
      const planned = plannedAnswer(stateRef.current, requestId, target.id)
      if (!planned) return
      const message = build(requestId, target.id)
      if (!message) return
      const delivered = writeToSocket(live.current, message)
      setState((current) => {
        const applied = withAnswer(current, planned)
        return delivered ? applied : answerFailed(applied, 'Not connected — your answer was not sent.')
      })
    },
    []
  )

  const onApprove = useCallback(
    (optionId?: string) => {
      answerPending((requestId, target) => {
        if (pendingRequest(stateRef.current)?.kind !== 'approval') return null
        return { type: 'approval', requestId, approvalId: target, ...(optionId ? { optionId } : {}) }
      })
    },
    [answerPending]
  )

  const onAnswerDecision = useCallback(
    (content?: AgentDecisionResponseContent) => {
      answerPending((requestId, target) => {
        if (pendingRequest(stateRef.current)?.kind !== 'decision') return null
        return { type: 'decision', requestId, decisionId: target, ...(content ? { content } : {}) }
      })
    },
    [answerPending]
  )

  return { ...state, onDraftChange, onSend, onApprove, onAnswerDecision }
}

/** Correlates one send with its verdict. Only uniqueness matters, so no crypto API is required. */
function newRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** True only if the frame actually went out; a closed or throwing socket is a failed send. */
function writeToSocket(socket: WebSocket | null, message: RemoteChatClientMessage): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  try {
    socket.send(JSON.stringify(message))
    return true
  } catch {
    return false
  }
}
