import type { WorkspaceFileEntry, WorkspaceFileIndex } from '../../shared/workspace-files'
import { tokenOpeningWord, type CompletionToken } from './completion-token'
import { shortenFilePath } from './file-operation'

export type FileMentionQuery = CompletionToken

/** How many entries the menu may show at once, however large the repository is. */
const MENTION_MATCH_LIMIT = 50

/** How many agent-touched paths stay in the "already seen" band at the top of an empty query. */
const RECENT_PATH_LIMIT = 10

/**
 * An `@` only means "point me at a file" when it opens a word - welded to one it is an address
 * (`morgan@example.com`) or a version (`react@19`). `tokenOpeningWord` owns that rule, shared with
 * the slash picker so the two can never drift.
 */
export function fileMentionQuery(draft: string, caret: number): FileMentionQuery | null {
  return tokenOpeningWord(draft, caret, '@')
}

const basenameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/**
 * The loosest match the picker will make, and deliberately looser than a prefix without being a
 * free subsequence: the query has to be readable as a run of consecutive path segments, each
 * either consumed whole or matched as a prefix of the last one. `srcmainindex` therefore finds
 * `src/main/index.ts`, while `mainidx` - which a plain subsequence would happily accept - does
 * not, because `idx` is not how anyone spells the start of `index.ts`.
 */
function matchesSegmentChain(path: string, needle: string): boolean {
  const segments = path.split('/')
  for (let first = 0; first < segments.length; first += 1) {
    let rest = needle
    let position = first
    while (rest.length > 0 && position < segments.length) {
      const segment = segments[position]
      if (rest.length <= segment.length) {
        if (segment.startsWith(rest)) rest = ''
        break
      }
      if (!rest.startsWith(segment)) break
      rest = rest.slice(segment.length)
      position += 1
    }
    if (rest.length === 0) return true
  }
  return false
}

/**
 * How well an entry answers the query, smallest first. The bands are ordered by how confident the
 * reader can be that this is the path they meant: the whole path they are typing out, then the
 * file name they are typing out, then the query appearing anywhere in the path, then the segment
 * chain above. `null` means no match at all.
 */
function matchBand(path: string, needle: string): number | null {
  if (path.startsWith(needle)) return 0
  if (basenameOf(path).startsWith(needle)) return 1
  if (path.includes(needle)) return 2
  return matchesSegmentChain(path, needle) ? 3 : null
}

/**
 * Narrows and orders the index for what is being typed. Paths the agent has already touched come
 * first whatever the query - they are the files the conversation is actually about, and putting
 * them on top is the only signal the composer gives about what the agent can already see. Within
 * each band the index's own ordering is preserved, so the list never reshuffles for reasons the
 * reader can't see, and the whole thing is bounded so a monorepo cannot flood the menu.
 */
export function rankFileMentions(
  entries: readonly WorkspaceFileEntry[],
  query: string,
  recent: readonly string[],
  limit = MENTION_MATCH_LIMIT
): WorkspaceFileEntry[] {
  const needle = query.toLowerCase()
  const recency = new Map(recent.map((path, position) => [path, position]))
  const ranked: Array<{ entry: WorkspaceFileEntry; recency: number; band: number; position: number; index: number }> =
    []
  entries.forEach((entry, index) => {
    const path = entry.path.toLowerCase()
    const band = needle ? matchBand(path, needle) : 0
    if (band === null) return
    ranked.push({
      entry,
      recency: recency.get(entry.path) ?? Number.MAX_SAFE_INTEGER,
      band,
      position: needle ? path.indexOf(needle) : 0,
      index
    })
  })
  ranked.sort((a, b) => {
    if (a.recency !== b.recency) return a.recency - b.recency
    if (a.band !== b.band) return a.band - b.band
    if (a.position !== b.position) return a.position - b.position
    return a.index - b.index
  })
  return ranked.slice(0, limit).map((entry) => entry.entry)
}

/**
 * The text a reference becomes in the draft. Both installed adapters flatten an ACP resource link
 * back into text before the model ever sees it, so a root-relative path written plainly is the
 * same reference with none of the round trip - and it stays legible in the composer, which a
 * `file://` URI would not. Whitespace is quoted so the path still reads as one token.
 * @internal exported for tests
 */
export function fileMentionReference(entry: WorkspaceFileEntry): string {
  const path = entry.directory ? `${entry.path}/` : entry.path
  return /\s/.test(path) ? `@"${path}"` : `@${path}`
}

export interface FileMentionAcceptance {
  draft: string
  caret: number
}

/**
 * Replaces the mention token under the caret with the chosen path, keeping whatever already
 * followed the caret. A file is finished, so it gets a trailing space; a directory is a step on
 * the way somewhere, so the caret is left just inside it and the menu keeps narrowing.
 */
