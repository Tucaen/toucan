import { useCallback, useEffect, useRef, useState } from 'react'
import {
  REMOTE_CHAT_PROTOCOL,
  remoteChatBearerProtocol,
  remoteChatSocketPath,
  type RemoteChatClientMessage
} from '../../src/shared/remote-chat'
import {
  applyServerFrame,
  chatGone,
  connectionLost,
  draftChanged,
  plannedSend,
  reconnectDelayMs,
  restoredChatConnectionState,
  sendFailed,
  withSend,
  type ChatConnectionState
} from './chat-connection'
import { fetchWorkspace, rememberDraft, storedDraft } from './remote-client'

/**
 * Owns the WebSocket for one chat; every decision about what frames and drops *mean* lives in
 * `chat-connection.ts`. The token rides in the subprotocol list because a browser cannot put an
 * `Authorization` header on an upgrade request.
 *
 * A closed socket is ambiguous on purpose - the browser will not say whether the handshake was
 * refused with 401, refused with 404, or the network blinked - so every drop is classified through
 * one authenticated HTTP probe: a revoked token unpaired the device, a chat the desktop no longer
 * lists is gone, and anything else is a blip worth rejoining after a bounded backoff.
 */
export interface ChatConnection extends ChatConnectionState {
  onDraftChange(draft: string): void
  /** Sends the current draft, if the state allows it. Ignored otherwise, so a stale tap is inert. */
  onSend(): void
}

export function useChatConnection(token: string, chatId: string, onUnauthorized: () => void): ChatConnection {
  const [state, setState] = useState<ChatConnectionState>(() => restoredChatConnectionState(storedDraft(chatId)))
  const unauthorized = useRef(onUnauthorized)
  unauthorized.current = onUnauthorized
  // The live socket, readable by the send path. A send is only ever attempted on the socket that
  // is open right now; a superseded one is never written to.
  const live = useRef<WebSocket | null>(null)
  // The send path reads state outside a render, and it must read the newest committed one.
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    setState(restoredChatConnectionState(storedDraft(chatId)))
    let disposed = false
    let socket: WebSocket | null = null
    let timer: number | undefined
    let attempt = 0

    const classifyThenRetry = async (): Promise<void> => {
      const workspace = await fetchWorkspace(token)
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
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const next = new WebSocket(`${scheme}://${window.location.host}${remoteChatSocketPath(chatId)}`, [
        REMOTE_CHAT_PROTOCOL,
        remoteChatBearerProtocol(token)
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
  }, [token, chatId])

  // Retention mirrors the state rather than the keystrokes, so every path that changes the draft -
  // typing, a cleared send, a recovered refusal - is covered by one write.
  useEffect(() => {
    rememberDraft(chatId, state.draft)
  }, [chatId, state.draft])

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

  return { ...state, onDraftChange, onSend }
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
