import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ExternalLink, FolderOpen, GripVertical, MoreHorizontal, RefreshCw, Trash2, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import type { TicketBoardPanelState } from '../../shared/workspace'
import type { TicketCard, TicketSource } from '../../shared/ticket-source'
import type { TicketSkillApi } from '../../shared/ticket-skill'
import { ticketCardKey } from '../../shared/ticket-source'
import { TICKET_STATUS, ticketsDirectoryOrDefault } from '../../shared/tickets'
import { markdownBlockComponents, remarkPlugins } from './MarkdownMessage'
import { describeCalendarDate } from './relative-date'
import SessionKindIcon from './SessionKindIcon'
import TicketDeleteDialog from './TicketDeleteDialog'
import TicketFormatPrimer from './TicketFormatPrimer'
import TicketSkillSetup, { TicketSkillHeaderButton } from './TicketSkillSetup'
import type { TicketSessionChip } from './ticket-activity'
import { DONE_COLUMN_RECENT_DAYS, ticketBlockers, ticketStatusBeside, type TicketBoardColumn } from './ticket-board'
import {
  clampTicketBoardWidth,
  ticketBoardBounds,
  ticketBoardWidthFromPointer,
  withEnabledSource
} from './ticket-board-layout'
import {
  clampTicketDetailWidth,
  resolveTicketPanes,
  ticketDetailWidthFromPointer,
  ticketArrowStep,
  ticketIndexBeside,
  ticketPaneBeside,
  ticketPaneMode,
  visibleTicketPanes,
  type TicketPane,
  type TicketPaneSelection
} from './ticket-board-panes'
import { useMenuNavigation, useOutsidePointerClose } from './menu-keyboard'
import { useTicketBoard } from './use-ticket-board'
import { useTicketSkill } from './use-ticket-skill'

/**
 * The docked ticket board, as three panes: the states on the left, the selected state's tickets in
 * the middle, and the selected ticket's body on the right. It renders what `use-ticket-board.ts`,
 * `ticket-board.ts` and `ticket-board-panes.ts` already decided; what it genuinely owns is the
 * board's interaction surface - which card's menu is open, which state row a pointer is currently
 * over, where a drag ends, and where focus goes. Like the brain-dump panel it stays mounted once
 * opened and merely hides, so reopening is the same board - re-listed on reopen, because the files
 * may have moved on while it was hidden.
 *
 * A card never moves because the user dragged it. It moves because the source wrote the change and
 * the re-read came back with it under the new state; until then the card shows as pending.
 */

/** How far one arrow press moves either resize separator, for resizing without a pointer. */
const KEYBOARD_RESIZE_STEP = 24

export interface TicketBoardPanelProps {
  panel: TicketBoardPanelState
  workspaceWidth: number
  /** The active project's tickets are the board; without one there is nothing to render. */
  projectPath?: string
  projectName?: string
  /** The project's own tickets folder, unresolved; absent means the shipped default. */
  ticketsDirectory?: string
  sources: readonly TicketSource[]
  /** Scaffolding this project its own tickets skill; see `use-ticket-skill.ts`. */
  skillApi: TicketSkillApi
  /** Advanced when the project's tickets folder change has been persisted; see `useTicketBoard`. */
  revision?: number
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
  /** The state row the pointer is currently over, or the card's own while it is over nothing. */
  over: string
}

/** A confirmation in progress: the cards it names and what their sources said the loss costs. */
interface DeleteRequest {
  cards: readonly TicketCard[]
  notes: string[]
}

