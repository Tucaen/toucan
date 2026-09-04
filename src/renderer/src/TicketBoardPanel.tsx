import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { FolderOpen, GripVertical, RefreshCw, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import type { TicketBoardPanelState } from '../../shared/terminal'
import type { TicketCard, TicketSource } from '../../shared/ticket-source'
import { ticketCardKey } from '../../shared/ticket-source'
import { markdownBlockComponents, remarkPlugins } from './MarkdownMessage'
import SessionKindIcon from './SessionKindIcon'
import type { TicketSessionChip } from './ticket-activity'
import { describeTicketDate, ticketBlockers, ticketStatusBeside, type TicketBoardColumn } from './ticket-board'
import { clampTicketBoardWidth, ticketBoardBounds, ticketBoardWidthFromPointer } from './ticket-board-layout'
import { useTicketBoard } from './use-ticket-board'

/**
 * The docked ticket board. It renders what `use-ticket-board.ts` and `ticket-board.ts` already
 * decided; what it genuinely owns is the board's interaction surface - which card is expanded,
 * which column a pointer is currently over, and where a drag ends. Like the brain-dump panel it
 * stays mounted once opened and merely hides, so reopening is the same board.
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

export default function TicketBoardPanel(props: TicketBoardPanelProps): JSX.Element {
  const { panel, projectPath, sources, today } = props
  const { open, width } = panel
  const headingId = useId()
  const board = useTicketBoard({ sources, projectPath, today })
  const [expanded, setExpanded] = useState<string | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  // Closed work is history, not the board: Done starts collapsed to a strip and the user opens it.
  const [doneExpanded, setDoneExpanded] = useState(false)
  const [resizing, setResizing] = useState(false)
  const columnRefs = useRef(new Map<string, HTMLElement>())
  const scrollRef = useRef<HTMLDivElement>(null)
  /** Restored whenever the board comes back: a hidden panel loses its scroll offset. */
  const scrollMemory = useRef(0)

  const bounds = ticketBoardBounds(props.workspaceWidth)
  const sourceLabels = useMemo(() => new Map(sources.map((source) => [source.id, source.label])), [sources])

  useEffect(() => {
    if (open && scrollRef.current) scrollRef.current.scrollLeft = scrollMemory.current
  }, [open, board.status])

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
    board.clearMoveError()
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
        </div>
        <div className="ticket-card-meta">
          <code>{card.id}</code>
          <span>{describeTicketDate(card.updated, today)}</span>
          {sources.length > 1 && <span className="ticket-card-source">{sourceLabels.get(card.sourceId)}</span>}
          <button
            type="button"
            className="ticket-card-reveal"
            title={`Show ${card.id} in the folder`}
            aria-label={`Show ${card.id} in the folder`}
            onClick={() => board.reveal(card)}
          >
            <FolderOpen aria-hidden="true" />
          </button>
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
    const isDone = column.status === 'done'
    // Collapsed, Done is still a full-height drop target - closing a ticket by dragging it there
    // is the whole point - it just does not spend board width on work that is finished.
    const collapsed = isDone && !doneExpanded
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
        if (event.key !== 'Escape' || drag) return
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

      {board.mutation.error && (
        <p className="ticket-board-state" role="alert">
          {board.mutation.error}
          <button type="button" onClick={board.clearMoveError}>
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

      {/* One polite region for everything the board announces, so nothing steals focus. */}
      <div className="ticket-board-visually-hidden" role="status" aria-live="polite">
        {board.announcement}
      </div>
    </aside>
  )
}
