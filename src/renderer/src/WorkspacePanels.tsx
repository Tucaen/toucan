import type { BrainDumpCaptureConversation } from '../../shared/brain-dump'
import type { TicketSource } from '../../shared/ticket-source'
import type { WorkspaceProject } from '../../shared/workspace'
import BrainDumpLibraryPanel from './BrainDumpLibraryPanel'
import type { TicketSessionChip } from './ticket-activity'
import TicketBoardPanel from './TicketBoardPanel'
import type { WorkspacePanelsController } from './use-workspace-panels'

/**
 * Today in the user's own calendar. The brain-dump library records local calendar days, so a UTC
 * date would read "yesterday" all evening for anyone west of Greenwich.
 */
function localCalendarDate(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${`${now.getDate()}`.padStart(2, '0')}`
}

export interface WorkspacePanelsProps {
  panels: WorkspacePanelsController
  projects: readonly WorkspaceProject[]
  activeProject: WorkspaceProject | undefined
  /** Advanced when the active project's tickets-folder change has been persisted. */
  ticketsFolderRevision?: number
  ticketSources: readonly TicketSource[]
  ticketSessions?: ReadonlyMap<string, TicketSessionChip>
  onFocusSession: (nodeId: string) => void
  onOpenBrainDumpSession: (conversation: BrainDumpCaptureConversation) => void
}

/**
 * The two docked panels, rendered as siblings of `.canvas-region` inside `.workspace-shell` -
 * docked, never overlaid, so opening one only narrows React Flow's box. Once mounted a panel
 * stays mounted and merely hides, which is what preserves selection, search, scroll, and an
 * unsent draft across a close. Their geometry lives in `useWorkspacePanels`; this component only
 * feeds each panel the workspace data it projects.
 */
export function WorkspacePanels({
  panels,
  projects,
  activeProject,
  ticketsFolderRevision,
  ticketSources,
  ticketSessions,
  onFocusSession,
  onOpenBrainDumpSession
}: WorkspacePanelsProps): JSX.Element {
  return (
    <>
      {panels.brainDump.mounted && (
        <BrainDumpLibraryPanel
          panel={panels.brainDump.state}
          workspaceWidth={panels.workspaceWidth}
          projects={projects}
          activeProjectPath={activeProject?.path}
          api={window.brainDumpApi}
          today={localCalendarDate()}
          onPanelChange={panels.brainDump.patch}
          onOpenSessionOnCanvas={onOpenBrainDumpSession}
        />
      )}

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
