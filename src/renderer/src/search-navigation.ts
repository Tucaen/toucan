import type { AgentActivity } from '../../shared/agent'

export interface SearchMatch {
  line?: number
  text: string
}

export interface SearchMatchGroup {
  path: string
  matches: SearchMatch[]
}

export interface GrepSearch {
  kind: 'grep'
  pattern: string
  matchCount: number
  groups: SearchMatchGroup[]
  /** Grep ran in files-with-matches mode: the groups name files and carry no line matches. */
  filesOnly?: boolean
}

export interface GlobSearch {
  kind: 'glob'
  pattern: string
  paths: string[]
}

export interface WebResult {
  title: string
  url: string
  host: string
}

export interface WebSearch {
  kind: 'web-search'
  query: string
  results: WebResult[]
}

export interface WebFetch {
  kind: 'web-fetch'
  url: string
  host: string
  title: string
  content?: string
}

export type SearchNavigation = GrepSearch | GlobSearch | WebSearch | WebFetch

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizeToolName(name: string | undefined): string | undefined {
  if (!name) return undefined
  const bare = name.split(/[.:]|__/).filter(Boolean).at(-1) ?? name
  return bare.toLowerCase().replace(/[^a-z]/g, '')
}

function grepGroups(content: string | undefined): SearchMatchGroup[] {
  if (!content) return []
  const groups = new Map<string, SearchMatch[]>()
  for (const row of content.split('\n')) {
    const match = /^(.*?):(\d+):(.*)$/.exec(row)
    if (!match) continue
    const path = match[1]
    const matches = groups.get(path) ?? []
    matches.push({ line: Number(match[2]), text: match[3] })
    groups.set(path, matches)
  }
  return Array.from(groups, ([path, matches]) => ({ path, matches }))
}

function urlHost(url: string): string | undefined {
  try {
    return new URL(url).host || undefined
  } catch {
    return undefined
  }
}

function webResults(content: string | undefined): WebResult[] {
  if (!content) return []
  return content.split('\n').flatMap((line) => {
    const match = /^(.*?)\s+\((https?:\/\/.*)\)$/.exec(line.trim())
    if (!match) return []
    const host = urlHost(match[2])
    return host ? [{ title: match[1], url: match[2], host }] : []
  })
}

/** Recover the provider-specific arguments and result text needed by a search/navigation card. */
export function parseSearchNavigation(activity: AgentActivity): SearchNavigation | null {
  const name = normalizeToolName(activity.toolName)
  const input = asRecord(activity.rawInput) ?? {}
  const action = asRecord(input.action)
  const actionType = asText(action?.type)
  if (name === 'websearch' || (input.type === 'webSearch' && (!actionType || actionType === 'search'))) {
    const queries = Array.isArray(action?.queries)
      ? action.queries.filter((query): query is string => typeof query === 'string' && query.length > 0)
      : []
    const query = asText(action?.query) ?? (queries.length > 0 ? queries.join(', ') : undefined) ?? asText(input.query)
    if (!query) return null
    return { kind: 'web-search', query, results: webResults(activity.content) }
  }
  if (name === 'webfetch' || actionType === 'openPage' || actionType === 'findInPage') {
    const url = asText(input.url) ?? asText(action?.url)
    const host = url ? urlHost(url) : undefined
    if (!url || !host) return null
    const actionTitle = actionType === 'openPage' ? 'Open page' : actionType === 'findInPage' ? 'Find in page' : undefined
    return {
      kind: 'web-fetch',
      url,
      host,
      title: asText(input.title) ?? actionTitle ?? 'Web fetch',
      ...(activity.content ? { content: activity.content } : {})
    }
  }
  const pattern = asText(input.pattern)
  if (!pattern) return null
  if (name === 'glob') {
    const paths = activity.content?.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^no files found\.?$/i.test(line)) ?? []
    return { kind: 'glob', pattern, paths }
  }
  if (name !== 'grep') return null
  if (asText(input.output_mode) === 'files_with_matches') {
    const files = activity.content?.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((path) => ({ path, matches: [] })) ?? []
    return { kind: 'grep', pattern, matchCount: files.length, filesOnly: true, groups: files }
  }
  const groups = grepGroups(activity.content)
  return {
    kind: 'grep',
    pattern,
    matchCount: groups.reduce((total, group) => total + group.matches.length, 0),
    groups
  }
}

const parsedSearches = new WeakMap<AgentActivity, SearchNavigation | null>()

export function searchNavigationFor(activity: AgentActivity): SearchNavigation | null {
  const cached = parsedSearches.get(activity)
  if (cached !== undefined) return cached
  const search = parseSearchNavigation(activity)
  parsedSearches.set(activity, search)
  return search
}

export function clampSearchNavigation(
  search: SearchNavigation,
  budget: number | null
): { search: SearchNavigation; hiddenLines: number } {
  if (budget === null) return { search, hiddenLines: 0 }
  let remaining = Math.max(0, budget)
  if (search.kind === 'web-fetch') {
    if (!search.content) return { search, hiddenLines: 0 }
    const lines = search.content.split('\n')
    const kept = lines.slice(0, remaining)
    return {
      search: { ...search, content: kept.join('\n') },
      hiddenLines: lines.length - kept.length
    }
  }
  if (search.kind === 'web-search') {
    const results = search.results.slice(0, remaining)
    return { search: { ...search, results }, hiddenLines: search.results.length - results.length }
  }
  if (search.kind === 'glob') {
    const paths = search.paths.slice(0, remaining)
    return { search: { ...search, paths }, hiddenLines: search.paths.length - paths.length }
  }
  if (search.filesOnly) {
    const kept = search.groups.slice(0, remaining)
    return { search: { ...search, groups: kept }, hiddenLines: search.groups.length - kept.length }
  }
  const groups: SearchMatchGroup[] = []
  let hiddenLines = 0
  for (const group of search.groups) {
    const matches = group.matches.slice(0, remaining)
    hiddenLines += group.matches.length - matches.length
    remaining -= matches.length
    if (matches.length > 0) groups.push(matches.length === group.matches.length ? group : { ...group, matches })
  }
  return { search: { ...search, groups }, hiddenLines }
}

export function searchNavigationSummary(search: SearchNavigation): string {
  if (search.kind === 'web-fetch') return `${search.host} — ${search.title}`
  if (search.kind === 'web-search') {
    const first = search.results[0]
    return first ? `${first.host} — ${first.title}` : `${search.query} — No web results`
  }
  if (search.kind === 'glob') {
    if (search.paths.length === 0) return `${search.pattern} — No files`
    return `${search.pattern} — ${search.paths.length} ${search.paths.length === 1 ? 'file' : 'files'}`
  }
  if (search.matchCount === 0) return `${search.pattern} — No matches`
  if (search.filesOnly) {
    const files = search.matchCount === 1 ? 'file' : 'files'
    return `${search.pattern} — ${search.matchCount} matching ${files}`
  }
  const matches = `${search.matchCount} ${search.matchCount === 1 ? 'match' : 'matches'}`
  const files = `${search.groups.length} ${search.groups.length === 1 ? 'file' : 'files'}`
  return `${search.pattern} — ${matches} in ${files}`
}
