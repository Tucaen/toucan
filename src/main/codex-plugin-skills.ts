import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath, symlink, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathIdentity } from '../shared/paths'
import { PROJECT_SKILLS_DIRECTORY } from '../shared/project-skills'
import { createSerialQueue } from './serial-queue'

/**
 * Where Codex finds a plugin's skills (#55). codex-acp turns every additional directory `D` into
 * the skill root `D/.agents/skills` (`refreshSkills`, codex-acp 2.2.2) and never reads a plugin's
 * own `skills/`, so each plugin folder gets a Toucan-owned directory whose `.agents/skills` links to
 * it. Codex 0.159.0 follows the link (a junction on Windows, which needs no privilege) and resolves
 * it to the plugin folder, whose manifest then namespaces the skills `<id>:<skill>` as Claude does.
 */
export interface CodexPluginSkills {
  /** The additional directory that offers `skills` (a plugin's `skills/`) to Codex, made or confirmed now. */
  rootFor(id: string, skills: string): Promise<string>
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

export function createCodexPluginSkills(userDataPath: string): CodexPluginSkills {
  // Two sessions opening together must not race one link into place, or replace it twice.
  const enqueue = createSerialQueue()
  return {
    rootFor: (id, skills) =>
      enqueue(async () => {
        // Named by folder as well as id: the same id re-added from another folder gets a link of its
        // own, so a running session's link never starts pointing somewhere else.
        const folder = createHash('sha256').update(pathIdentity(skills)).digest('hex').slice(0, 12)
        const root = join(userDataPath, 'codex-plugin-skills', `${id}-${folder}`)
        const link = join(root, PROJECT_SKILLS_DIRECTORY, 'skills')
        const existing = await lstat(link).catch((error: unknown) => {
          if (isMissing(error)) return undefined
          throw error
        })
        if (existing) {
          // Only ever replaces a link: anything else standing there is not Toucan's to delete.
          if (!existing.isSymbolicLink()) throw new Error(`${link} is not a link Toucan made, so it was left alone.`)
          const current = await realpath(link).catch(() => undefined)
          if (current !== undefined && pathIdentity(current) === pathIdentity(await realpath(skills))) return root
          await unlink(link)
        }
        await mkdir(dirname(link), { recursive: true })
        await symlink(skills, link, 'junction')
        return root
      })
  }
}
