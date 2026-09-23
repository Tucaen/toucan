import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { BrainDumpPanelState, TicketBoardPanelState, WorkspaceState } from '../../shared/workspace'
import { BRAIN_DUMP_PANEL_DEFAULT_WIDTH, clampBrainDumpPanelWidth } from './brain-dump-panel-layout'
import { TICKET_BOARD_DEFAULT_WIDTH, clampTicketBoardWidth, pruneEnabledSources } from './ticket-board-layout'

/** One docked panel's workspace-owned state and the two gestures every panel shares. */
export interface DockedPanelController<State extends { open: boolean; width: number }> {
  state: State
  /**
   * Docked panels mount lazily on first open and thereafter only hide, which is what preserves
   * collection, selection, search, scroll and an unsent draft across a close.
   */
  mounted: boolean
  /** The latest open flag, for stable callbacks (the window key handler) that must not re-bind. */
  openRef: MutableRefObject<boolean>
  toggle: () => void
  patch: (patch: Partial<State>) => void
}

export interface WorkspacePanelsController {
  brainDump: DockedPanelController<BrainDumpPanelState>
  ticketBoard: DockedPanelController<TicketBoardPanelState>
  /** `window.innerWidth`, observed so the panels' widths re-clamp with it. */
  workspaceWidth: number
  /** Applies a restored snapshot's panel state, clamped into this window before it renders. */
  restore: (saved: WorkspaceState) => void
}

/**
 * The docked-panel wiring: persisted open/width state, lazy mounting, width clamping on restore,
 * resize and toggle, and the refs stable key handlers read. The brain-dump library and the ticket
 * board are both siblings of `.canvas-region`, so every width that reaches the DOM has been
 * through the panel's own clamp - a width saved on a bigger monitor can never squeeze the canvas
 * out. What the panels *show* stays their own business; this hook owns only where they sit.
 */
export function useWorkspacePanels(): WorkspacePanelsController {
  // The brain-dump library is global rather than per-project, so the workspace owns its persisted
  // panel state and the panel itself only renders it.
  const [brainDumpPanel, setBrainDumpPanel] = useState<BrainDumpPanelState>({
    open: false,
    width: BRAIN_DUMP_PANEL_DEFAULT_WIDTH
  })
  const [brainDumpMounted, setBrainDumpMounted] = useState(false)
  // The board is a projection of the active project's files, so the workspace persists only where
  // the panel sits; everything it shows is re-read from disk.
  const [ticketBoardPanel, setTicketBoardPanel] = useState<TicketBoardPanelState>({
    open: false,
    width: TICKET_BOARD_DEFAULT_WIDTH
  })
  const [ticketBoardMounted, setTicketBoardMounted] = useState(false)
  const [workspaceWidth, setWorkspaceWidth] = useState(() => window.innerWidth)

  const brainDumpOpenRef = useRef(false)
  const ticketBoardOpenRef = useRef(false)
  brainDumpOpenRef.current = brainDumpPanel.open
  ticketBoardOpenRef.current = ticketBoardPanel.open

  const toggleBrainDump = useCallback((): void => {
    setBrainDumpMounted(true)
    setBrainDumpPanel((current) => ({
      ...current,
      open: !current.open,
      width: clampBrainDumpPanelWidth(current.width, window.innerWidth)
    }))
  }, [])

  const toggleTicketBoard = useCallback((): void => {
    setTicketBoardMounted(true)
    // Spread first: the per-project source choices must survive every open and close.
    setTicketBoardPanel((current) => ({
      ...current,
      open: !current.open,
      width: clampTicketBoardWidth(current.width, window.innerWidth)
    }))
  }, [])

  const patchBrainDump = useCallback(
    (patch: Partial<BrainDumpPanelState>): void => setBrainDumpPanel((current) => ({ ...current, ...patch })),
    []
  )
  const patchTicketBoard = useCallback(
    (patch: Partial<TicketBoardPanelState>): void => setTicketBoardPanel((current) => ({ ...current, ...patch })),
    []
  )

  // The panels take real layout width, so a smaller window must narrow them rather than let them
  // push the canvas off-screen.
  useEffect(() => {
    const onResize = (): void => {
      setWorkspaceWidth(window.innerWidth)
      setBrainDumpPanel((current) => {
        const width = clampBrainDumpPanelWidth(current.width, window.innerWidth)
        return width === current.width ? current : { ...current, width }
      })
      setTicketBoardPanel((current) => {
        const width = clampTicketBoardWidth(current.width, window.innerWidth)
        return width === current.width ? current : { ...current, width }
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // A width saved on a larger monitor is folded into this window before it is ever rendered, so
  // restoring a workspace can never hand the canvas less room than it can use.
  const restore = useCallback((saved: WorkspaceState): void => {
    if (saved.brainDumpPanel) {
      const width = clampBrainDumpPanelWidth(saved.brainDumpPanel.width, window.innerWidth)
      setBrainDumpPanel({ ...saved.brainDumpPanel, width })
      if (saved.brainDumpPanel.open) setBrainDumpMounted(true)
    }
    if (saved.ticketBoardPanel) {
      setTicketBoardPanel({
        ...saved.ticketBoardPanel,
        enabledSources: pruneEnabledSources(
          saved.ticketBoardPanel.enabledSources,
          saved.projects.map((entry) => entry.path)
        ),
        width: clampTicketBoardWidth(saved.ticketBoardPanel.width, window.innerWidth)
      })
      if (saved.ticketBoardPanel.open) setTicketBoardMounted(true)
    }
  }, [])

  return {
    brainDump: {
      state: brainDumpPanel,
      mounted: brainDumpMounted,
      openRef: brainDumpOpenRef,
      toggle: toggleBrainDump,
      patch: patchBrainDump
    },
    ticketBoard: {
      state: ticketBoardPanel,
      mounted: ticketBoardMounted,
      openRef: ticketBoardOpenRef,
      toggle: toggleTicketBoard,
      patch: patchTicketBoard
    },
    workspaceWidth,
    restore
  }
}
