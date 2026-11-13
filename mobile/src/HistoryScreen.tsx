import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft } from 'lucide-react'
import type { RemoteHistoryEntry, RemoteHistoryPage } from '../../src/shared/remote-history'
import type { RemoteWorkspaceSnapshot } from '../../src/shared/remote-access'
import type { SavedHost } from './hosts'
import ChatKindBadge from './ChatKindBadge'
import { fetchHistory, fetchWorkspace, openHistory } from './remote-client'

/** Provider history stays on the host; only a selected entry is restored into a live chat. */
export default function HistoryScreen({
  host,
  onBack,
  onUnauthorized,
  onOpened
}: {
  host: SavedHost
  onBack(): void
  onUnauthorized(): void
  onOpened(chatId: string): void
}): JSX.Element {
  const [workspace, setWorkspace] = useState<RemoteWorkspaceSnapshot | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [projectId, setProjectId] = useState('')
  const unauthorized = useRef(onUnauthorized)
  unauthorized.current = onUnauthorized
  const refresh = useCallback(() => setRevision((current) => current + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    setProblem(null)
    void fetchWorkspace(host, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (!result.ok) {
        if (result.kind === 'unauthorized') unauthorized.current()
        else setProblem(result.message)
        return
      }
      setWorkspace(result.value)
      setProjectId((current) =>
        result.value.projects.some((project) => project.id === current) ? current : (result.value.projects[0]?.id ?? '')
      )
    })
    // A phone returning from a network drop or background tab revalidates its scope and handles.
    window.addEventListener('online', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      controller.abort()
      window.removeEventListener('online', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [host, revision, refresh])

  return (
    <main className="screen">
      <header className="chat-head">
        <button type="button" className="back" onClick={onBack} aria-label="Back to chats">
          <ChevronLeft aria-hidden="true" />
        </button>
        <div className="chat-head-copy">
          <h1>History</h1>
          <p>{host.name} · Past provider conversations</p>
        </div>
      </header>
      <p className="hint">Open a conversation to read and continue it in its original checkout.</p>
      <button type="button" className="new-chat" onClick={refresh}>
        Refresh History
      </button>
      {problem && (
        <p className="problem" role="alert">
          {problem} Reconnect, then refresh History.
        </p>
      )}
      {!workspace && !problem && <p role="status">Reading projects…</p>}
      {workspace && workspace.projects.length === 0 && (
        <p className="empty">No projects are available on this desktop.</p>
      )}
      {workspace && workspace.projects.length > 0 && (
        <>
          <label className="history-filter">
            Project
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              {workspace.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          {projectId && !problem && (
            <HistoryEntries
              key={`${projectId}:${revision}`}
              host={host}
              projectId={projectId}
              onUnauthorized={onUnauthorized}
              onOpened={onOpened}
            />
          )}
        </>
      )}
    </main>
  )
}

function HistoryEntries({
  host,
  projectId,
  onUnauthorized,
  onOpened
}: {
  host: SavedHost
  projectId: string
  onUnauthorized(): void
  onOpened(chatId: string): void
}): JSX.Element {
  const [offsets, setOffsets] = useState([0])
  const offset = offsets[offsets.length - 1]
  const [page, setPage] = useState<RemoteHistoryPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [opening, setOpening] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const active = useRef<AbortController | null>(null)
  const openingRef = useRef(false)
  const unauthorized = useRef(onUnauthorized)
  unauthorized.current = onUnauthorized

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setProblem(null)
    setPage(null)
    void fetchHistory(host, projectId, offset, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setLoading(false)
      if (result.ok) setPage(result.value)
      else if (result.kind === 'unauthorized') unauthorized.current()
      else setProblem(result.message)
    })
    return () => controller.abort()
  }, [host, projectId, offset, retry])
  useEffect(() => () => active.current?.abort(), [])

  const open = async (entry: RemoteHistoryEntry): Promise<void> => {
    if (openingRef.current) return
    openingRef.current = true
    setOpening(entry.key)
    setProblem(null)
    const controller = new AbortController()
    active.current = controller
    const result = await openHistory(host, { projectId, key: entry.key }, controller.signal)
    if (controller.signal.aborted) return
    openingRef.current = false
    setOpening(null)
    if (result.ok) onOpened(result.value)
    else if (result.kind === 'unauthorized') unauthorized.current()
    else
      setProblem(
        `${result.message} If the connection dropped while opening, select the same entry again; it will reuse its chat.`
      )
  }
  const entries =
    page?.entries.filter((entry) =>
      `${entry.title} ${entry.provider} ${entry.directoryLabel}`
        .toLocaleLowerCase()
        .includes(filter.trim().toLocaleLowerCase())
    ) ?? []

  return (
    <section className="history-browser" aria-label="Past conversations" aria-busy={loading || opening !== null}>
      <label className="history-filter">
        Filter this page
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Title, provider or branch"
        />
      </label>
      {loading && <p role="status">Reading History…</p>}
      {problem && (
        <p className="problem" role="alert">
          {problem}
        </p>
      )}
      {problem && !page && (
        <button type="button" className="new-chat" onClick={() => setRetry((value) => value + 1)}>
          Retry
        </button>
      )}
      {opening && (
        <p role="status">
          Opening conversation… Waiting for the desktop session. You can leave this screen; the chat may still open.
        </p>
      )}
      {page && (
        <>
          <p className="hint">
            Newest first · Page {offsets.length} · {page.total} recorded conversations
          </p>
          <ul className="history-list">
            {entries.map((entry) => (
              <li key={entry.key}>
                <button
                  type="button"
                  className="history-row"
                  disabled={opening !== null}
                  onClick={() => void open(entry)}
                >
                  <strong>{entry.title}</strong>
                  <span className="history-context">
                    <ChatKindBadge kind={entry.provider} />
                    <span>{entry.provider === 'claude' ? 'Claude' : 'Codex'}</span>
                    <span>{entry.directoryLabel}</span>
                  </span>
                  <small>
                    <time dateTime={entry.updatedAt}>{historyTime(entry.updatedAt)}</time> · {entry.messageCount}{' '}
                    messages
                  </small>
                  <span className="history-action">{opening === entry.key ? 'Opening…' : 'Open conversation'}</span>
                </button>
              </li>
            ))}
          </ul>
          {page.total === 0 && (
            <p className="empty">No past conversations were found for this project and its registered worktrees.</p>
          )}
          {page.total > 0 && entries.length === 0 && (
            <p className="empty">No matches on this page. Clear the filter or browse another page.</p>
          )}
          <nav className="history-pages" aria-label="History pages">
            <button
              type="button"
              disabled={offsets.length === 1 || opening !== null}
              onClick={() => setOffsets((current) => current.slice(0, -1))}
            >
              Newer
            </button>
            <button
              type="button"
              disabled={!page.hasMore || opening !== null}
              onClick={() => setOffsets((current) => [...current, page.nextOffset])}
            >
              Older
            </button>
          </nav>
        </>
      )}
    </section>
  )
}

function historyTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Unknown time'
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
