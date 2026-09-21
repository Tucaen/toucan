import { useEffect, useRef, useState } from 'react'
import type { WorkspaceSaveStatus } from './workspace-persistence'

/** Which project's tickets are on the board, and where that project keeps them. */
export interface TicketsFolder {
  projectId: string
  /** The resolved directory, never the raw preference - see `ticketsDirectoryOrDefault`. */
  directory: string
}

/**
 * A counter the ticket board re-lists on, advanced when the active project's tickets folder has
 * actually reached disk.
 *
 * Main resolves a project's tickets folder from the *persisted* snapshot, so a board re-listed the
 * moment the setting changed would read the old folder and never hear about the new one. Watching
 * the save status for its `saving` -> `saved` transition is what makes the revision advance after
 * the write rather than in the render where the user hit Save.
 *
 * It advances only for a folder change on the project already showing: switching projects re-lists
 * the board anyway, so advancing there would only cost a second listing - all the effect does for
 * a switch is remember what the new project's folder was when it was last written.
 *
 * `null` is "no project", which can only be the empty workspace.
 */
export function useTicketsFolderRevision(folder: TicketsFolder | null, saveStatus: WorkspaceSaveStatus): number {
  const [revision, setRevision] = useState(0)
  // The two parts are compared separately rather than packed into one key: a Windows directory
  // carries its own colon, so any single-string encoding would have to be parsed to be trusted.
  const savedProjectId = useRef(folder?.projectId)
  const savedDirectory = useRef(folder?.directory)
  const previousSaveStatus = useRef(saveStatus)
  const projectId = folder?.projectId
  const directory = folder?.directory

  useEffect(() => {
    const persistedDirectory = savedDirectory.current
    const priorSaveStatus = previousSaveStatus.current
    previousSaveStatus.current = saveStatus
    // Another project entirely: the board re-lists on the switch itself, so there is nothing to
    // advance - only the record of what that project's folder was when it was last written.
    if (savedProjectId.current !== projectId) {
      savedProjectId.current = projectId
      savedDirectory.current = directory
      return
    }
    if (priorSaveStatus !== 'saving' || saveStatus !== 'saved' || persistedDirectory === directory) return
    savedDirectory.current = directory
    setRevision((current) => current + 1)
  }, [directory, projectId, saveStatus])

  return revision
}
