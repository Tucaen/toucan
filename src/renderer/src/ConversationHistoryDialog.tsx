import { useCallback, useEffect, useRef, useState } from 'react'
import { Folder } from 'lucide-react'
import type { ConversationSummary } from '../../shared/conversation'
import { formatRelativeTime } from './relative-date'
import SessionKindIcon from './SessionKindIcon'

/** One page is what a single open reads off disk; the rest of a long history stays unopened. */
export const CONVERSATION_PAGE_SIZE = 25

export interface ConversationHistoryDialogProps {
  projectName: string
  /** The project checkout plus its worktrees: every directory whose transcripts belong here. */
  directories: string[]
  /** Lowercased directory path to the name shown for it, so a worktree reads as its branch. */
  directoryLabels: Record<string, string>
  onCancel(): void
  onOpen(entry: ConversationSummary): void
}

const providerLabels: Record<ConversationSummary['provider'], string> = {
  claude: 'Claude',
  codex: 'Codex'
}

export default function ConversationHistoryDialog({
  projectName,
  directories,
  directoryLabels,
  onCancel,
  onOpen
}: ConversationHistoryDialogProps): JSX.Element {
  const [entries, setEntries] = useState<ConversationSummary[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // A transcript can be deleted while the list is open; the row it was listed as says so
  // rather than the resume failing later with nothing to point at.
  const [missing, setMissing] = useState<Record<string, true>>({})

  // The canvas rebuilds this array on every node change, so paging keys off what is in it
  // rather than its identity - otherwise an unrelated status update would reset the list.
  const directoriesRef = useRef(directories)
  directoriesRef.current = directories
  const directoryKey = directories.join('|')

  const loadPage = useCallback(
    async (offset: number): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        const page = await window.conversationApi.list({
          directories: directoriesRef.current,
          limit: CONVERSATION_PAGE_SIZE,
          offset
        })
        setEntries((current) => (offset === 0 ? page.entries : [...current, ...page.entries]))
        setTotal(page.total)
        setHasMore(page.hasMore)
      } catch {
        setError('Past conversations could not be read.')
      } finally {
        setLoading(false)
      }
    },
    // `directoryKey` stands in for `directoriesRef.current`, which the loader reads at call time so
    // an in-flight page can never be answered against a stale directory set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [directoryKey]
  )

  useEffect(() => {
    void loadPage(0)
  }, [loadPage])

  const open = useCallback(
    async (entry: ConversationSummary): Promise<void> => {
      const stillThere = await window.conversationApi.exists(entry.path).catch(() => false)
      if (!stillThere) {
        setMissing((current) => ({ ...current, [entry.path]: true }))
        return
      }
      onOpen(entry)
    },
    [onOpen]
  )

  return (
    <div
      className="worktree-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conversation-history-title"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="worktree-dialog conversation-history-dialog">
        <strong id="conversation-history-title">Past conversations in {projectName}</strong>
        <p>
          Every transcript this project and its worktrees recorded, newest first.
          {total > 0 && ` Showing ${entries.length} of ${total}.`} Automatic titles are generated locally and use no
          model tokens or account budget.
        </p>

        {error && <p className="worktree-dialog-error">{error}</p>}

        <ul className="conversation-history-list">
          {entries.map((entry) => {
            const unavailable = missing[entry.path]
            return (
              <li key={entry.path}>
                <button
                  type="button"
                  className="conversation-history-row"
                  data-unavailable={unavailable ? 'true' : undefined}
                  disabled={unavailable}
                  onClick={() => void open(entry)}
                >
                  <span className={`menu-icon ${entry.provider}-icon`}>
                    <SessionKindIcon kind={entry.provider} />
                  </span>
                  <span className="conversation-history-copy">
                    <strong>{entry.title}</strong>
                    <small>
                      {providerLabels[entry.provider]}
                      {' · '}
                      {formatRelativeTime(entry.updatedAt)}
                      {' · '}
                      {entry.messageCount} {entry.messageCount === 1 ? 'message' : 'messages'}
                      {' · '}
                      <Folder aria-hidden="true" className="conversation-history-directory-icon" />
                      {directoryLabels[entry.cwd.toLocaleLowerCase()] ?? entry.cwd}
                    </small>
                    {unavailable && (
                      <small className="conversation-history-missing" role="alert">
                        This transcript is no longer on disk, so it cannot be resumed.
                      </small>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>

        {!loading && entries.length === 0 && !error && (
          <p className="conversation-history-empty">No past conversations were recorded here yet.</p>
        )}
        {loading && <p className="conversation-history-empty">Reading transcripts…</p>}

        <div className="worktree-dialog-actions">
          {hasMore && (
            <button type="button" disabled={loading} onClick={() => void loadPage(entries.length)}>
              Load more
            </button>
          )}
          <button type="button" onClick={onCancel}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
