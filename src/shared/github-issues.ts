import type { TicketCard, TicketSourceListResult } from './ticket-source'
import { errorMessage } from './text'
import { TICKET_STATUS, type TicketDiagnostic } from './tickets'

/**
 * What a GitHub issue is, to a board that renders cards. Everything here is a decision about the
 * *shape* of `gh`'s answer - which columns labels mean, which fields a card reads, what counts as
 * a GitHub checkout - so it can be reasoned about without a subprocess. Launching `gh` is
 * `main/github-issues.ts`; this module never knows a process exists.
 *
 * Pure: no filesystem, no Node.
 */

/** The second source's id, paired with `TICKET_FILES_SOURCE_ID`. */
export const TICKET_GITHUB_SOURCE_ID = 'github'

/** Exactly the `--json` fields `githubIssueCard` reads; asking for more would be dead payload. */
export const GITHUB_ISSUE_FIELDS = ['number', 'title', 'state', 'updatedAt', 'labels', 'url', 'body'] as const

/**
 * The open issue's column is its label. Only these two are recognised, because they are the only
 * two columns a GitHub project can express without Toucan inventing a convention for it: every
 * other open issue is simply Open, and a closed one is Done. A project that already uses another
 * label for work in flight names it in `WorkspaceProject.githubInProgressLabel`.
 */
export interface GithubStatusLabels {
  blocked: string
  inProgress: string
}

export const DEFAULT_GITHUB_STATUS_LABELS: GithubStatusLabels = {
  blocked: TICKET_STATUS.blocked,
  inProgress: TICKET_STATUS.inProgress
}

/** The labels a project maps to columns: its own In progress label when it set one, else the defaults. */
export function githubStatusLabelsFor(inProgressLabel?: string): GithubStatusLabels {
  const configured = inProgressLabel?.trim()
  return configured ? { ...DEFAULT_GITHUB_STATUS_LABELS, inProgress: configured } : DEFAULT_GITHUB_STATUS_LABELS
}

export interface GithubLabel {
  name: string
}

/** One record of `gh issue list --json …`, as far as a card is concerned. */
export interface GithubIssueRecord {
  number: number
  title: string
  /** `OPEN` or `CLOSED`; compared case-insensitively because it is another tool's enum. */
  state: string
  /** ISO 8601. A card records a calendar day, so only the date part survives. */
  updatedAt: string
  labels?: GithubLabel[]
  url?: string
  body?: string
}

/**
 * Repositories label by hand, so `In Progress`, `in progress` and `in-progress` are one label.
 * Matching on the normalised token means a project does not have to rename its labels for Toucan.
 */
function labelToken(name: string): string {
  return name.trim().toLocaleLowerCase().replace(/\s+/g, '-')
}

/** The one place a GitHub issue turns into a board column. */
export function githubIssueStatus(
  issue: Pick<GithubIssueRecord, 'state' | 'labels'>,
  statusLabels: GithubStatusLabels = DEFAULT_GITHUB_STATUS_LABELS
): string {
  if (issue.state.toLocaleLowerCase() === 'closed') return TICKET_STATUS.done
  const labels = (issue.labels ?? []).map((label) => labelToken(label.name))
  if (labels.includes(labelToken(statusLabels.blocked))) return TICKET_STATUS.blocked
  if (labels.includes(labelToken(statusLabels.inProgress))) return TICKET_STATUS.inProgress
  return TICKET_STATUS.open
}

/** The date part of an ISO timestamp; anything else is passed through for the board to show raw. */
function calendarDay(updatedAt: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(updatedAt)
  return match ? match[1] : updatedAt
}

/**
 * The projection of an issue onto the source-neutral card. `blockedBy` is deliberately never set:
 * `blocked_by` names siblings in the same source, and GitHub expresses blocking as a label and as
 * prose, neither of which is a card id.
 */
export function githubIssueCard(
  issue: GithubIssueRecord,
  statusLabels: GithubStatusLabels = DEFAULT_GITHUB_STATUS_LABELS
): TicketCard {
  return {
    sourceId: TICKET_GITHUB_SOURCE_ID,
    id: String(issue.number),
    title: issue.title,
    status: githubIssueStatus(issue, statusLabels),
    updated: calendarDay(issue.updatedAt),
    ...(issue.body ? { body: issue.body } : {}),
    ...(issue.url ? { url: issue.url } : {})
  }
}

function isGithubIssueRecord(value: unknown): value is GithubIssueRecord {
  if (!value || typeof value !== 'object') return false
  const issue = value as Partial<GithubIssueRecord>
  return (
    typeof issue.number === 'number' &&
    typeof issue.title === 'string' &&
    typeof issue.state === 'string' &&
    typeof issue.updatedAt === 'string' &&
    (issue.labels === undefined ||
      (Array.isArray(issue.labels) && issue.labels.every((label) => typeof label?.name === 'string'))) &&
    (issue.url === undefined || typeof issue.url === 'string') &&
    (issue.body === undefined || typeof issue.body === 'string')
  )
}

/**
 * `gh`'s stdout as cards. A record Toucan cannot read is a diagnostic row on the board, exactly as
 * a malformed ticket file is: the board's promise is that nothing it was told about disappears.
 */
export function parseGithubIssues(
  stdout: string,
  statusLabels: GithubStatusLabels = DEFAULT_GITHUB_STATUS_LABELS
): TicketSourceListResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    return {
      cards: [],
      diagnostics: [{ path: 'gh issue list', code: 'unreadable-issues', message: errorMessage(error) }]
    }
  }
  if (!Array.isArray(parsed)) {
    return {
      cards: [],
      diagnostics: [{ path: 'gh issue list', code: 'unreadable-issues', message: 'Expected a list of issues.' }]
    }
  }
  const cards: TicketCard[] = []
  const diagnostics: TicketDiagnostic[] = []
  parsed.forEach((record, index) => {
    if (isGithubIssueRecord(record)) cards.push(githubIssueCard(record, statusLabels))
    else
      diagnostics.push({
        path: `gh issue list[${index}]`,
        code: 'malformed-issue',
        message: 'The issue is missing a number, title, state or updatedAt.'
      })
  })
  return { cards, diagnostics }
}

const GITHUB_REMOTE = /(?:https?:\/\/|ssh:\/\/)?(?:[^@\s/]+@)?github\.com[/:]([^\s/]+)\/([^\s/]+?)(?:\.git)?$/i

/**
 * The `owner/name` of the first GitHub remote in `git remote -v` output, `origin` preferred, or
 * `null` for a checkout that lives somewhere else. Detecting this ourselves - rather than letting
 * `gh` fail - is what lets the board say *why* a project has no GitHub source without launching a
 * second tool, and keeps a non-GitHub project from paying for an issue listing at all.
 */
export function githubRemoteRepository(remotes: string): string | null {
  let fallback: string | null = null
  for (const line of remotes.split(/\r?\n/)) {
    const [name, url] = line.trim().split(/\s+/)
    if (!name || !url) continue
    const match = GITHUB_REMOTE.exec(url)
    if (!match) continue
    const repository = `${match[1]}/${match[2]}`
    if (name === 'origin') return repository
    fallback ??= repository
  }
  return fallback
}