export function acceptFileMention(
  draft: string,
  caret: number,
  token: Pick<FileMentionQuery, 'start'>,
  entry: WorkspaceFileEntry
): FileMentionAcceptance {
  const inserted = entry.directory ? fileMentionReference(entry) : `${fileMentionReference(entry)} `
  return {
    draft: draft.slice(0, token.start) + inserted + draft.slice(caret),
    caret: token.start + inserted.length
  }
}

/**
 * The agent-touched files under this working directory, newest first and deduplicated. Toucan has
 * no editor and so no "open file" of its own: what the agent has already read or written *is* the
 * open set here, which is why this doubles as the picker's top band. Locations
 * arrive from the adapters as whatever shape the provider reported, so anything that does not
 * resolve inside this root - a path in the main checkout read from a worktree session, an
 * absolute path elsewhere on disk - is dropped rather than offered as a reference that would
 * point at the wrong tree.
 */
export function recentMentionPaths(locations: readonly string[], root: string, limit = RECENT_PATH_LIMIT): string[] {
  const seen = new Set<string>()
  const recent: string[] = []
  for (const location of locations) {
    const relative = shortenFilePath(location, [root])
    if (relative === location.replace(/\\/g, '/')) continue
    if (seen.has(relative)) continue
    seen.add(relative)
    recent.push(relative)
    if (recent.length === limit) break
  }
  return recent
}

/**
 * What the picker is not showing, said out loud. A file picker that quietly omits everything in
 * `.gitignore` - or that quietly stops honouring it outside a checkout, or that quietly shows
 * only the first few thousand files of a monorepo - leaves the reader unable to tell "not
 * offered" from "not there", so each of those cases names itself.
 */
export function fileMentionExclusionNote(index: WorkspaceFileIndex | null): string | null {
  if (!index) return null
  const scope = index.gitignored
    ? 'Files git ignores are hidden (.gitignore and its other exclude rules)'
    : 'Not a git checkout — build and dependency directories are hidden'
  return index.truncated ? `${scope} · this directory is too large to list in full` : scope
}

/**
 * Everything the composer remembers about the mention completion between key presses. Like the
 * slash completion's, it is deliberately *not* "is the menu open" - openness is derived from the
 * draft each render, so a stale flag can never leave the menu hanging over a draft that no longer
 * has a mention token in it.
 */
export interface FileMentionCompletionState {
  /** Start index of the token Escape dismissed, so typing more of that same token stays dismissed. */
  dismissedStart: number | null
  /**
   * The path just inserted by accepting a file. An accepted reference still matches its own entry,
   * so without this the menu would sit open over the choice that was just made. A directory never
   * records one: walking into a folder is exactly when the list should stay up.
   */
  acceptedQuery: string | null
  highlight: number
}

export const emptyFileMentionCompletion: FileMentionCompletionState = {
  dismissedStart: null,
  acceptedQuery: null,
  highlight: 0
}

export interface FileMentionCompletionView {
  /** The mention token under the caret, or null when the draft isn't offering one. */
  token: FileMentionQuery | null
  matches: WorkspaceFileEntry[]
  open: boolean
  /** Always in range, so a highlight left over from a longer list can't point past the new one. */
  activeIndex: number
}

/** The one place that decides what the mention picker shows for a given draft, caret and memory. */
export function fileMentionCompletionView(
  draft: string,
  caret: number,
  index: WorkspaceFileIndex | null,
  recent: readonly string[],
  state: FileMentionCompletionState
): FileMentionCompletionView {
  const token = fileMentionQuery(draft, caret)
  const matches = token ? rankFileMentions(index?.entries ?? [], token.query, recent) : []
  const open =
    token !== null && matches.length > 0 && state.dismissedStart !== token.start && state.acceptedQuery !== token.query
  return { token, matches, open, activeIndex: Math.min(state.highlight, Math.max(matches.length - 1, 0)) }
}

export function highlightFileMention(state: FileMentionCompletionState, highlight: number): FileMentionCompletionState {
  return { ...state, highlight }
}

/** Escape: hide the list for this token without touching the draft. */
export function dismissFileMentionCompletion(
  state: FileMentionCompletionState,
  token: FileMentionQuery | null
): FileMentionCompletionState {
  return { ...state, dismissedStart: token?.start ?? null }
}

/** A reference was inserted: nothing is dismissed any more, but this token has been answered. */
export function acceptedFileMention(
  state: FileMentionCompletionState,
  entry: WorkspaceFileEntry
): FileMentionCompletionState {
  return { dismissedStart: null, acceptedQuery: entry.directory ? null : entry.path, highlight: 0 }
}
