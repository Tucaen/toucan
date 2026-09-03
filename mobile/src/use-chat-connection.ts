import { useEffect, useRef, useState } from 'react'
import { REMOTE_CHAT_PROTOCOL, remoteChatBearerProtocol, remoteChatSocketPath } from '../../src/shared/remote-chat'
import {
  applyServerFrame,
  chatGone,
  connectionLost,
  initialChatConnectionState,
  reconnectDelayMs,
  type ChatConnectionState
} from './chat-connection'
import { fetchWorkspace } from './remote-client'

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
export function useChatConnection(token: string, chatId: string, onUnauthorized: () => void): ChatConnectionState {
  const [state, setState] = useState<ChatConnectionState>(initialChatConnectionState)
  const unauthorized = useRef(onUnauthorized)
  unauthorized.current = onUnauthorized

  useEffect(() => {
    setState(initialChatConnectionState())
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
      }
      next.onmessage = (event) => {
        if (!disposed) setState((current) => applyServerFrame(current, event.data, Date.now()))
      }
      next.onclose = () => {
        // A superseded socket's close must not tear down its replacement's state.
        if (disposed || socket !== next) return
        socket = null
        setState(connectionLost)
        void classifyThenRetry()
      }
    }

    connect()
    return () => {
      disposed = true
      window.clearTimeout(timer)
      socket?.close()
    }
  }, [token, chatId])

  return state
}
