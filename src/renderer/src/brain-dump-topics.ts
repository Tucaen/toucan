import type { BrainDumpTopic } from '../../shared/brain-dump'
import type { WorkspaceProject } from '../../shared/terminal'

/**
 * How the library presents a topic before any of it reaches the DOM: which workspace project owns
 * it, what its preview says, which rows survive a search, and where selection lands once a topic
 * leaves the collection it was selected in. The panel renders these answers; it does not compute
 * them.
 */

/** A topic's project as the list and reader must show it - never colour alone. */
export interface BrainDumpProjectIdentity {
  /** The visible text: a project name, a folder basename, or `Unassigned`. */
  label: string
  /** Set only for a project ADE currently has registered. */
  color?: string
  /** The absolute path, for the tooltip. Absent when the topic is unassigned. */
  path?: string
  /** Shown when the path is no longer a registered project, so the row explains itself. */
  note?: string
  registered: boolean
  unassigned: boolean
}

export const BRAIN_DUMP_UNASSIGNED_LABEL = 'Unassigned'
export const BRAIN_DUMP_UNREGISTERED_NOTE = 'Project not in workspace'

/**
 * One comparable identity for a filesystem path. The same checkout reaches ADE with either drive
 * letter case and with either separator, so a topic written on one route must still match the
 * project registered by the other.
 */
export function brainDumpPathIdentity(path: string): string {
  return path
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLocaleLowerCase('en-US')
}

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** Resolves a topic's `project` frontmatter against the projects the workspace has registered. */
export function resolveBrainDumpProject(
  projectPath: string | undefined,
  projects: readonly WorkspaceProject[]
): BrainDumpProjectIdentity {
  if (!projectPath) return { label: BRAIN_DUMP_UNASSIGNED_LABEL, registered: false, unassigned: true }
  const identity = brainDumpPathIdentity(projectPath)
  const registered = projects.find((project) => brainDumpPathIdentity(project.path) === identity)
  if (registered)
    return {
      label: registered.name,
      color: registered.color,
      path: registered.path,
      registered: true,
      unassigned: false
    }
  // The topic stays perfectly usable when its project has been removed from the workspace; only
  // its identity degrades, and the row says so rather than silently reading as unassigned.
  return {
    label: basename(projectPath),
    path: projectPath,
    note: BRAIN_DUMP_UNREGISTERED_NOTE,
    registered: false,
    unassigned: false
  }
}

/** The topic's body with frontmatter, headings, and Markdown noise stripped down to prose. */
export function brainDumpTopicPreview(markdown: string): string {
  const body = markdown.startsWith('---') ? markdown.slice(markdown.indexOf('\n---', 3) + 4) : markdown
  return body
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !/^-{3,}$/.test(line))
    .join(' ')
    .replace(/\[\[([^\]\n]+)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * A topic's `updated` date relative to `today`, both as calendar dates (`YYYY-MM-DD`). The library
 * records days, not instants, so "today" here means the same calendar day rather than 24 hours.
 */
export function describeBrainDumpDate(updated: string, today: string): string {
  if (updated === today) return 'today'
  const day = 86_400_000
  const parsed = Date.parse(`${updated}T00:00:00Z`)
  const reference = Date.parse(`${today}T00:00:00Z`)
  if (Number.isNaN(parsed) || Number.isNaN(reference)) return updated
  const elapsed = Math.round((reference - parsed) / day)
  if (elapsed === 1) return 'yesterday'
  if (elapsed > 1 && elapsed < 7) return `${elapsed} days ago`
  return updated
}

/**
 * Rows matching `query` in title, slug, body, or resolved project identity, in the order the
 * library returned them. An empty query keeps every row.
 */
export function searchBrainDumpTopics(
  topics: readonly BrainDumpTopic[],
  query: string,
  projects: readonly WorkspaceProject[]
): BrainDumpTopic[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return [...topics]
  return topics.filter((topic) => {
    const project = resolveBrainDumpProject(topic.projectPath, projects)
    const haystack = [topic.title, topic.slug, topic.markdown, project.label, project.path ?? '']
      .join('\n')
      .toLocaleLowerCase()
    return haystack.includes(needle)
  })
}

/**
 * Which row to select once `removedSlug` is no longer in `previous`. A lifecycle change should
 * leave the user somewhere sensible - the next row down, or the last one - never nowhere.
 */
export function nextBrainDumpSelection(previous: readonly BrainDumpTopic[], removedSlug: string): string | undefined {
  const index = previous.findIndex((topic) => topic.slug === removedSlug)
  if (index < 0) return previous[0]?.slug
  const remaining = previous.filter((topic) => topic.slug !== removedSlug)
  if (remaining.length === 0) return undefined
  return remaining[Math.min(index, remaining.length - 1)].slug
}