export default function TicketBoardPanel(props: TicketBoardPanelProps): JSX.Element {
  const { panel, projectPath, revision, sources, today } = props
  const { open, width } = panel
  const headingId = useId()
  /** The pane each state row controls; one id, because only one state is ever shown. */
  const ticketListId = `${headingId}-tickets`
  // An optional source is switched on per project, not per board: the answer to "show GitHub here"
  // belongs to the checkout, and following the user from project to project would be a surprise.
  const enabledSources = useMemo(
    () => (projectPath ? (panel.enabledSources?.[projectPath] ?? []) : []),
    [panel.enabledSources, projectPath]
  )
  const board = useTicketBoard({ sources, projectPath, today, enabledSources, revision })
  const skill = useTicketSkill({ api: props.skillApi, projectPath })
  const ticketsDirectory = ticketsDirectoryOrDefault(props.ticketsDirectory)
  /** What the board is pointed at. Resolved against every fresh listing, never trusted raw. */
  const [selection, setSelection] = useState<TicketPaneSelection>({ status: null, cardKey: null })
  /** The card whose actions menu is open; at most one, closed by any action or by Escape. */
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [resizing, setResizing] = useState<'panel' | 'detail' | null>(null)
  /** The confirmation currently open; deleting never happens without one. */
  const [deleting, setDeleting] = useState<DeleteRequest | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const stateRefs = useRef(new Map<string, HTMLElement>())
  const cardRefs = useRef(new Map<string, HTMLElement>())
  const panesRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLElement>(null)
  const detailRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** A pane to focus once the render that brings it back has happened. See `focusPaneAfterRender`. */
  const pendingFocus = useRef<TicketPane | null>(null)
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

  const resolved = useMemo(
    () => resolveTicketPanes({ columns: board.columns, cards: board.cards, selection }),
    [board.cards, board.columns, selection]
  )
  // Written back only when an open ticket says so: it is the ticket that moved, and the state it
  // moved to is where the user is now reading, so that state must survive the ticket later being
  // deleted or swept. A state the board merely *fell back to* is never committed - the very first
  // render happens before any source has answered, and committing that guess would pin the board
  // to the first status forever, whatever the listing turned out to hold.
  useEffect(() => {
    if (resolved.cardKey !== selection.cardKey || (resolved.cardKey && resolved.status !== selection.status))
      setSelection(resolved)
  }, [resolved, selection])

  const column = board.columns.find((entry) => entry.status === resolved.status)
  const openCard = resolved.cardKey ? board.cards.find((card) => ticketCardKey(card) === resolved.cardKey) : undefined
  const mode = ticketPaneMode(width)
  const visiblePanes = visibleTicketPanes(mode, Boolean(openCard))
  const detailWidth = clampTicketDetailWidth(panel.detailWidth, width)

  useEffect(() => {
    if (open && scrollRef.current) scrollRef.current.scrollTop = scrollMemory.current
  }, [open, board.status])

  // Reopening re-lists quietly: a source without a watcher (GitHub) has no other way to catch up
  // on what changed while the board was hidden, and the mount already read the first time.
  useEffect(() => {
    if (open && !wasOpen.current) void board.refresh({ quiet: true })
    wasOpen.current = open
    // The trigger is the open/closed transition, nothing about the board itself. `board` is rebuilt
    // on every render, so listing it would run this on every render and rely on the ref guard alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const toggleSource = (sourceId: string, on: boolean): void => {
    if (!projectPath) return
    props.onPanelChange({ enabledSources: withEnabledSource(panel.enabledSources, projectPath, sourceId, on) })
  }

  const closePanel = (): void => {
    scrollMemory.current = scrollRef.current?.scrollTop ?? scrollMemory.current
    props.onPanelChange({ open: false })
  }

  /** Choosing a state clears the open ticket, which is what lets the choice survive a re-read. */
  const selectState = (status: string): void => setSelection({ status, cardKey: null })
  const selectCard = (card: TicketCard): void => setSelection({ status: card.status, cardKey: ticketCardKey(card) })

  const registerState = useCallback((status: string, element: HTMLElement | null): void => {
    if (element) stateRefs.current.set(status, element)
    else stateRefs.current.delete(status)
  }, [])

  const focusPane = (pane: TicketPane | undefined): void => {
    if (!pane) return
    if (pane === 'states') {
      stateRefs.current.get(resolved.status ?? '')?.focus()
      return
    }
    if (pane === 'detail') {
      detailRef.current?.focus()
      return
    }
    const selected = resolved.cardKey ? cardRefs.current.get(resolved.cardKey) : undefined
    const first = listRef.current?.querySelector<HTMLElement>('.ticket-card-title')
    ;(selected ?? first ?? listRef.current)?.focus()
  }

  /**
   * Focus a pane that the same interaction is about to bring back. On a narrow board the way out
   * of the detail is also what re-mounts the list, so focusing it before React has rendered would
   * aim at an element that does not exist yet and drop focus on the body.
   */
  const focusPaneAfterRender = (pane: TicketPane): void => {
    pendingFocus.current = pane
  }
  useEffect(() => {
    const pane = pendingFocus.current
    if (!pane) return
    pendingFocus.current = null
    focusPane(pane)
  })

  /** Closing the detail is one decision, whether it came from the back button or from Left. */
  const closeDetail = (): void => {
    setSelection({ status: resolved.status, cardKey: null })
    focusPaneAfterRender('list')
  }

  /**
   * The pointer choreography both separators share: capture, mark the board as resizing so the
   * width stops animating, report every move, and let go on release. Only what a drag *means* -
   * which width it is setting - differs between them.
   */
  const startWidthDrag = (event: React.PointerEvent, what: 'panel' | 'detail', report: (pointerX: number) => void) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizing(what)
    const move = (pointer: PointerEvent): void => report(pointer.clientX)
    const release = (): void => {
      setResizing(null)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', release)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', release)
  }

  /** The state row under the pointer, by measurement: the list scrolls, so index maths would lie. */
  const stateAt = (clientX: number, clientY: number): string | null => {
    for (const [status, element] of stateRefs.current) {
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
      over = stateAt(pointer.clientX, pointer.clientY) ?? card.status
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

  /** The same move without a pointer: the grip answers Left/Right with the neighbouring state. */
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

  const renderCardMenu = (card: TicketCard, key: string): JSX.Element => (
    <TicketCardMenu
      card={card}
      menuId={`${headingId}-menu-${key}`}
      open={menuFor === key}
      canRemove={board.canRemove(card)}
      setOpen={(open) => setMenuFor(open ? key : null)}
      onReveal={() => board.reveal(card)}
      onDelete={() => void askToDelete([card])}
    />
  )

  /** Id, age and source badge, shared by the compact card and the detail's own head. */
  const renderMeta = (card: TicketCard): JSX.Element => (
    <div className="ticket-card-meta">
      <code>{card.id}</code>
      {/* No date at all rather than a guessed one: a file that never wrote one has nothing to show. */}
      {card.updated && <span>{describeCalendarDate(card.updated, today)}</span>}
      {showSourceBadges && <span className="ticket-card-source">{sourceLabels.get(card.sourceId)}</span>}
    </div>
  )

  const renderSessionChip = (session: TicketSessionChip): JSX.Element => (
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
  )

  const renderBlockers = (card: TicketCard): JSX.Element | null => {
    const blockers = ticketBlockers(card, board.cards)
    if (blockers.length === 0) return null
    return (
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
    )
  }

  const renderCard = (card: TicketCard): JSX.Element => {
    const key = ticketCardKey(card)
    const selected = resolved.cardKey === key
    const movable = board.canMove(card)
    const session = props.sessions?.get(key)
    return (
      <article
        key={key}
        className="ticket-card"
        data-selected={selected ? 'true' : undefined}
        data-pending={board.mutation.cardKey === key ? 'true' : undefined}
        data-dragging={drag && ticketCardKey(drag.card) === key ? 'true' : undefined}
      >
        <div className="ticket-card-head">
          {movable && (
            <button
              type="button"
              className="ticket-card-grip"
              title={`Move ${card.title} to another state`}
              aria-label={`Move ${card.title} to another state`}
              onPointerDown={(event) => startDrag(card, event)}
              onKeyDown={(event) => {
                const step = ticketArrowStep(event.key)
                if (step?.axis !== 'horizontal') return
                event.preventDefault()
                // The list's own Left/Right moves focus between panes; from the grip they move
                // the ticket, so the press must not be read twice.
                event.stopPropagation()
                moveByKeyboard(card, step.delta)
              }}
            >
              <GripVertical aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="ticket-card-title"
            aria-current={selected ? 'true' : undefined}
            ref={(element) => {
              if (element) cardRefs.current.set(key, element)
              else cardRefs.current.delete(key)
            }}
            onClick={() => selectCard(card)}
          >
            {card.title}
          </button>
          {renderCardMenu(card, key)}
        </div>
        {renderMeta(card)}
        {session && renderSessionChip(session)}
        {renderBlockers(card)}
      </article>
    )
  }

  const renderStates = (): JSX.Element => (
    <div
      className="ticket-state-list"
      role="tablist"
      aria-orientation="vertical"
      aria-label="Ticket states"
      onKeyDown={(event) => {
        const step = ticketArrowStep(event.key)
        if (!step) return
        event.preventDefault()
        if (step.axis === 'horizontal') {
          focusPane(ticketPaneBeside(visiblePanes, 'states', step.delta))
          return
        }
        const index = board.columns.findIndex((entry) => entry.status === resolved.status)
        const next = board.columns[ticketIndexBeside(board.columns.length, index, step.delta)]
        if (!next) return
        selectState(next.status)
        stateRefs.current.get(next.status)?.focus()
      }}
    >
      {board.columns.map((entry) => {
        const selected = entry.status === resolved.status
        const count = entry.cards.length + entry.hidden
        return (
          <button
            key={entry.status}
            type="button"
            role="tab"
            className="ticket-state-row"
            data-status={entry.status}
            data-over={drag?.over === entry.status ? 'true' : undefined}
            aria-selected={selected}
            aria-controls={ticketListId}
            aria-label={`${entry.label}, ${count === 1 ? '1 ticket' : `${count} tickets`}`}
            tabIndex={selected ? 0 : -1}
            ref={(element) => registerState(entry.status, element)}
            onClick={() => selectState(entry.status)}
          >
            <span className="ticket-state-label">{entry.label}</span>
            <span className="ticket-state-count">{count}</span>
          </button>
        )
      })}
    </div>
  )

  const renderList = (selectedColumn: TicketBoardColumn): JSX.Element => {
    const isDone = selectedColumn.status === TICKET_STATUS.done
    // Offered on the Done list, which is the state it exists for: a folder of hundreds of closed
    // tickets costs every listing and every agent that reads it, and the cards it would remove are
    // precisely the ones the cutoff has already stopped showing.
    const sweepable = isDone ? board.sweepableDone : []
    return (
      <section
        className="ticket-list-pane"
        id={ticketListId}
        role="tabpanel"
        aria-label={`${selectedColumn.label} tickets`}
        ref={listRef}
        tabIndex={-1}
        onKeyDown={(event) => {
          // A card's open menu owns its own arrows; so does a card's grip, which moves the ticket.
          if ((event.target as HTMLElement).closest('.ticket-card-menu-list')) return
          const step = ticketArrowStep(event.key)
          if (!step) return
          event.preventDefault()
          if (step.axis === 'horizontal') {
            focusPane(ticketPaneBeside(visiblePanes, 'list', step.delta))
            return
          }
          const index = selectedColumn.cards.findIndex((card) => ticketCardKey(card) === resolved.cardKey)
          const next = selectedColumn.cards[ticketIndexBeside(selectedColumn.cards.length, index, step.delta)]
          if (!next) return
          selectCard(next)
          cardRefs.current.get(ticketCardKey(next))?.focus()
        }}
      >
        <header className="ticket-list-header">
          <h3>{selectedColumn.label}</h3>
          <span className="ticket-list-count">{selectedColumn.cards.length + selectedColumn.hidden}</span>
          {sweepable.length > 0 && (
            <button
              type="button"
              className="ticket-list-sweep"
              title={`Delete done tickets older than ${DONE_COLUMN_RECENT_DAYS} days`}
              aria-label={`Delete done tickets older than ${DONE_COLUMN_RECENT_DAYS} days`}
              onClick={() => void askToDelete(sweepable)}
            >
              <Trash2 aria-hidden="true" />
            </button>
          )}
        </header>
        <div className="ticket-list-cards" ref={scrollRef}>
          {/* An empty column on a board that has tickets is just empty; a board with no tickets at
              all is a board nobody has been told how to fill, so that one teaches the format. */}
          {selectedColumn.cards.length === 0 &&
            (board.isEmpty ? (
              <>
                <TicketFormatPrimer ticketsDirectory={ticketsDirectory} today={today} />
                <TicketSkillSetup skill={skill} />
              </>
            ) : (
              <p className="ticket-board-state">No tickets in {selectedColumn.label}.</p>
            ))}
          {selectedColumn.cards.map(renderCard)}
        </div>
        {/* Closed work is history, not news: Done lists the recent ones and offers the rest. */}
        {isDone && (selectedColumn.hidden > 0 || board.showAllDone) && (
          <button type="button" className="ticket-list-more" onClick={() => board.setShowAllDone(!board.showAllDone)}>
            {board.showAllDone ? 'Show recent only' : `Show all (${selectedColumn.hidden} older)`}
          </button>
        )}
      </section>
    )
  }

  const renderDetail = (card: TicketCard): JSX.Element => (
    <section
      className="ticket-detail-pane"
      aria-label="Ticket detail"
      ref={detailRef}
      tabIndex={0}
      style={mode === 'three' ? { width: detailWidth, minWidth: detailWidth } : undefined}
      onKeyDown={(event) => {
        // Only the pane itself: inside the body the arrows belong to whatever is being read.
        if (event.target !== event.currentTarget || event.key !== 'ArrowLeft') return
        event.preventDefault()
        // Where the list is still on screen, Left is only a move; where it is not, it is the exit.
        if (mode === 'two') closeDetail()
        else focusPane('list')
      }}
    >
      <header className="ticket-detail-head">
        {/* A narrow board showed the detail *instead of* the list, so it owes the way back. */}
        {mode === 'two' && (
          <button type="button" className="ticket-detail-back" onClick={closeDetail}>
            <ArrowLeft aria-hidden="true" />
            <span>{`Back to ${column?.label ?? 'the tickets'}`}</span>
          </button>
        )}
        <h3>{card.title}</h3>
        {renderMeta(card)}
        {renderBlockers(card)}
      </header>
      <div className="ticket-detail-body">
        {card.body?.trim() ? (
          <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownBlockComponents}>
            {card.body}
          </ReactMarkdown>
        ) : (
          <p className="ticket-board-state">This ticket has no body yet.</p>
        )}
      </div>
    </section>
  )

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
          const step = ticketArrowStep(event.key)
          if (step?.axis !== 'horizontal') return
          event.preventDefault()
          // Both boards grow leftwards, so Left widens: the separator sits on the pane's left edge.
          props.onPanelChange({
            width: clampTicketBoardWidth(width - step.delta * KEYBOARD_RESIZE_STEP, props.workspaceWidth)
          })
        }}
        onPointerDown={(event) => {
          const panelRight = event.currentTarget.parentElement?.getBoundingClientRect().right ?? 0
          startWidthDrag(event, 'panel', (pointerX) =>
            props.onPanelChange({ width: ticketBoardWidthFromPointer(pointerX, panelRight, props.workspaceWidth) })
          )
        }}
      />

      <header className="ticket-board-header">
        <div className="ticket-board-identity">
          <span className="ticket-board-eyebrow">{props.projectName ?? 'No project'}</span>
          <h2 id={headingId}>Tickets</h2>
        </div>
        <div className="ticket-board-controls">
          {/* Offered here only while the project has no skill of its own, so a board that already
              has tickets is still a place the project can be given one. */}
          {projectPath && <TicketSkillHeaderButton skill={skill} />}
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
        <div className="ticket-board-panes" data-mode={mode} ref={panesRef}>
          {renderStates()}
          {column && visiblePanes.includes('list') && renderList(column)}
          {openCard && visiblePanes.includes('detail') && mode === 'three' && (
            <div
              className="ticket-detail-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the ticket detail"
              aria-valuenow={detailWidth}
              tabIndex={0}
              onKeyDown={(event) => {
                const step = ticketArrowStep(event.key)
                if (step?.axis !== 'horizontal') return
                event.preventDefault()
                props.onPanelChange({
                  detailWidth: clampTicketDetailWidth(detailWidth - step.delta * KEYBOARD_RESIZE_STEP, width)
                })
              }}
              onPointerDown={(event) => {
                const panesRight = panesRef.current?.getBoundingClientRect().right ?? 0
                startWidthDrag(event, 'detail', (pointerX) =>
                  props.onPanelChange({ detailWidth: ticketDetailWidthFromPointer(pointerX, panesRight, width) })
                )
              }}
            />
          )}
          {openCard && visiblePanes.includes('detail') && renderDetail(openCard)}
        </div>
      )}

      {board.diagnostics.length > 0 && (
        <div className="ticket-board-diagnostics" role="status">
          <strong>{board.diagnostics.length} file(s) could not be shown as a ticket</strong>
          <ul>
            {board.diagnostics.map((diagnostic) => (
              <li key={diagnostic.path}>
                <code>{diagnostic.path}</code> — {diagnostic.message}
              </li>
            ))}
          </ul>
          {/* The parse error says what is wrong with the file; only the primer says what a right
              one is, so the contract is learnable from the error rather than only from an empty
              board. Closed by default: a reader who already knows the shape wants the paths. A
              folder holding nothing but broken files is the one case where the primer is already
              open in the list pane, so there it points rather than repeating itself. */}
          {board.isEmpty ? (
            <p className="ticket-format-pointer">What the board makes of a ticket file is explained above.</p>
          ) : (
            <details className="ticket-format-disclosure">
              <summary>What a ticket file looks like</summary>
              <TicketFormatPrimer ticketsDirectory={ticketsDirectory} today={today} />
            </details>
          )}
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

/**
 * A card's "…" menu, with the shared menu keyboard model: focus moves onto the first item when it
 * opens, arrows rove, Escape and any outside pointer close it, and closing puts focus back on the
 * trigger - which is also what lets the delete confirmation restore focus somewhere real instead
 * of dropping it on `<body>` (#231).
 */
function TicketCardMenu(props: {
  card: TicketCard
  menuId: string
  open: boolean
  canRemove: boolean
  setOpen(open: boolean): void
  onReveal(): void
  onDelete(): void
}): JSX.Element {
  const { card, open, setOpen } = props
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const close = useCallback((): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [setOpen])

  const navigation = useMenuNavigation(menuRef, open, { focusOnOpen: true, onClose: close })
  useOutsidePointerClose([triggerRef, menuRef], open, close)

  // A card that names somewhere on the web is opened there; one that does not is a file, and
  // the only place to open a file is the folder it lives in.
  const revealLabel = card.url ? `Open ${card.id} in the browser` : `Show ${card.id} in the folder`
  return (
    <div className="ticket-card-menu">
      <button
        ref={triggerRef}
        type="button"
        className="ticket-card-menu-button"
        title={`Actions for ${card.id}`}
        aria-label={`Actions for ${card.id}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? props.menuId : undefined}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal aria-hidden="true" />
      </button>
      {open && (
        <div
          id={props.menuId}
          ref={menuRef}
          className="ticket-card-menu-list"
          role="menu"
          aria-label={`Actions for ${card.id}`}
          onKeyDown={navigation.onKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close()
              props.onReveal()
            }}
          >
            {card.url ? <ExternalLink aria-hidden="true" /> : <FolderOpen aria-hidden="true" />}
            <span>{revealLabel}</span>
          </button>
          {/* Offered for any status, not just Done: a ticket that turned out to be the wrong idea
              is deleted where it stands. The confirmation is what makes an errant click harmless. */}
          {props.canRemove && (
            <button
              type="button"
              role="menuitem"
              className="ticket-card-menu-delete"
              onClick={() => {
                close()
                props.onDelete()
              }}
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
