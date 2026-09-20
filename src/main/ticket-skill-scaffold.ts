import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathExists, writeNewFileDurably } from './durable-file'
import { PROJECT_SKILLS_MANIFEST_SEGMENTS, projectSkillsManifest } from '../shared/project-skills'
import { errorMessage } from '../shared/text'
import { TICKET_SKILL_PATH, ticketSkillMarkdown } from '../shared/ticket-skill'
import type { TicketSkillState, TicketSkillWriteResult } from '../shared/ticket-skill'

/**
 * Writes a project its own tickets skill, once. The point of scaffolding rather than injecting is
 * that the result is the *project's*: committed with the code, editable, and never written again -
 * so this module's whole job is to put a good starting file where a provider will actually find it
 * and then get out of the way.
 *
 * Which is why the refusal is the load-bearing part. A skill the project already has is one
 * somebody wrote, and overwriting it would destroy the only copy; so every write here is an
 * exclusive create (`writeNewFileDurably` opens `wx`) rather than a check followed by a write, and
 * a file that appears between the probe and the write loses nothing. `state` exists for the
 * button's label, never as the guard - a UI reading a stale answer must not be able to clobber a
 * file, and a checkout it could not read is answered `unknown` rather than guessed at.
 *
 * "Where a provider will find it" is two files, not one. A `.agents` folder is handed to Claude as
 * a local plugin, and a plugin is identified by its manifest: a `skills/` folder beside no
 * `.claude-plugin/plugin.json` satisfies the launcher's existence check and then loads nothing, so
 * a skill scaffolded without one would be a file nobody ever reads. The manifest is written under
 * the same never-replace rule, because a project that already has one has named its own plugin.
 *
 * What the skill *says* is `shared/ticket-skill.ts`; this module only decides where it goes and
 * what happens when something is already there.
 */

export interface TicketSkillScaffoldOptions {
  /**
   * The project's tickets folder *relative to its checkout* - the skill names it in prose, so a
   * project that moved its tickets scaffolds a skill that sends an agent to the right folder.
   */
  directoryFor(projectPath: string): string | Promise<string>
  /** Today as `YYYY-MM-DD`, so the example ticket is copyable as it stands. */
  today(): string
}

export interface TicketSkillScaffold {
  /** Where the skill goes inside any checkout, for a caller with no project to ask about. */
  readonly relativePath: string
  state(projectPath: string): Promise<TicketSkillState>
  write(projectPath: string): Promise<TicketSkillWriteResult>
  /** The absolute skill file, for revealing it - the one place that joins that path. */
  pathFor(projectPath: string): string
}

/**
 * One spelling of the path, forward slashes and all - the same `TICKET_SKILL_PATH` the scaffolded
 * skill names *inside itself*. `join` normalizes it onto the host anyway, so spelling it a second
 * time with the platform separator would buy nothing and cost the board saying one thing while the
 * file it just wrote says another.
 */
const RELATIVE_PATH = TICKET_SKILL_PATH

function isExisting(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST'
}

/** Creates the parent folder and writes, or reports that something is already there. */
async function createNewFile(path: string, contents: string): Promise<'written' | 'exists'> {
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeNewFileDurably(path, contents)
  } catch (error) {
    if (isExisting(error)) return 'exists'
    throw error
  }
  return 'written'
}

export function createTicketSkillScaffold(options: TicketSkillScaffoldOptions): TicketSkillScaffold {
  const pathFor = (projectPath: string): string => join(projectPath, RELATIVE_PATH)

  return {
    relativePath: RELATIVE_PATH,
    pathFor,
    async state(projectPath) {
      try {
        return { status: (await pathExists(pathFor(projectPath))) ? 'present' : 'absent', path: RELATIVE_PATH }
      } catch {
        return { status: 'unknown', path: RELATIVE_PATH }
      }
    },
    async write(projectPath) {
      const contents = ticketSkillMarkdown({
        ticketsDirectory: await options.directoryFor(projectPath),
        today: options.today()
      })
      try {
        // The manifest first: a skill written beside a folder no provider loads is worse than no
        // skill, because it reads as done. An existing one is the project's and is left alone.
        await createNewFile(join(projectPath, ...PROJECT_SKILLS_MANIFEST_SEGMENTS), projectSkillsManifest())
        // Named rather than described: the whole refusal is "go and read the file you already
        // have", and a message that did not say which file cannot be acted on.
        if ((await createNewFile(pathFor(projectPath), contents)) === 'exists')
          return {
            ok: false,
            code: 'skill-exists',
            message: `${RELATIVE_PATH} already exists. Toucan never replaces a tickets skill the project already has.`
          }
      } catch (error) {
        return { ok: false, code: 'write-failed', message: errorMessage(error) }
      }
      return { ok: true, path: RELATIVE_PATH }
    }
  }
}
