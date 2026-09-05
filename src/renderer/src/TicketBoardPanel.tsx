import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ExternalLink, FolderOpen, GripVertical, MoreHorizontal, RefreshCw, Trash2, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import type { TicketBoardPanelState } from '../../shared/terminal'
import type { TicketCard, TicketSource } from '../../shared/ticket-source'
import { ticketCardKey } from '../../shared/ticket-source'
import { TICKET_STATUS } from '../../shared/tickets'
import { markdownBlockComponents, remarkPlugins } from './MarkdownMessage'
import SessionKindIcon from './SessionKindIcon'
import TicketDeleteDialog from './TicketDeleteDialog'
import type { TicketSessionChip } from './ticket-activity'
import {
  DONE_COLUMN_RECENT_DAYS,
  describeTicketDate,
  ticketBlockers,
  ticketStatusBeside,
  type TicketBoardColumn
} from './ticket-board'
import {
  clampTicketBoardWidth,
  ticketBoardBounds,
  ticketBoardWidthFromPointer,
  withEnabledSource
} from './ticket-board-layout'
import { useTicketBoard } from './use-ticket-board'

/**
 * The docked ticket board. It renders what `use-ticket-board.ts` and `ticket-board.ts` already
 * decided; what it genuinely owns is the board's interaction surface - which card is expanded,
 * which card's menu is open, which column a pointer is currently over, and where a drag ends. Like
 * the brain-dump panel it stays mounted once opened and merely hides, so reopening is the same
 * board - re-listed on reopen, because the files may have moved on while it was hidden.
 *
 * A card never moves because the user dragged it. It moves because the source wrote the change and
 * the re-read came back with it in the new column; until then the card shows as pending.
 */

/** How far one arrow press moves the resize separator, for resizing without a pointer. */
const KEYBOARD_RESIZE_STEP = 24

export interface TicketBoardPanelProps {
  panel: TicketBoardPanelState
  workspaceWidth: number
  /** The active project's tickets are the board; without one there is nothing to render. */
  projectPath?: string
  projectName?: string
  sources: readonly TicketSource[]
  /** Today as `YYYY-MM-DD`, so relative dates and the Done cutoff stay testable. */
  today: string
  /**
   * Which session is on which card, keyed by `ticketCardKey` (see `ticket-activity.ts`). Evidence,
   * not a guess: a card only gets a chip because a chat actually wrote its file, which is why a
   * ticket left in `in-progress` by a session that moved on shows nothing extra.
   */
  sessions?: ReadonlyMap<string, TicketSessionChip>
  /** Focuses and fits that session's node on the canvas; the workspace owns how. */
  onFocusSession?(nodeId: string): void
  onPanelChange(patch: Partial<TicketBoardPanelState>): void
}

interface DragState {
  card: TicketCard
  /** The column the pointer is currently over, or the card's own while it is over nothing. */
  over: string
}

/** A confirmation in progress: the cards it names and what their sources said the loss costs. */
interface DeleteRequest {
  cards: readonly TicketCard[]
  notes: string[]
}

