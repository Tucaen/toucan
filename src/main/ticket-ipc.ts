import { EMPTY_TICKET_LISTING } from '../shared/ticket-source'
import { errorMessage } from '../shared/text'
import type { IpcRegistrar } from './ipc-registrar'
import type { TicketLibrary } from './ticket-library'
import type { TicketSkillScaffold } from './ticket-skill-scaffold'
import type { TicketChangeOwner, TicketChangeWatcher } from './ticket-watcher'
import { TICKET_CHANNELS } from '../shared/ipc-channels'
import { join } from 'node:path'
import { PROJECT_SKILLS_MANIFEST_SEGMENTS } from '../shared/project-skills'
import type { WorkspaceContainment } from './workspace-containment'

/**
 * Everything the ticket channels are wired to. `reveal` and `isGitRepository` are injected rather
 * than imported so this module stays free of Electron and of git, exactly as `brain-dump-ipc.ts` is.
 */
export interface TicketIpcDependencies {
  containment: Pick<WorkspaceContainment, 'contains'>
  library: TicketLibrary
  changes: TicketChangeWatcher
  /** Writes a project its own starter tickets skill; see `ticket-skill-scaffold.ts`. */
  skill: TicketSkillScaffold
  /** Shows a file in the OS file manager. */
  reveal(path: string): void
  isGitRepository(projectPath: string): Promise<boolean>
}

/**
 * The renderer's only route to a project's ticket files. Listing a project is also what subscribes
 * the window to that project's folder: a board that can read the tickets must find out when they
 * change, and tying the two together removes the failure mode where one happened without the other.
 */
export function registerTicketIpc(ipc: IpcRegistrar<TicketChangeOwner>, deps: TicketIpcDependencies): void {
  const { library, changes, reveal, isGitRepository, skill } = deps
  const allowed = async (path: unknown): Promise<boolean> =>
    typeof path === 'string' && !!path && deps.containment.contains(path)
  const allowedTicket = async (project: string, slug: string): Promise<boolean> => {
    if (!(await allowed(project))) return false
    try {
      const path = await library.pathFor(project, slug)
      return path === null || await allowed(path)
    } catch {
      return false
    }
  }
  const allowedSkill = async (project: string): Promise<boolean> =>
    await allowed(project) && await allowed(skill.pathFor(project)) &&
      await allowed(join(project, ...PROJECT_SKILLS_MANIFEST_SEGMENTS))

  ipc.handle(TICKET_CHANNELS.list, async (event, projectPath: unknown) => {
    if (typeof projectPath !== 'string' || !(await allowed(projectPath))) return EMPTY_TICKET_LISTING
    changes.subscribe(event.sender)
    void changes.watchProject(projectPath)
    try {
      return await library.list(projectPath)
    } catch (error) {
      // A folder that cannot be read at all is one diagnostic row, not a board that fails to open.
      return {
        cards: [],
        diagnostics: [{ path: projectPath, code: 'unreadable-folder', message: errorMessage(error) }]
      }
    }
  })

  ipc.handle(TICKET_CHANNELS.setStatus, async (_event, projectPath: unknown, slug: unknown, status: unknown) =>
    typeof projectPath === 'string' && typeof slug === 'string' && typeof status === 'string' && await allowedTicket(projectPath, slug)
      ? library.setStatus(projectPath, slug, status)
      : { ok: false, code: 'invalid-request', message: 'Project, ticket and status are required.' }
  )

  ipc.handle(TICKET_CHANNELS.remove, async (_event, projectPath: unknown, slug: unknown) =>
    typeof projectPath === 'string' && projectPath && typeof slug === 'string' && await allowedTicket(projectPath, slug)
      ? library.remove(projectPath, slug)
      : { ok: false, code: 'invalid-request', message: 'Project and ticket are required.' }
  )

  // The cautious answer for anything that cannot be probed: a confirmation must never promise that
  // history keeps a file it has no evidence is in a repository at all.
  ipc.handle(TICKET_CHANNELS.isGitRepository, async (_event, projectPath: unknown) =>
    typeof projectPath === 'string' && await allowed(projectPath) ? isGitRepository(projectPath).catch(() => false) : false
  )

  ipc.handle(TICKET_CHANNELS.reveal, async (_event, projectPath: unknown, slug: unknown) => {
    if (typeof projectPath !== 'string' || typeof slug !== 'string' || !(await allowedTicket(projectPath, slug))) return
    const path = await library.pathFor(projectPath, slug)
    if (path) reveal(path)
  })

  // Without a project there is nothing to probe, and `unknown` is the honest answer rather than a
  // guess in either direction: the board then says nothing about a skill and offers no action.
  ipc.handle(TICKET_CHANNELS.skillState, async (_event, projectPath: unknown) =>
    typeof projectPath === 'string' && await allowedSkill(projectPath)
      ? skill.state(projectPath)
      : { status: 'unknown', path: skill.relativePath }
  )

  ipc.handle(TICKET_CHANNELS.writeSkill, async (_event, projectPath: unknown) =>
    typeof projectPath === 'string' && await allowedSkill(projectPath)
      ? skill.write(projectPath)
      : { ok: false, code: 'invalid-request', message: 'A project is required.' }
  )

  ipc.handle(TICKET_CHANNELS.revealSkill, async (_event, projectPath: unknown) => {
    if (typeof projectPath === 'string' && await allowedSkill(projectPath)) reveal(skill.pathFor(projectPath))
  })
}
