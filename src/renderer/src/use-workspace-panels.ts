import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
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

/** The controller plus the one seam only a restore uses: adopting a saved snapshot's state. */
interface DockedPanel<State extends { open: boolean; width: number }> extends DockedPanelController<State> {
  adopt: (saved: State) => void
}

/**
 * The shape both docked panels share: persisted open/width state, lazy mounting, and the clamp
 * applied everywhere a width can reach the DOM - toggle, window resize, and restore. Each panel
 * is a sibling of `.canvas-region`, so an unclamped width (a snapshot saved on a bigger monitor)
 * could squeeze the canvas out.
 */
function useDockedPanel<State extends { open: boolean; width: number }>(
  initial: State,
  clampWidth: (width: number, windowWidth: number) => number
): DockedPanel<State> {
  const [state, setState] = useState<State>(initial)
  const [mounted, setMounted] = useState(false)
  const openRef = useRef(false)
  openRef.current = state.open

  const toggle = useCallback((): void => {
    setMounted(true)
    // Spread first: whatever else the panel persists (per-project source choices, a draft) must
    // survive every open and close.
    setState((current) => ({
      ...current,
      open: !current.open,
      width: clampWidth(current.width, window.innerWidth)
    }))
  }, [clampWidth])

  const patch = useCallback((patch: Partial<State>): void => setState((current) => ({ ...current, ...patch })), [])

  const adopt = useCallback(
    (saved: State): void => {
      setState({ ...saved, width: clampWidth(saved.width, window.innerWidth) })
      if (saved.open) setMounted(true)
    },
    [clampWidth]
  )

  // The panel takes real layout width, so a smaller window must narrow it rather than let it push
  // the canvas off-screen.
  useEffect(() => {
    const onResize = (): void => {
      setState((current) => {
        const width = clampWidth(current.width, window.innerWidth)
        return width === current.width ? current : { ...current, width }
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clampWidth])

  return useMemo(() => ({ state, mounted, openRef, toggle, patch, adopt }), [adopt, mounted, patch, state, toggle])
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
 * The docked-panel wiring: the brain-dump library and the ticket board as two `useDockedPanel`s
 * plus what only the pair needs - the observed workspace width and the snapshot restore. What the
 * panels *show* stays their own business; this hook owns only where they sit.
 */
export function useWorkspacePanels(): WorkspacePanelsController {
  // The brain-dump library is global rather than per-project, so the workspace owns its persisted
  // panel state and the panel itself only renders it.
  const brainDump = useDockedPanel<BrainDumpPanelState>(
    { open: false, width: BRAIN_DUMP_PANEL_DEFAULT_WIDTH },
    clampBrainDumpPanelWidth
  )
  // The board is a projection of the active project's files, so the workspace persists only where
  // the panel sits; everything it shows is re-read from disk.
  const ticketBoard = useDockedPanel<TicketBoardPanelState>(
    { open: false, width: TICKET_BOARD_DEFAULT_WIDTH },
    clampTicketBoardWidth
  )
  const [workspaceWidth, setWorkspaceWidth] = useState(() => window.innerWidth)

  useEffect(() => {
    const onResize = (): void => setWorkspaceWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const { adopt: adoptBrainDump } = brainDump
  const { adopt: adoptTicketBoard } = ticketBoard
  const restore = useCallback(
    (saved: WorkspaceState): void => {
      if (saved.brainDumpPanel) adoptBrainDump(saved.brainDumpPanel)
      if (saved.ticketBoardPanel)
        adoptTicketBoard({
          ...saved.ticketBoardPanel,
          // A source choice for a project that is no longer in the snapshot would be unreachable
          // from the board's UI, so it is pruned before it is adopted.
          enabledSources: pruneEnabledSources(
            saved.ticketBoardPanel.enabledSources,
            saved.projects.map((entry) => entry.path)
          )
        })
    },
    [adoptBrainDump, adoptTicketBoard]
  )

  return { brainDump, ticketBoard, workspaceWidth, restore }
}
