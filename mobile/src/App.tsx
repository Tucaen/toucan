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
  hostBlockedByPageScheme,
  hostDraftProblem,
  hostNeedsPairing,
  normalizeHostOrigin,
  type HostDraft,
  type SavedHost
} from './hosts'
import { effectiveHostStatus, hostStatusLabel, type HostProbe, type HostStatuses } from './host-status'
import HostsScreen from './HostsScreen'
import NewChatScreen from './NewChatScreen'
import { WORKSPACE_POLL_MS, fetchWorkspace, verifyHost } from './remote-client'
import { chatPathname, routeFromPathname, HOSTS_PATHNAME, NEW_CHAT_PATHNAME, type MobileRoute } from './routes'
import { useHostDirectory } from './use-host-directory'

/**
 * Toucan on a phone: pair with one host or several, then watch each one's agent chats and read any
 * of them live.
 *
 * There is exactly one thing this shell is parameterized by, and it is the selected host. Nothing
 * is paired yet, so the pairing screen; the selected host stopped accepting its token, so the
 * pairing screen *for that host* with the others still reachable behind it; otherwise the chat list
 * or one chat, addressed by pathname so the browser's back button and a reloaded deep link both
 * work.
 *
 * Switching hosts is a remount, not a re-render: every screen is keyed on the host id, so the
 * previous host's socket, poll and transcript are torn down by React rather than by bookkeeping
 * that could miss one. And a `401` no longer unpairs the *device* - it drops one host into
 * re-pairing, which is what keeps the app usable against the other while one PC is compromised,
 * rebuilt, or simply had its token regenerated.
 */