export default function TicketBoardPanel(props: TicketBoardPanelProps): JSX.Element {
  const { panel, projectPath, sources, today } = props
  const { open, width } = panel
  const headingId = useId()
  // An optional source is switched on per project, not per board: the answer to "show GitHub here"
  // belongs to the checkout, and following the user from project to project would be a surprise.
  const enabledSources = useMemo(
    () => (projectPath ? (panel.enabledSources?.[projectPath] ?? []) : []),
    [panel.enabledSources, projectPath]
  )
  const board = useTicketBoard({ sources, projectPath, today, enabledSources })
  const [expanded, setExpanded] = useState<string | null>(null)
  /** The card whose actions menu is open; at most one, closed by any action or by Escape. */
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  // Closed work is history, not the board: Done starts collapsed to a strip and the user opens it.
  const [doneExpanded, setDoneExpanded] = useState(false)
  const [resizing, setResizing] = useState(false)
  /** The confirmation currently open; deleting never happens without one. */
  const [deleting, setDeleting] = useState<DeleteRequest | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const columnRefs = useRef(new Map<string, HTMLElement>())
  const scrollRef = useRef<HTMLDivElement>(null)
  /** Restored whenever the board comes back: a hidden panel loses its scroll offset. */
  const scrollMemory = useRef(0)
  const wasOpen = useRef(open)

  const bounds = ticketBoardBounds(props.workspaceWidth)
  const sourceLabels = useMemo(() => new Map(sources.map((source) => [source.id, source.label])), [sources])
  // The badge earns its width only when two sources are actually feeding the board.
  const showSourceBadges = board.sources.filter((source) => source.enabled).length > 1
  const optionalSources = board.sources.filter(
    (source) => source.optional && (source.availability?.available === true || source.enabled)
  )

  useEffect(() => {
    if (open && scrollRef.current) scrollRef.current.scrollLeft = scrollMemory.current
  }, [open, board.status])

  // Reopening re-lists quietly: a source without a watcher (GitHub) has no other way to catch up
  // on what changed while the board was hidden, and the mount already read the first time.
  useEffect(() => {
    if (open && !wasOpen.current) void board.refresh({ quiet: true })
    wasOpen.current = open
  }, [open])

  const toggleSource = (sourceId: string, on: boolean): void => {
    if (!projectPath) return
    props.onPanelChange({ enabledSources: withEnabledSource(panel.enabledSources, projectPath, sourceId, on) })
  }

  const closePanel = (): void => {
    scrollMemory.current = scrollRef.current?.scrollLeft ?? scrollMemory.current
    props.onPanelChange({ open: false })
  }

  const registerColumn = useCallback((status: string, element: HTMLElement | null): void => {
    if (element) columnRefs.current.set(status, element)
    else columnRefs.current.delete(status)
  }, [])

  /** The column under the pointer, by measurement: the board scrolls, so index maths would lie. */
  const columnAt = (clientX: number, clientY: number): string | null => {
    for (const [status, element] of columnRefs.current) {
      const rect = element.getBoundingClientRect()
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) return status
    }
    return null
  }

  const startDrag = (card: TicketCard, event: React.PointerEvent): void => {
    if (!board.canMove(card)) return
    event.preventDefault()
    board.clearActionError()
    setMenuFor(null)
    let over = card.status
    setDrag({ card, over })
    const move = (pointer: PointerEvent): void => {
      over = columnAt(pointer.clientX, pointer.clientY) ?? card.status
      setDrag({ card, over })
    }
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('keydown', cancel)
      setDrag(null)
      if (commit && over !== card.status) void board.moveCard(card, over)
    }
    const release = (): void => finish(true)
    const cancel = (keyboard: KeyboardEvent): void => {
      if (keyboard.key === 'Escape') finish(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', release)
    window.addEventListener('keydown', cancel)
  }

  /** The same move without a pointer: the grip answers Left/Right with the neighbouring column. */
  const moveByKeyboard = (card: TicketCard, delta: number): void => {
    const next = ticketStatusBeside(board.columns, card.status, delta)
    if (next) void board.moveCard(card, next)
  }

  /**
   * The confirmation opens with the sources' words already in it: what a deletion costs is asked
   * first, so the dialog never has to guess while a probe is still out.
   */
  const askToDelete = async (cards: readonly TicketCard[]): Promise<void> => {
    if (cards.length === 0) return
    board.clearActionError()
    setMenuFor(null)
    const notes = await board.removalNotes(cards)
    setDeleting({ cards, notes })
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return
    setDeletePending(true)
    const done = await board.removeCards(deleting.cards)
    setDeletePending(false)
    // A failure keeps the dialog open on Retry; the board underneath has already been re-read.
    if (done) setDeleting(null)
  }

  const renderCardMenu = (card: TicketCard, key: string): JSX.Element => {
    const menuOpen = menuFor === key
    const menuId = `${headingId}-menu-${key}`
    // A card that names somewhere on the web is opened there; one that does not is a file, and
    // the only place to open a file is the folder it lives in.
    const revealLabel = card.url ? `Open ${card.id} in the browser` : `Show ${card.id} in the folder`
    return (
      <div className="ticket-card-menu">
        <button
          type="button"
          className="ticket-card-menu-button"
          title={`Actions for ${card.id}`}
          aria-label={`Actions for ${card.id}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          onClick={() => setMenuFor(menuOpen ? null : key)}
        >
          <MoreHorizontal aria-hidden="true" />
        </button>
        {menuOpen && (
          <div
            id={menuId}
            className="ticket-card-menu-list"
            role="menu"
            aria-label={`Actions for ${card.id}`}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.stopPropagation()
              setMenuFor(null)
            }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuFor(null)
                board.reveal(card)
              }}
            >
              {card.url ? <ExternalLink aria-hidden="true" /> : <FolderOpen aria-hidden="true" />}
              <span>{revealLabel}</span>
            </button>
            {/* Offered for any status, not just Done: a ticket that turned out to be the wrong idea
                is deleted where it stands. The confirmation is what makes an errant click harmless. */}
            {board.canRemove(card) && (
              <button
                type="button"
                role="menuitem"
                className="ticket-card-menu-delete"
                onClick={() => void askToDelete([card])}
              >
                <Trash2 aria-hidden="true" />
                <span>{`Delete ${card.id}`}</span>
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  const renderCard = (card: TicketCard): JSX.Element => {
    const key = ticketCardKey(card)
    const blockers = ticketBlockers(card, board.cards)
    const isExpanded = expanded === key
    const movable = board.canMove(card)
    const session = props.sessions?.get(key)
    return (
      <article
        key={key}
        className="ticket-card"
        data-pending={board.mutation.cardKey === key ? 'true' : undefined}
        data-dragging={drag && ticketCardKey(drag.card) === key ? 'true' : undefined}
      >
        <div className="ticket-card-head">
          {movable && (
            <button
              type="button"
              className="ticket-card-grip"
              title={`Move ${card.title} to another column`}
              aria-label={`Move ${card.title} to another column`}
              onPointerDown={(event) => startDrag(card, event)}
              onKeyDown={(event) => {
                const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
                if (!delta) return
                event.preventDefault()
                moveByKeyboard(card, delta)
              }}
            >
              <GripVertical aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="ticket-card-title"
            aria-expanded={isExpanded}
            onClick={() => setExpanded(isExpanded ? null : key)}
          >
            {card.title}
          </button>
          {renderCardMenu(card, key)}
        </div>
        <div className="ticket-card-meta">
          <code>{card.id}</code>
          <span>{describeTicketDate(card.updated, today)}</span>
          {showSourceBadges && <span className="ticket-card-source">{sourceLabels.get(card.sourceId)}</span>}
        </div>
        {session && (
          <button
            type="button"
            className="ticket-session-chip"
            data-working={session.working ? 'true' : undefined}
            title={
              session.working
                ? `${session.label} is working on this ticket - click to focus it`
                : `${session.label} worked on this ticket - click to focus it`
            }
            onClick={() => props.onFocusSession?.(session.nodeId)}
          >
            <SessionKindIcon kind={session.kind} />
            <span>{session.label}</span>
          </button>
        )}
        {blockers.length > 0 && (
          <ul className="ticket-blockers">
            {blockers.map((blocker) => (
              <li
                key={blocker.id}
                data-state={blocker.state}
                title={
                  blocker.state === 'done'
                    ? `${blocker.id} is done`
                    : blocker.state === 'missing'
                      ? `${blocker.id} is not a ticket in this folder`
                      : `Blocked by ${blocker.id}`
                }
              >
                {blocker.id}
              </li>
            ))}
          </ul>
        )}
        {isExpanded && (
          <div className="ticket-card-body">
            {card.body?.trim() ? (
              <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownBlockComponents}>
                {card.body}
              </ReactMarkdown>
            ) : (
              <p className="ticket-board-state">This ticket has no body yet.</p>
            )}
          </div>
        )}
      </article>
    )
  }

  const renderColumn = (column: TicketBoardColumn): JSX.Element => {
    const isDone = column.status === TICKET_STATUS.done
    // Collapsed, Done is still a full-height drop target - closing a ticket by dragging it there
    // is the whole point - it just does not spend board width on work that is finished.
    const collapsed = isDone && !doneExpanded
    // Offered on the collapsed column too, which is the state it exists for: a folder of hundreds
    // of closed tickets costs every listing and every agent that reads it, and the cards it would
    // remove are precisely the ones a collapsed Done has already stopped showing.
    const sweepable = isDone ? board.sweepableDone : []
    return (
      <section
        key={column.status}
        className="ticket-column"
        data-status={column.status}
        data-collapsed={collapsed ? 'true' : undefined}
        data-over={drag?.over === column.status ? 'true' : undefined}
        aria-label={`${column.label}, ${column.cards.length} ticket(s)`}
        ref={(element) => registerColumn(column.status, element)}
      >
        <header className="ticket-column-header">
          {isDone ? (
            <button
              type="button"
              className="ticket-column-toggle"
              aria-expanded={doneExpanded}
              title={doneExpanded ? 'Collapse the Done column' : 'Expand the Done column'}
              onClick={() => setDoneExpanded((current) => !current)}
            >
              <h3>{column.label}</h3>
            </button>
          ) : (
            <h3>{column.label}</h3>
          )}
          <span className="ticket-column-count">{column.cards.length + column.hidden}</span>
          {sweepable.length > 0 && (
            <button
              type="button"
              className="ticket-column-sweep"
              title={`Delete done tickets older than ${DONE_COLUMN_RECENT_DAYS} days`}
              aria-label={`Delete done tickets older than ${DONE_COLUMN_RECENT_DAYS} days`}
              onClick={() => void askToDelete(sweepable)}
            >
              <Trash2 aria-hidden="true" />
            </button>
          )}
        </header>
        {!collapsed && (
          <>
            <div className="ticket-column-cards">{column.cards.map(renderCard)}</div>
            {isDone && (column.hidden > 0 || board.showAllDone) && (
              <button
                type="button"
                className="ticket-column-more"
                onClick={() => board.setShowAllDone(!board.showAllDone)}
              >
                {board.showAllDone ? 'Show recent only' : `Show all (${column.hidden} older)`}
              </button>
            )}
          </>
        )}
      </section>
    )
  }

  return (
    <aside
      className="ticket-board-panel"
      hidden={!open}
      data-resizing={resizing ? 'true' : undefined}
      style={{ width, minWidth: width }}
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        // A confirmation's own Escape closes the confirmation; it must not also close the board.
        if (event.key !== 'Escape' || drag || deleting) return
        if (menuFor) {
          setMenuFor(null)
          event.stopPropagation()
          return
        }
        closePanel()
        event.stopPropagation()
      }}
    >
      <div
        className="ticket-board-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the ticket board"
        aria-valuenow={width}
        aria-valuemin={bounds.min}
        aria-valuemax={bounds.max}
        tabIndex={0}
        onKeyDown={(event) => {
          const delta =
            event.key === 'ArrowLeft' ? KEYBOARD_RESIZE_STEP : event.key === 'ArrowRight' ? -KEYBOARD_RESIZE_STEP : 0
          if (!delta) return
          event.preventDefault()
          props.onPanelChange({ width: clampTicketBoardWidth(width + delta, props.workspaceWidth) })
        }}
        onPointerDown={(event) => {
          const panelRight = event.currentTarget.parentElement?.getBoundingClientRect().right ?? 0
          event.currentTarget.setPointerCapture(event.pointerId)
          setResizing(true)
          const move = (pointer: PointerEvent): void => {
            props.onPanelChange({
              width: ticketBoardWidthFromPointer(pointer.clientX, panelRight, props.workspaceWidth)
            })
          }
          const release = (): void => {
            setResizing(false)
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', release)
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', release)
        }}
      />

      <header className="ticket-board-header">
        <div className="ticket-board-identity">
          <span className="ticket-board-eyebrow">{props.projectName ?? 'No project'}</span>
          <h2 id={headingId}>Tickets</h2>
        </div>
        <div className="ticket-board-controls">
          {/* A project that had no tickets folder when the board opened is not being watched -
              Toucan will not create the folder to watch it - so this is how its first ticket
              arrives without a restart. */}
          <button
            type="button"
            className="ticket-board-button"
            aria-label="Re-read the tickets from disk"
            title="Re-read the tickets from disk"
            onClick={() => void board.refresh()}
          >
            <RefreshCw aria-hidden="true" />
          </button>
          <button type="button" className="ticket-board-close" aria-label="Close the ticket board" onClick={closePanel}>
            <X aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* Only sources the user has a choice about, and only once the probe has an answer: a
          toggle that appears and vanishes while a project loads is worse than one that waits. */}
      {projectPath && optionalSources.length > 0 && (
        <div className="ticket-board-sources" role="group" aria-label="Ticket sources">
          {optionalSources.map((source) => {
            const probed = source.availability
            const detail = probed?.available ? probed.detail : undefined
            return (
              <button
                key={source.id}
                type="button"
                className="ticket-board-source-toggle"
                aria-pressed={source.enabled}
                disabled={probed?.available !== true && !source.enabled}
                title={
                  probed?.available === false
                    ? probed.reason
                    : `${source.enabled ? 'Hide' : 'Show'} ${detail ?? source.label} tickets`
                }
                onClick={() => toggleSource(source.id, !source.enabled)}
              >
                {source.label}
              </button>
            )
          })}
        </div>
      )}

      {/* While a confirmation is open it owns the failure, so the banner does not say it twice. */}
      {board.mutation.error && !deleting && (
        <p className="ticket-board-state" role="alert">
          {board.mutation.error}
          <button type="button" onClick={board.clearActionError}>
            Dismiss
          </button>
        </p>
      )}

      {!projectPath && <p className="ticket-board-state">Select a project to see its tickets.</p>}
      {projectPath && board.status === 'loading' && <p className="ticket-board-state">Reading the tickets…</p>}
      {projectPath && board.status === 'error' && (
        <p className="ticket-board-state" role="alert">
          {board.error}
          <button type="button" onClick={() => void board.refresh()}>
            Try again
          </button>
        </p>
      )}

      {projectPath && board.status === 'ready' && (
        <div className="ticket-board-columns" ref={scrollRef}>
          {board.columns.map(renderColumn)}
        </div>
      )}

      {board.diagnostics.length > 0 && (
        <div className="ticket-board-diagnostics" role="status">
          <strong>{board.diagnostics.length} ticket file(s) could not be read</strong>
          <ul>
            {board.diagnostics.map((diagnostic) => (
              <li key={diagnostic.path}>
                <code>{diagnostic.path}</code> — {diagnostic.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {deleting && (
        <TicketDeleteDialog
          cards={deleting.cards}
          notes={deleting.notes}
          pending={deletePending}
          error={board.mutation.error}
          onConfirm={() => void confirmDelete()}
          onCancel={() => {
            setDeleting(null)
            board.clearActionError()
          }}
        />
      )}

      {/* One polite region for everything the board announces, so nothing steals focus. */}
      <div className="visually-hidden" role="status" aria-live="polite">
        {board.announcement}
      </div>
    </aside>
  )
}
