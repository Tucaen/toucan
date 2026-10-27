import type { TicketSource } from '../../shared/ticket-source'
import type { WorkspaceProject } from '../../shared/workspace'
import type { TicketSessionChip } from './ticket-activity'
import TicketBoardPanel from './TicketBoardPanel'
import type { WorkspacePanelsController } from './use-workspace-panels'

/**
 * Today in the user's own calendar. The ticket board records local calendar days, so a UTC
 * date would read "yesterday" all evening for anyone west of Greenwich.
 */
function localCalendarDate(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${`${now.getDate()}`.padStart(2, '0')}`
}

export interface WorkspacePanelsProps {
  panels: WorkspacePanelsController
  activeProject: WorkspaceProject | undefined
  /** Advanced when the active project's tickets-folder change has been persisted. */
  ticketsFolderRevision?: number
  ticketSources: readonly TicketSource[]
  ticketSessions?: ReadonlyMap<string, TicketSessionChip>
  onFocusSession: (nodeId: string) => void
}

/**
 * The docked panel, rendered as a sibling of `.canvas-region` inside `.workspace-shell` -
 * docked, never overlaid, so opening it only narrows React Flow's box. Once mounted it stays
 * mounted and merely hides, which is what preserves selection, search and scroll across a close.
 * Its geometry lives in `useWorkspacePanels`; this component only feeds it the workspace data it
 * projects.
 */
export function WorkspacePanels({
  panels,
  activeProject,
  ticketsFolderRevision,
  ticketSources,
  ticketSessions,
  onFocusSession
}: WorkspacePanelsProps): JSX.Element {
  return (
    <>
      {panels.ticketBoard.mounted && (
        <TicketBoardPanel
          panel={panels.ticketBoard.state}
          revision={ticketsFolderRevision}
          workspaceWidth={panels.workspaceWidth}
          projectPath={activeProject?.path}
          projectName={activeProject?.name}
          ticketsDirectory={activeProject?.ticketsDirectory}
          sources={ticketSources}
          skillApi={window.ticketSkillApi}
          today={localCalendarDate()}
          sessions={ticketSessions}
          onFocusSession={onFocusSession}
          onPanelChange={panels.ticketBoard.patch}
        />
      )}
    </>
  )
}
