import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TicketCard, TicketSource, TicketSourceListResult } from '../../shared/ticket-source'
import { ticketCardKey } from '../../shared/ticket-source'
import type { TicketDiagnostic } from '../../shared/tickets'
import { ticketBoardColumns, ticketDropAllowed, type TicketBoardColumn } from './ticket-board'

/**
 * The one owner of the board's async state: what each source last returned for the active project,
 * whether a status change is in flight, and what the polite live region should say. The panel
 * renders this interface and never calls a source itself.
 *
 * The rule the whole hook is built around: **disk is truth**. A dropped card is not moved in the
 * UI and reconciled later - the write is awaited, the sources are re-listed, and only then does
 * the board change. A column that moved is therefore a column that really moved.
 */

export type TicketBoardStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface TicketBoardMutation {
  /** The card key currently being written, so exactly one card can show as pending. */
  cardKey?: string
  error?: string
}

export interface TicketBoard {
  status: TicketBoardStatus
  columns: TicketBoardColumn[]
  cards: TicketCard[]
  diagnostics: TicketDiagnostic[]
  error?: string
  showAllDone: boolean
  setShowAllDone(showAll: boolean): void
  mutation: TicketBoardMutation
  /** Whether this card's source can write a status at all, which is what a column may accept. */
  canMove(card: TicketCard): boolean
  moveCard(card: TicketCard, status: string): Promise<boolean>
  clearMoveError(): void
  reveal(card: TicketCard): void
  refresh(): Promise<void>
  announcement: string
}

export interface TicketBoardOptions {
  sources: readonly TicketSource[]
  /** The active project. Without one there is no board to read, and no folder to watch. */
  projectPath?: string
  /** Today as `YYYY-MM-DD`, so the Done cutoff and relative dates stay testable. */
  today: string
}

const EMPTY: TicketSourceListResult = { cards: [], diagnostics: [] }

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The tickets could not be read.'
}

export function useTicketBoard(options: TicketBoardOptions): TicketBoard {
  const { projectPath, sources, today } = options
  const [status, setStatus] = useState<TicketBoardStatus>('idle')
  const [listings, setListings] = useState<TicketSourceListResult[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [showAllDone, setShowAllDone] = useState(false)
  const [mutation, setMutation] = useState<TicketBoardMutation>({})
  const [announcement, setAnnouncement] = useState('')
  /** Only the newest read may publish: a change event landing mid-read must not lose to it. */
  const reads = useRef(0)

  const read = useCallback(
    async (background: boolean): Promise<void> => {
      if (!projectPath) {
        setListings([])
        setStatus('idle')
        return
      }
      const generation = (reads.current += 1)
      if (!background) {
        setStatus('loading')
        setError(undefined)
      }
      try {
        const results = await Promise.all(sources.map((source) => source.list(projectPath).catch(() => EMPTY)))
        if (generation !== reads.current) return
        setListings(results)
        setStatus('ready')
        setError(undefined)
      } catch (cause) {
        if (generation !== reads.current) return
        setStatus('error')
        setError(errorText(cause))
      }
    },
    [projectPath, sources]
  )

  // Switching projects re-lists rather than filtering: a board is one project's tickets, and the
  // previous project's cards must never linger while the new folder is still being read.
  useEffect(() => {
    setListings([])
    setShowAllDone(false)
    setMutation({})
    void read(false)
  }, [read])

  // A ticket edited in an external editor has to reach the board without a restart, and without
  // the board flashing its loading state every time a file is touched.
  useEffect(() => {
    if (!projectPath) return
    const unsubscribes = sources.map((source) =>
      source.onChange?.((changed) => {
        if (changed === projectPath) void read(true)
      })
    )
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe?.()
    }
  }, [projectPath, read, sources])

  const cards = useMemo(() => listings.flatMap((listing) => listing.cards), [listings])
  const diagnostics = useMemo(() => listings.flatMap((listing) => listing.diagnostics), [listings])
  const columns = useMemo(() => ticketBoardColumns({ listings, today, showAllDone }), [listings, showAllDone, today])

  const canMove = useCallback((card: TicketCard) => ticketDropAllowed(card, sources), [sources])

  const moveCard = useCallback(
    async (card: TicketCard, next: string): Promise<boolean> => {
      const source = sources.find((candidate) => candidate.id === card.sourceId)
      if (!projectPath || !source?.setStatus || card.status === next) return false
      const key = ticketCardKey(card)
      setMutation({ cardKey: key })
      try {
        const result = await source.setStatus(projectPath, card.id, next)
        if (!result.ok) {
          setMutation({ error: result.message })
          return false
        }
        // The write succeeded; what the board shows still comes from a fresh read of the source.
        await read(true)
        setMutation({})
        setAnnouncement(`${card.title} moved to ${next}.`)
        return true
      } catch (cause) {
        setMutation({ error: errorText(cause) })
        return false
      }
    },
    [projectPath, read, sources]
  )

  const reveal = useCallback(
    (card: TicketCard): void => {
      if (!projectPath) return
      sources.find((candidate) => candidate.id === card.sourceId)?.openExternal?.(projectPath, card.id)
    },
    [projectPath, sources]
  )

  return {
    status,
    columns,
    cards,
    diagnostics,
    error,
    showAllDone,
    setShowAllDone,
    mutation,
    canMove,
    moveCard,
    clearMoveError: () => setMutation({}),
    reveal,
    refresh: () => read(false),
    announcement
  }
}
