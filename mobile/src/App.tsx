import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EMPTY_REMOTE_WORKSPACE_SNAPSHOT, type RemoteWorkspaceSnapshot } from '../../src/shared/remote-access'
import { attentionLabel, chatStatusLabel, countActiveChats, groupChatsByProject, snapshotAgeLabel } from './chat-list'
import {
  WORKSPACE_POLL_MS,
  fetchWorkspace,
  forgetToken,
  rememberToken,
  storedToken,
  verifyToken
} from './remote-client'

/**
 * Toucan on a phone: pair once, then watch the workspace's agent chats.
 *
 * Two states, and the difference between them is one token. Unpaired shows the pairing screen;
 * paired polls the host for its workspace projection. A `401` at any point drops straight back to
 * pairing rather than showing a stale list, because a revoked token means the list is no longer
 * something this device is allowed to see.
 */
export default function App(): JSX.Element {
  const [token, setToken] = useState<string | null>(() => storedToken())

  const unpair = useCallback(() => {
    forgetToken()
    setToken(null)
  }, [])

  return token === null ? (
    <PairingScreen
      onPaired={(paired) => {
        rememberToken(paired)
        setToken(paired)
      }}
    />
  ) : (
    <ChatListScreen token={token} onUnauthorized={unpair} onUnpair={unpair} />
  )
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
  onUnpair
}: {
  token: string
  onUnauthorized(): void
  onUnpair(): void
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<RemoteWorkspaceSnapshot>(EMPTY_REMOTE_WORKSPACE_SNAPSHOT)
  const [problem, setProblem] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const unauthorized = useRef(onUnauthorized)
  unauthorized.current = onUnauthorized

  // One interval owns both the poll and the clock the staleness label reads, so the list cannot
  // claim to be fresh while nothing is actually being fetched.
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()

    const poll = async (): Promise<void> => {
      const result = await fetchWorkspace(token, controller.signal)
      if (cancelled) return
      setNow(Date.now())
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
  const age = snapshotAgeLabel(snapshot, now)

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
          {summary.working > 0 && <span className="summary-chip working">{summary.working} working</span>}
          {summary.unread > 0 && <span className="summary-chip unread">{summary.unread} unread</span>}
          {summary.working === 0 && summary.unread === 0 && <span className="summary-chip">Nothing running</span>}
          {age && <span className="summary-chip stale">{age}</span>}
        </p>
      </header>

      {problem && <p className="problem">{problem}</p>}

      {groups.length === 0 && !problem && (
        <p className="empty">No agent chats are open on the desktop. Terminals are not shown here.</p>
      )}

      {groups.map((group) => (
        <section className="project" key={group.project.id}>
          <h2>
            <span className="project-dot" style={{ background: group.project.color }} />
            {group.project.name}
            {group.unread > 0 && <span className="project-unread">{group.unread}</span>}
          </h2>
          <ul>
            {group.chats.map((chat) => (
              <li className="chat" key={chat.id} data-status={chat.status}>
                <span className="chat-kind" data-kind={chat.kind}>
                  {chat.kind === 'claude' ? 'CL' : 'CX'}
                </span>
                <span className="chat-copy">
                  <strong>{chat.title}</strong>
                  <small>{chatStatusLabel(chat.status)}</small>
                </span>
                {chat.attention && <span className="chat-attention">{attentionLabel(chat.attention)}</span>}
                {chat.unread > 0 && <span className="chat-unread">{chat.unread}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  )
}
