import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  TicketCard,
  TicketSource,
  TicketSourceAvailability,
  TicketSourceListResult
} from '../../shared/ticket-source'
import { ticketCardKey } from '../../shared/ticket-source'
import type { TicketDiagnostic } from '../../shared/tickets'
import {
  staleDoneCards,
  ticketBoardColumns,
  ticketDropAllowed,
  ticketRemoveAllowed,
  type TicketBoardColumn
} from './ticket-board'

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

/** One source as the board's controls see it: whether it may be offered, and whether it is on. */
export interface TicketSourceState {
  id: string
  label: string
  /** True for a source the user chooses per project; false for one that is simply always there. */
  optional: boolean
  enabled: boolean
  /** Undefined while the probe is still out, so the board can wait rather than say "unavailable". */
  available?: boolean
  /** Why it is unavailable, in the source's own words. */
  reason?: string
  /** What it found - the GitHub repository, say - so a toggle can name what it would show. */
  detail?: string
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
  /** Whether this card's source is one Toucan may delete from at all; GitHub issues are not. */
  canRemove(card: TicketCard): boolean
  /**
   * Deletes every card given, then re-reads once. One call per card because that is what a source
   * offers, one re-read because the board is a projection of what is on disk afterwards - and the
   * whole set is reported together, so a bulk delete that half-failed says which half.
   */
  removeCards(cards: readonly TicketCard[]): Promise<boolean>
  /**
   * Exactly what the Done column's bulk delete would remove: the cards past the cutoff that the
   * collapsed column has folded away, minus any whose source refuses deletion. Derived here rather
   * than in the panel, because both halves of that decision are the hook's.
   */
  sweepableDone: TicketCard[]
  /**
   * What deleting these cards costs, in their sources' own words, deduplicated. Empty while the
   * sources are still answering, so the confirmation shows only sentences it can stand behind.
   */
  removalNotes(cards: readonly TicketCard[]): string[]
  clearMoveError(): void
  reveal(card: TicketCard): void
  refresh(): Promise<void>
  announcement: string
  /** Every configured source, in order, for the board's per-source toggles. */
  sources: TicketSourceState[]
}

export interface TicketBoardOptions {
  sources: readonly TicketSource[]
  /** The active project. Without one there is no board to read, and no folder to watch. */
  projectPath?: string
  /** Today as `YYYY-MM-DD`, so the Done cutoff and relative dates stay testable. */
  today: string
  /**
   * Ids of the *optional* sources switched on for this project. An optional source that is not
   * listed here is never listed at all: an unasked-for tracker must not cost a subprocess, and a
   * board that quietly showed someone else's issues would not be this project's board.
   */
  enabledSources?: readonly string[]
}

const EMPTY: TicketSourceListResult = { cards: [], diagnostics: [] }

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The tickets could not be read.'
}

/**
 * A source is the user's to choose exactly when it can be absent, which is what answering
 * `availability` means. One predicate rather than three `source.availability` tests, so listing,
 * probing and the toggles can never disagree about which sources are optional.
 */
function isOptional(source: TicketSource): boolean {
  return Boolean(source.availability)
}

