import type { BrainDumpTopic } from '../../shared/brain-dump'
import type { WorkspaceProject } from '../../shared/workspace'
import { pathIdentity } from '../../shared/paths'

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
  /** Set only for a project Toucan currently has registered. */
  color?: string
  /** The absolute path, for the tooltip. Absent when the topic is unassigned. */
  path?: string
  /** Shown when the path is no longer a registered project, so the row explains itself. */
  note?: string
  registered: boolean
  unassigned: boolean
}

export const BRAIN_DUMP_UNASSIGNED_LABEL = 'Unassigned'
/** @internal exported for tests */
export const BRAIN_DUMP_UNREGISTERED_NOTE = 'Project not in workspace'

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
  const identity = pathIdentity(projectPath)
  const registered = projects.find((project) => pathIdentity(project.path) === identity)
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
