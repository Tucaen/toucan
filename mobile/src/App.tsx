import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  EMPTY_REMOTE_WORKSPACE_SNAPSHOT,
  type RemoteChatSummary,
  type RemoteWorkspaceSnapshot
} from '../../src/shared/remote-access'
import {
  attentionLabel,
  chatNeedsApproval,
  chatStatusLabel,
  countActiveChats,
  groupChatsByProject,
  isAwaitingDesktop
} from './chat-list'
import ChatScreen from './ChatScreen'
import {
  WORKSPACE_POLL_MS,
  fetchWorkspace,
  forgetToken,
  rememberToken,
  storedToken,
  verifyToken
} from './remote-client'
import { chatPathname, routeFromPathname, type MobileRoute } from './routes'

/**
 * Toucan on a phone: pair once, then watch the workspace's agent chats and read any of them live.
 *
 * Two states, and the difference between them is one token. Unpaired shows the pairing screen;
 * paired shows the chat list or one chat, addressed by pathname so the browser's back button and a
 * reloaded deep link both work. A `401` at any point drops straight back to pairing rather than
 * showing a stale view, because a revoked token means none of this is something this device is
 * allowed to see.
 */
export default function App(): JSX.Element {
  const [token, setToken] = useState<string | null>(() => storedToken())
  const [route, setRoute] = useState<MobileRoute>(() => routeFromPathname(window.location.pathname))
  // What the list knew about the chat it navigated to, so the chat header has a title immediately.
  const [openedChat, setOpenedChat] = useState<RemoteChatSummary | null>(null)

  useEffect(() => {
    const onPopState = (): void => setRoute(routeFromPathname(window.location.pathname))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const unpair = useCallback(() => {
    forgetToken()
    setToken(null)
  }, [])

  const openChat = useCallback((chat: RemoteChatSummary) => {
    setOpenedChat(chat)
    window.history.pushState({ chat: true }, '', chatPathname(chat.id))
    setRoute({ screen: 'chat', chatId: chat.id })
  }, [])

  const backToList = useCallback(() => {
    // Navigated from the list: the browser's own history entry is the way back. A reloaded deep
    // link has no entry to pop, so the list is put in place rather than leaving the app.
    if (window.history.state && (window.history.state as { chat?: boolean }).chat) {
      window.history.back()
      return
    }
    window.history.replaceState(null, '', '/')
    setRoute({ screen: 'list' })
  }, [])

  if (token === null) {
    return (
      <PairingScreen
        onPaired={(paired) => {
          rememberToken(paired)
          setToken(paired)
        }}
      />
    )
  }
  if (route.screen === 'chat') {
    return (
      <ChatScreen
        key={route.chatId}
        token={token}
        chatId={route.chatId}
        summary={openedChat?.id === route.chatId ? openedChat : null}
        onBack={backToList}
        onUnauthorized={unpair}
      />
    )
  }
  return <ChatListScreen token={token} onUnauthorized={unpair} onUnpair={unpair} onOpenChat={openChat} />
}

function PairingScreen({ onPaired }: { onPaired(token: string): void }): JSX.Element {
  const [entered, setEntered] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const pair = async (): Promise<void> => {
    const candidate = entered.trim()
    if (!candidate) return
    setBusy(true)
    setProblem(null)
    const result = await verifyToken(candidate)
    setBusy(false)
    if (result.ok) {
      onPaired(candidate)
      return
    }
    setProblem(
      result.kind === 'unauthorized'
        ? 'That token was not accepted. Check it in Toucan under Remote access.'
        : result.message
    )
  }

  return (
    <main className="screen">
      <header className="screen-head">
        <h1>Toucan</h1>
        <p>Pair this phone with the desktop it is going to drive.</p>
      </header>
      <form
        className="pairing"
        onSubmit={(event) => {
          event.preventDefault()
          void pair()
        }}
      >
        <label>
          <span>Pairing token</span>
          <input
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={entered}
            placeholder="Paste the token from Toucan"
            disabled={busy}
            onChange={(event) => setEntered(event.target.value)}
          />
        </label>
        {problem && <p className="problem">{problem}</p>}
        <button type="submit" disabled={busy || entered.trim().length === 0}>
          {busy ? 'Checking…' : 'Pair'}
        </button>
        <p className="hint">
          On the desktop: header → the phone icon → enable remote access, then copy the token shown there.
        </p>
      </form>
    </main>
  )
}

function ChatListScreen({
  token,
  onUnauthorized,
  onUnpair,
  onOpenChat
}: {
  token: string
  onUnauthorized(): void
  onUnpair(): void
  onOpenChat(chat: RemoteChatSummary): void
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<RemoteWorkspaceSnapshot>(EMPTY_REMOTE_WORKSPACE_SNAPSHOT)
  const [problem, setProblem] = useState<string | null>(null)
  const unauthorized = useRef(onUnauthorized)
  unauthorized.current = onUnauthorized

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()

    const poll = async (): Promise<void> => {
      const result = await fetchWorkspace(token, controller.signal)
      if (cancelled) return
      if (result.ok) {
        setSnapshot(result.value)
        setProblem(null)
        return
      }
      if (result.kind === 'unauthorized') {
        unauthorized.current()
        return
      }
      setProblem(result.message)
    }

    void poll()
    const timer = window.setInterval(() => void poll(), WORKSPACE_POLL_MS)
    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(timer)
    }
  }, [token])

  const groups = useMemo(() => groupChatsByProject(snapshot), [snapshot])
  const summary = useMemo(() => countActiveChats(snapshot), [snapshot])
  const awaiting = isAwaitingDesktop(snapshot)

  return (
    <main className="screen">
      <header className="screen-head">
        <div className="screen-head-row">
          <h1>Toucan</h1>
          <button type="button" className="unpair" onClick={onUnpair}>
            Unpair
          </button>
        </div>
        <p>
          {awaiting && <span className="summary-chip stale">Waiting for the desktop</span>}
          {/* Stalled first: a chat nobody can advance outranks a count of things still moving. */}
          {!awaiting && summary.approvals > 0 && (
            <span className="summary-chip approval">{summary.approvals} needs approval</span>
          )}
          {!awaiting && summary.working > 0 && <span className="summary-chip working">{summary.working} working</span>}
          {!awaiting && summary.unread > 0 && <span className="summary-chip unread">{summary.unread} unread</span>}
          {!awaiting && summary.working === 0 && summary.unread === 0 && (
            <span className="summary-chip">Nothing running</span>
          )}
        </p>
      </header>

      {problem && <p className="problem">{problem}</p>}

      {/* "Nothing is open" and "the desktop has not reported yet" must not read the same. */}
      {groups.length === 0 && !problem && !awaiting && (
        <p className="empty">No agent chats are open on the desktop. Terminals are not shown here.</p>
      )}
      {awaiting && !problem && <p className="empty">Paired. Waiting for this desktop to report what it has open.</p>}

      {groups.map((group) => (
        <section className="project" key={group.project.id}>
          <h2>
            <span className="project-dot" style={{ background: group.project.color }} />
            {group.project.name}
            {group.approvals > 0 && <span className="project-approval">Needs approval</span>}
            {group.unread > 0 && <span className="project-unread">{group.unread}</span>}
          </h2>
          <ul>
            {group.chats.map((chat) => (
              <li key={chat.id}>
                <button
                  type="button"
                  className="chat"
                  data-status={chat.status}
                  // A stalled chat has to be findable at a glance, so it carries its own state
                  // rather than only a count that looks like every other unread badge.
                  data-needs-approval={chatNeedsApproval(chat) || undefined}
                  onClick={() => onOpenChat(chat)}
                >
                  <span className="chat-kind" data-kind={chat.kind}>
                    {chat.kind === 'claude' ? 'CL' : 'CX'}
                  </span>
                  <span className="chat-copy">
                    <strong>{chat.title}</strong>
                    <small>{chatNeedsApproval(chat) ? 'Needs approval' : chatStatusLabel(chat.status)}</small>
                  </span>
                  {chat.attention && (
                    <span className="chat-attention" data-kind={chat.attention}>
                      {attentionLabel(chat.attention)}
                    </span>
                  )}
                  {chat.unread > 0 && <span className="chat-unread">{chat.unread}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  )
}