export function useTicketBoard(options: TicketBoardOptions): TicketBoard {
  const { projectPath, sources: configured, today } = options
  // A caller that rebuilds its array every render must not restart every read, so what the memos
  // below depend on is the *set of ids*, not the array that carried them.
  const enabledKey = (options.enabledSources ?? []).join(',')
  const enabled = useMemo(() => new Set(enabledKey.split(',').filter(Boolean)), [enabledKey])
  const [availability, setAvailability] = useState<Record<string, TicketSourceAvailability>>({})
  /** What each source says a deletion costs here, keyed by source id; absent until it has answered. */
  const [removalNotes, setRemovalNotes] = useState<Record<string, string>>({})
  const sources = useMemo(
    () => configured.filter((source) => !isOptional(source) || enabled.has(source.id)),
    [configured, enabled]
  )
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

  // Probing is what decides whether a toggle is offered at all, so it runs for every optional
  // source on every project - including the ones already switched off - and never for the rest.
  useEffect(() => {
    setAvailability({})
    if (!projectPath) return
    let current = true
    for (const source of configured) {
      if (!source.availability) continue
      void source
        .availability(projectPath)
        .catch((cause: unknown) => ({ available: false as const, reason: errorText(cause) }))
        .then((result) => {
          if (current) setAvailability((seen) => ({ ...seen, [source.id]: result }))
        })
    }
    return () => {
      current = false
    }
  }, [configured, projectPath])

  // Asked once per project rather than once per confirmation: the answer is a property of the
  // checkout, and a dialog that opened before a subprocess returned would have nothing to say.
  useEffect(() => {
    setRemovalNotes({})
    if (!projectPath) return
    let current = true
    for (const source of configured) {
      if (!source.removalNote) continue
      void source
        .removalNote(projectPath)
        .catch(() => undefined)
        .then((note) => {
          if (current && note) setRemovalNotes((seen) => ({ ...seen, [source.id]: note }))
        })
    }
    return () => {
      current = false
    }
  }, [configured, projectPath])

  const sourceStates = useMemo(
    () =>
      configured.map((source): TicketSourceState => {
        const optional = isOptional(source)
        const probed = availability[source.id]
        return {
          id: source.id,
          label: source.label,
          optional,
          enabled: !optional || enabled.has(source.id),
          ...(optional ? { available: probed?.available } : { available: true }),
          ...(probed?.available === false ? { reason: probed.reason } : {}),
          ...(probed?.available && probed.detail ? { detail: probed.detail } : {})
        }
      }),
    [availability, configured, enabled]
  )

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

  const canRemove = useCallback((card: TicketCard) => ticketRemoveAllowed(card, sources), [sources])

  const removeCards = useCallback(
    async (targets: readonly TicketCard[]): Promise<boolean> => {
      const removable = targets.filter((card) => ticketRemoveAllowed(card, sources))
      if (!projectPath || removable.length === 0) return false
      setMutation(removable.length === 1 ? { cardKey: ticketCardKey(removable[0]) } : {})
      // One at a time, in the order the confirmation listed them, so a failure names the card it
      // belongs to rather than arriving out of a race.
      const failures: string[] = []
      for (const card of removable) {
        const remove = sources.find((source) => source.id === card.sourceId)?.remove
        if (!remove) continue
        try {
          const result = await remove(projectPath, card.id)
          if (!result.ok) failures.push(`${card.id}: ${result.message}`)
        } catch (cause) {
          failures.push(`${card.id}: ${errorText(cause)}`)
        }
      }
      // Re-read whatever happened: after a partial failure the board must show what actually
      // survived, not the set the confirmation was built from.
      await read(true)
      if (failures.length > 0) {
        setMutation({ error: `${failures.length} ticket(s) could not be deleted. ${failures.join(' ')}` })
        return false
      }
      setMutation({})
      setAnnouncement(
        removable.length === 1 ? `${removable[0].title} deleted.` : `${removable.length} tickets deleted.`
      )
      return true
    },
    [projectPath, read, sources]
  )

  const notesFor = useCallback(
    (targets: readonly TicketCard[]): string[] => [
      ...new Set(
        targets
          .filter((card) => ticketRemoveAllowed(card, sources))
          .map((card) => removalNotes[card.sourceId])
          .filter((note): note is string => Boolean(note))
      )
    ],
    [removalNotes, sources]
  )

  const sweepableDone = useMemo(
    () => staleDoneCards(cards, today).filter((card) => ticketRemoveAllowed(card, sources)),
    [cards, sources, today]
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
    canRemove,
    removeCards,
    sweepableDone,
    removalNotes: notesFor,
    clearMoveError: () => setMutation({}),
    reveal,
    refresh: () => read(false),
    announcement,
    sources: sourceStates
  }
}