export default function App(): JSX.Element {
  const hosts = useHostDirectory()
  const [route, setRoute] = useState<MobileRoute>(() => routeFromPathname(window.location.pathname))
  // What the list knew about the chat it navigated to, so the chat header has a title immediately.
  const [openedChat, setOpenedChat] = useState<RemoteChatSummary | null>(null)
  // True while the add-host form is open over an already-populated list.
  const [addingHost, setAddingHost] = useState(false)

  useEffect(() => {
    const onPopState = (): void => setRoute(routeFromPathname(window.location.pathname))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const host = hosts.host

  const openChat = useCallback((chat: RemoteChatSummary) => {
    setOpenedChat(chat)
    window.history.pushState({ pushed: true }, '', chatPathname(chat.id))
    setRoute({ screen: 'chat', chatId: chat.id })
  }, [])

  const openNewChat = useCallback(() => {
    window.history.pushState({ pushed: true }, '', NEW_CHAT_PATHNAME)
    setRoute({ screen: 'new' })
  }, [])

  const openHosts = useCallback(() => {
    window.history.pushState({ pushed: true }, '', HOSTS_PATHNAME)
    setRoute({ screen: 'hosts' })
  }, [])

  /**
   * A spawn landed. The form's history entry is *replaced* rather than added to: nobody wants Back
   * out of a chat they just created to put them in the form that created it, so the chat takes the
   * entry the form was occupying and Back still means the list.
   */
  const enterSpawnedChat = useCallback((chatId: string) => {
    setOpenedChat(null)
    window.history.replaceState({ pushed: true }, '', chatPathname(chatId))
    setRoute({ screen: 'chat', chatId })
  }, [])

  const backToList = useCallback(() => {
    // Navigated from the list: the browser's own history entry is the way back. A reloaded deep
    // link has no entry to pop, so the list is put in place rather than leaving the app.
    if (window.history.state && (window.history.state as { pushed?: boolean }).pushed) {
      window.history.back()
      return
    }
    window.history.replaceState(null, '', '/')
    setRoute({ screen: 'list' })
  }, [])

  /**
   * Switching host lands on that host's list, never on the chat that was open: a chat id belongs to
   * the host that minted it, so carrying the route across would ask host B for host A's node and
   * show a chat that is "no longer open" when in truth it was never this host's.
   */
  const switchHost = useCallback(
    (id: string) => {
      hosts.selectHost(id)
      window.history.replaceState(null, '', '/')
      setOpenedChat(null)
      setRoute({ screen: 'list' })
    },
    [hosts]
  )

  const pairHost = useCallback(
    (draft: HostDraft) => {
      hosts.pairHost(draft)
      setAddingHost(false)
      window.history.replaceState(null, '', '/')
      setOpenedChat(null)
      setRoute({ screen: 'list' })
    },
    [hosts]
  )

  const revokeSelected = useCallback(() => {
    if (host) hosts.revokeHost(host.id)
  }, [host, hosts])

  if (hosts.directory.hosts.length === 0 || addingHost) {
    return <PairingScreen onPaired={pairHost} onCancel={addingHost ? () => setAddingHost(false) : null} />
  }
  if (!host) {
    // Only reachable for the instant between removing the last host and the re-render; the list
    // decides the selection, so there is nothing to recover here.
    return <PairingScreen onPaired={pairHost} onCancel={null} />
  }
  // Ahead of the re-pair screen on purpose: a host that stopped accepting its token is exactly when
  // the reader most needs to reach the others, so the switcher must not be behind the wall.
  if (route.screen === 'hosts') {
    return (
      <HostsScreen
        directory={hosts.directory}
        statuses={hosts.statuses}
        onBack={backToList}
        onSelect={switchHost}
        onRename={hosts.renameHost}
        onRemove={hosts.removeHost}
        onAddHost={() => setAddingHost(true)}
      />
    )
  }
  if (hostNeedsPairing(host)) {
    return (
      <RepairHostScreen
        host={host}
        onPaired={pairHost}
        onOpenHosts={openHosts}
        hostCount={hosts.directory.hosts.length}
      />
    )
  }
  if (route.screen === 'chat') {
    return (
      <ChatScreen
        key={`${host.id}:${route.chatId}`}
        host={host}
        chatId={route.chatId}
        summary={openedChat?.id === route.chatId ? openedChat : null}
        onBack={backToList}
        onUnauthorized={revokeSelected}
      />
    )
  }
  if (route.screen === 'new') {
    return (
      <NewChatScreen
        key={host.id}
        host={host}
        onBack={backToList}
        onUnauthorized={revokeSelected}
        onSpawned={enterSpawnedChat}
      />
    )
  }
  return (
    <ChatListScreen
      key={host.id}
      host={host}
      statuses={hosts.statuses}
      hostCount={hosts.directory.hosts.length}
      onUnauthorized={revokeSelected}
      onOpenHosts={openHosts}
      onOpenChat={openChat}
      onNewChat={openNewChat}
      onProbe={hosts.reportProbe}
    />
  )
}

/**
 * Adding a host: where it is, and the token that authorizes driving it.
 *
 * The origin is prefilled with whatever served this page, because the overwhelmingly common first
 * pairing is with the host the QR code came from - and typing a URL on a phone is the worst part of
 * this flow. `normalizeHostOrigin` is forgiving on purpose (a scheme may be left off, a pasted deep
 * link is trimmed back to its host), so the field accepts what a reader would actually paste.
 */
function PairingScreen({
  onPaired,
  onCancel
}: {
  onPaired(draft: HostDraft): void
  /** Present only when there is something to go back to: the first pairing has no cancel. */
  onCancel: (() => void) | null
}): JSX.Element {
  const [draft, setDraft] = useState<HostDraft>({ name: '', origin: window.location.origin, token: '' })
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const blocked = hostDraftProblem(draft)

  const pair = async (): Promise<void> => {
    if (blocked) return
    // Normalized before it is asked, not only before it is saved: the field deliberately accepts a
    // bare `work-pc:1789` and a pasted deep link, and neither is a URL `fetch` would resolve the
    // way the reader means - one is a scheme, the other carries a path the API sits under.
    const origin = normalizeHostOrigin(draft.origin)
    if (origin === null) return
    setBusy(true)
    setProblem(null)
    // Checked before it is saved: an unreachable address or a wrong token saved as a host would
    // present itself later as an offline PC rather than as a typo made a moment ago.
    const result = await verifyHost({ origin, token: draft.token.trim() })
    setBusy(false)
    if (result.ok) {
      onPaired(draft)
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
        <p>Pair this phone with a desktop it is going to drive.</p>
      </header>
      <form
        className="pairing"
        onSubmit={(event) => {
          event.preventDefault()
          void pair()
        }}
      >
        <label>
          <span>Host address</span>
          <input
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
            value={draft.origin}
            placeholder="work-pc:1789"
            disabled={busy}
            onChange={(event) => setDraft((current) => ({ ...current, origin: event.target.value }))}
          />
        </label>
        <label>
          <span>Name (optional)</span>
          <input
            autoCapitalize="words"
            value={draft.name}
            placeholder="Work PC"
            disabled={busy}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          />
        </label>
        <label>
          <span>Pairing token</span>
          <input
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={draft.token}
            placeholder="Paste the token from Toucan"
            disabled={busy}
            onChange={(event) => setDraft((current) => ({ ...current, token: event.target.value }))}
          />
        </label>
        {problem && (
          <p className="problem" role="alert">
            {problem}
          </p>
        )}
        <button type="submit" disabled={busy || blocked !== null}>
          {busy ? 'Checking…' : 'Pair'}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <p className="hint">
          On that desktop: header → the phone icon → enable remote access, then copy the token shown there.
        </p>
      </form>
    </main>
  )
}

/**
 * One host stopped accepting its token. Scoped to that host by construction: the others keep their
 * tokens and stay one tap away, which is the difference between "re-pair the work PC" and "this
 * phone is unpaired".
 */
function RepairHostScreen({
  host,
  onPaired,
  onOpenHosts,
  hostCount
}: {
  host: SavedHost
  onPaired(draft: HostDraft): void
  onOpenHosts(): void
  hostCount: number
}): JSX.Element {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const repair = async (): Promise<void> => {
    const candidate = token.trim()
    if (candidate.length === 0) return
    setBusy(true)
    setProblem(null)
    const result = await verifyHost({ origin: host.origin, token: candidate })
    setBusy(false)
    if (result.ok) {
      // Same origin, so this re-pairs the saved entry rather than adding a second one - the id,
      // and with it this host's retained drafts, survive.
      onPaired({ name: host.name, origin: host.origin, token: candidate })
      return
    }
    setProblem(
      result.kind === 'unauthorized'
        ? 'That token was not accepted either. Regenerate it in Toucan under Remote access.'
        : result.message
    )
  }

  return (
    <main className="screen">
      <header className="screen-head">
        <div className="screen-head-row">
          <h1>{host.name}</h1>
          {hostCount > 1 && (
            <button type="button" className="unpair" onClick={onOpenHosts}>
              Other hosts
            </button>
          )}
        </div>
        <p>This host no longer accepts its pairing token. Paste the current one to reconnect.</p>
      </header>
      <form
        className="pairing"
        onSubmit={(event) => {
          event.preventDefault()
          void repair()
        }}
      >
        <label>
          <span>Pairing token for {host.origin}</span>
          <input
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={token}
            placeholder="Paste the token from Toucan"
            disabled={busy}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        {problem && (
          <p className="problem" role="alert">
            {problem}
          </p>
        )}
        <button type="submit" disabled={busy || token.trim().length === 0}>
          {busy ? 'Checking…' : 'Re-pair'}
        </button>
      </form>
    </main>
  )
}

function ChatListScreen({
  host,
  statuses,
  hostCount,
  onUnauthorized,
  onOpenHosts,
  onOpenChat,
  onNewChat,
  onProbe
}: {
  host: SavedHost
  statuses: HostStatuses
  hostCount: number
  onUnauthorized(): void
  onOpenHosts(): void
  onOpenChat(chat: RemoteChatSummary): void
  onNewChat(): void
  onProbe(id: string, probe: HostProbe): void
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<RemoteWorkspaceSnapshot>(EMPTY_REMOTE_WORKSPACE_SNAPSHOT)
  const unauthorized = useRef(onUnauthorized)
  unauthorized.current = onUnauthorized
  const probe = useRef(onProbe)
  probe.current = onProbe

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()

    const poll = async (): Promise<void> => {
      const result = await fetchWorkspace(host, controller.signal)
      if (cancelled) return
      if (result.ok) {
        setSnapshot(result.value)
        probe.current(host.id, { ok: true })
        return
      }
      if (result.kind === 'unauthorized') {
        // Reported before unpairing: the host is up, and the switcher has to say that rather than
        // leave it looking offline behind the re-pair screen.
        probe.current(host.id, { ok: false, unauthorized: true })
        unauthorized.current()
        return
      }
      // The poll keeps running. A host that went away is an offline *host*, not a broken app: the
      // last snapshot stays on screen as explicitly stale and the switcher is still one tap away.
      probe.current(host.id, { ok: false, message: result.message })
    }

    void poll()
    const timer = window.setInterval(() => void poll(), WORKSPACE_POLL_MS)
    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(timer)
    }
  }, [host])

  const groups = useMemo(() => groupChatsByProject(snapshot), [snapshot])
  const summary = useMemo(() => countActiveChats(snapshot), [snapshot])
  const awaiting = isAwaitingDesktop(snapshot)
  const status = effectiveHostStatus(host, statuses)
  const offline = status.reachability === 'offline'
  // Whether the counts describe the present. They do not while the host is unreachable or has not
  // reported, and one derivation says so once rather than five chips each re-deciding it.
  const counted = !offline && !awaiting
  const blocked = hostBlockedByPageScheme(host.origin, window.location.protocol)

  return (
    <main className="screen">
      <header className="screen-head">
        <div className="screen-head-row">
          <h1>Toucan</h1>
          {/* The switcher is the header's identity as well as its control: which PC this is has to
              be readable without opening anything, because every count below belongs to it. */}
          <button type="button" className="host-switch" onClick={onOpenHosts}>
            <span className="host-dot" data-reachability={status.reachability} aria-hidden="true" />
            <span className="host-switch-name">{host.name}</span>
            <span className="host-switch-state">
              {hostCount > 1 ? `${hostStatusLabel(status)} · switch` : hostStatusLabel(status)}
            </span>
          </button>
        </div>
        <p>
          {/* An unreachable host outranks every count, and so does a desktop that has not reported:
              in both cases the counts below would be a memory presented as the present. */}
          {offline && <span className="summary-chip stale">Host offline — reconnecting…</span>}
          {!offline && awaiting && <span className="summary-chip stale">Waiting for the desktop</span>}
          {/* Stalled first: a chat nobody can advance outranks a count of things still moving. */}
          {counted && summary.approvals > 0 && (
            <span className="summary-chip approval">{summary.approvals} needs approval</span>
          )}
          {counted && summary.working > 0 && <span className="summary-chip working">{summary.working} working</span>}
          {counted && summary.unread > 0 && <span className="summary-chip unread">{summary.unread} unread</span>}
          {counted && summary.working === 0 && summary.unread === 0 && (
            <span className="summary-chip">Nothing running</span>
          )}
        </p>
      </header>

      {/* Non-blocking by design: the reason is stated, the last known list stays readable, and the
          retry runs on its own schedule. Nothing here is a dead end the reader has to back out of. */}
      {offline && (
        <p className="problem" role="status">
          {host.name} is not answering{status.message ? ` (${status.message})` : ''}. It will reconnect on its own when
          the desktop is back.
        </p>
      )}
      {blocked && <p className="problem">{blocked}</p>}

      {/* The list's one action. Offered even while the desktop is quiet: a workspace with nothing
          open is exactly when starting something is the useful thing to do. */}
      <button type="button" className="new-chat" onClick={onNewChat} disabled={offline}>
        New chat
      </button>

      {/* "Nothing is open" and "the desktop has not reported yet" must not read the same. */}
      {groups.length === 0 && !offline && !awaiting && (
        <p className="empty">No agent chats are open on the desktop. Terminals are not shown here.</p>
      )}
      {awaiting && !offline && <p className="empty">Paired. Waiting for this desktop to report what it has open.</p>}

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
