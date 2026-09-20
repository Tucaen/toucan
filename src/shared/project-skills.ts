/**
 * Where a project keeps its *own* agent skills: committed with the code, read by whichever
 * provider a session runs on, and the project's to edit. Two things in Toucan have to agree on
 * that location - the session launcher that hands the folder to a provider, and anything that
 * writes a starter skill into it - and naming it twice is exactly how they would come to disagree.
 *
 * Pure: segments rather than a joined path, because main joins them with `node:path` while the
 * renderer only ever shows the location to a reader.
 */

/** The folder a project's agent configuration lives in, at the root of the checkout. */
export const PROJECT_SKILLS_DIRECTORY = '.agents'

/** The file a skill is defined by; a directory without one is not a skill. */
export const SKILL_DEFINITION_FILE = 'SKILL.md'

/** `<project>/.agents/skills/<name>/SKILL.md` as segments, relative to the checkout. */
export function projectSkillFileSegments(name: string): string[] {
  return [PROJECT_SKILLS_DIRECTORY, 'skills', name, SKILL_DEFINITION_FILE]
}

/**
 * The manifest that makes `.agents` a plugin Claude will actually load, rather than a folder that
 * merely looks like one. A skill dropped beside it without it is the failure this constant exists
 * to prevent: `sessionSkillsConfiguration` passes `.agents` as a local plugin the moment a
 * `skills/` folder is there, and a plugin with no manifest loads nothing.
 */
export const PROJECT_SKILLS_MANIFEST_SEGMENTS = [PROJECT_SKILLS_DIRECTORY, '.claude-plugin', 'plugin.json']

/** Written for a scaffolded checkout; the project renames it like anything else it now owns. */
export function projectSkillsManifest(): string {
  return `${JSON.stringify(
    {
      name: 'project-skills',
      version: '0.1.0',
      description: "This project's own agent skills."
    },
    null,
    2
  )}\n`
}

/**
 * The same path written for a reader, always with forward slashes - it is shown in prose and in
 * the skill's own text, where a Windows separator would read as an escape rather than a path.
 */
export function projectSkillPath(name: string): string {
  return projectSkillFileSegments(name).join('/')
}
