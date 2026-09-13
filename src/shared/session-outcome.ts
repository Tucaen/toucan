import { isFinalAssistantMessage, type AgentTurnOutcome } from './agent'
import type { AgentTranscriptState } from './agent-transcript'
import type { ConversationProvider } from './conversation'
import { generatedConversationTitle } from './conversation-title'
import { parseFrontmatter } from './frontmatter'

/**
 * The session outcome index's record: one compact Markdown file per conversation, describing what
 * that conversation is about and where it stands. Everything here is pure *extraction* from the
 * transcript snapshot main already keeps - no model call, no provider round-trip - which is the
 * whole reason the index costs nothing to maintain (see `docs/plans/session-outcome-index.md`,
 * and `conversation-title.ts` for the same zero-token bias).
 *
 * Its counterpart constraint is the read: the index only pays for itself if an agent can grep a
 * few hundred of these into one context window, so the excerpts are hard-capped here rather than
 * wherever a record happens to be written, and the frontmatter stays a flat handful of fields.
 */

/** Hard cap on each excerpt. Two of them plus the frontmatter keep a typical record well under 2 KB. */
export const SESSION_OUTCOME_EXCERPT_LIMIT = 600

/** Hard cap on the title, matching what `deriveConversationTitle` already produces. */
export const SESSION_OUTCOME_TITLE_LIMIT = 72

/**
 * How many written files a record keeps, newest last. The write set is the one field that is
 * accumulated rather than re-derived, so it is also the one that could grow without bound - a
 * refactor touching three hundred files would otherwise cost every other record's share of the
 * reader's context window. The most recent writes are kept because they are the ones a later
 * session is likely asking about.
 */
export const SESSION_OUTCOME_FILES_LIMIT = 24

/**
 * Hard cap on one path. Long enough for a real repo-relative path, short enough to bound the list.
 * A path clipped by it keeps its ellipsis when the record is read back, so a later process writing
 * the same absurdly long file records it a second time rather than deduping against the clip - one
 * wasted slot out of `SESSION_OUTCOME_FILES_LIMIT`, which is cheaper than a cap a record escapes.
 */
export const SESSION_OUTCOME_PATH_LIMIT = 100

/** How many failed or cancelled turns a record keeps, newest last. */
export const SESSION_OUTCOME_FAILURE_LIMIT = 3

/** Hard cap on a failure message: enough to recognise the failure, not enough to paste a stack. */
export const SESSION_OUTCOME_FAILURE_MESSAGE_LIMIT = 160

/**
 * The ceiling every cap above is chosen against: a record filled to all of them still renders
 * under this, so "a few hundred records fit one context window" stays true for the worst case and
 * not just the typical one. `tests/session-outcome.test.ts` holds it honest.
 */
export const SESSION_OUTCOME_SIZE_BUDGET = 5120

/**
 * Where a conversation stands. `active` is not a claim that a session is running right now - a
 * dormant node gets resumed and keeps going - only that no end has been observed; the end is
 * observed when the session's channel is retired, and it is `completed` only when the last turn
 * both finished cleanly and left a final answer behind.
 */
export type SessionOutcomeStatus = 'active' | 'completed' | 'abandoned'

/** Which turn boundary a session ended on - the one input `status` is derived from. */
export type SessionOutcomeEnding = 'complete' | 'failed' | 'cancelled'

export interface SessionOutcomeRecord {
  /** Provider plus conversation id, filename-safe: conversations outlive the canvas nodes running them. */
  key: string
  provider: ConversationProvider
  conversationId: string
  /** The directory the session runs in - a project checkout, or a worktree of one. */
  projectPath: string
  /** The worktree this conversation's node is attached to, where it is attached to one. */
  worktreeId?: string
  title: string
  /** What the conversation was first asked to do. */
  task: string
  /** What the agent reported at the most recent turn boundary; empty when it reported nothing. */
  lastResult: string
  /**
   * How many times the conversation was asked for something, counted as the user messages the
   * transcript carries. Deliberately derived rather than accumulated, so a resumed conversation
   * re-derives the same number instead of double-counting its own replay - the cost is that a
   * follow-up steered into a running turn counts as an ask of its own, which for a "how big was
   * this conversation" field is the more useful reading anyway.
   */
  turns: number
  /**
   * Every file this conversation's tool calls reported writing, newest last, deduped and capped.
   * The one accumulated field: the capture site feeds it what it has seen since the process
   * started and the previous record contributes the rest, because a conversation outlives the
   * process running it. Reads and searches are never in here - having looked at a file is not
   * having produced it (`isFileWritingToolKind`).
   */
  filesTouched: string[]
  /** Failed and cancelled turns, newest last, in the transcript's own turn-outcome shape. */
  failures: AgentTurnOutcome[]
  status: SessionOutcomeStatus
  startedAt: string
  updatedAt: string
}

/** What the capture site knows about the conversation beyond its transcript. */
export interface SessionOutcomeSource {
  provider: ConversationProvider
  conversationId: string
  projectPath: string
  worktreeId?: string
  /**
   * Files written since this process started watching the session, newest last. Accumulated by the
   * indexer at the tool-call seam rather than read off the session's bounded `recentWrites` ring,
   * which drops writes long before a long session ends.
   */
  filesTouched?: readonly string[]
  /**
   * The durable title, where the conversation has one. Supplied rather than derived so the record
   * names the conversation the way every other surface does, manual renames included; the
   * transcript's own derivation is only the fallback until a title has settled.
   */
  title?: string
}

const UNSAFE_KEY_CHARACTER = /[^A-Za-z0-9_-]+/g

/**
 * A filename that cannot escape its directory whatever a provider mints as a conversation id.
 * Deliberately lossy - two ids differing only in stripped characters would collide - which is
 * acceptable because both providers issue UUID-shaped ids and a collision costs one record.
 */
export function sessionOutcomeKey(provider: ConversationProvider, conversationId: string): string {
  return `${provider}-${conversationId.replace(UNSAFE_KEY_CHARACTER, '-').slice(0, 120)}`
}

/**
 * One line of prose, capped. Newlines collapse because frontmatter is line-oriented and a body
 * excerpt that reproduced a whole tool transcript would defeat the retrieval budget.
 */
export function sessionOutcomeExcerpt(text: string, limit = SESSION_OUTCOME_EXCERPT_LIMIT): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= limit) return collapsed
  // The ellipsis is part of what is written, so it comes out of the budget rather than being
  // added past it - a cap a record can exceed by a character is not a cap.
  const clipped = collapsed.slice(0, limit - 1)
  const boundary = clipped.lastIndexOf(' ')
  return `${(boundary >= limit / 2 ? clipped.slice(0, boundary) : clipped).trimEnd()}…`
}

function firstUserText(snapshot: AgentTranscriptState): string {
  for (const message of snapshot.messages) if (message.role === 'user' && message.text.trim()) return message.text
  return ''
}

/**
 * The agent's own last word. A completed turn promotes its closing message to `final`, so that is
 * the answer wherever there is one; a failed or cancelled turn may leave only progress behind,
 * and reporting that is still better than reporting nothing.
 */
function lastAssistantText(snapshot: AgentTranscriptState): string {
  let progress = ''
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index]
    if (message.role !== 'assistant' || !message.text.trim()) continue
    if (isFinalAssistantMessage(message)) return message.text
    if (!progress) progress = message.text
  }
  return progress
}

/**
 * Whether the conversation's *latest* ask was answered: a final assistant message after the last
 * user message. Scoped to the latest ask rather than the transcript as a whole, because that is
 * the question `status` turns on - a session whose first turn answered and whose last one closed
 * with nothing to say has left its captain without an answer, and reporting it `completed` would
 * be the index lying about the one thing a later reader is asking it.
 */
export function answeredLatestAsk(snapshot: AgentTranscriptState): boolean {
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index]
    if (message.role === 'user') return false
    if (isFinalAssistantMessage(message) && message.text.trim()) return true
  }
  return false
}

/**
 * The write set, newest last: deduped, each path capped, the whole list capped. The one place
 * that rule lives, so the indexer accumulating a session's writes and the record merging them with
 * what a previous process wrote bound the set identically rather than twice.
 *
 * Walked backwards so a file written repeatedly keeps its *latest* position before the cap is
 * applied - a session that rewrote one file forty times must not push everything else out with
 * forty copies of the same entry.
 */
export function sessionOutcomeFiles(paths: readonly string[]): string[] {
  const newestFirst: string[] = []
  const seen = new Set<string>()
  for (let index = paths.length - 1; index >= 0 && newestFirst.length < SESSION_OUTCOME_FILES_LIMIT; index -= 1) {
    // Deduped on the path itself and clipped only afterwards: two deep files sharing a long prefix
    // are two files, and collapsing them because their first hundred characters match would make
    // the record claim one of them was never written.
    const path = paths[index]
    if (!path || seen.has(path)) continue
    seen.add(path)
    newestFirst.push(sessionOutcomeExcerpt(path, SESSION_OUTCOME_PATH_LIMIT))
  }
  return newestFirst.reverse()
}

function boundedFailures(outcomes: readonly AgentTurnOutcome[]): AgentTurnOutcome[] {
  return outcomes.slice(-SESSION_OUTCOME_FAILURE_LIMIT).map((outcome) => ({
    id: outcome.id,
    status: outcome.status,
    message: sessionOutcomeExcerpt(outcome.message, SESSION_OUTCOME_FAILURE_MESSAGE_LIMIT)
  }))
}

/**
 * The record a retired session leaves behind: the one it already wrote, with its status settled.
 * Deliberately a transition on the existing record rather than another extraction, so finalizing
 * needs neither the transcript nor the async lookups a capture does - which is what lets it run
 * synchronously at `before-quit`, where nothing that awaits will ever finish.
 *
 * A session is only `completed` if its last turn both finished cleanly *and* answered: an adapter
 * that exits after a turn it never answered has abandoned the conversation just as surely as one
 * whose last turn failed outright.
 */
export function endedSessionOutcome(
  record: SessionOutcomeRecord,
  ending: SessionOutcomeEnding,
  answered: boolean,
  now: string
): SessionOutcomeRecord {
  const status: SessionOutcomeStatus = ending === 'complete' && answered ? 'completed' : 'abandoned'
  return { ...record, status, updatedAt: now }
}

/**
 * The record this snapshot describes, or `null` when there is nothing worth writing down yet - a
 * conversation with no user message has not been asked anything. `previous` is the record already
 * on disk: only `startedAt` and the write set are carried over from it, so a record is otherwise
 * re-derived in full at every turn boundary and cannot drift from the transcript it describes.
 * The write set is the deliberate exception - no transcript snapshot reports what a process that
 * has already exited wrote, so the only place that history survives is the record itself.
 */
export function extractSessionOutcome(
  snapshot: AgentTranscriptState,
  source: SessionOutcomeSource,
  previous: SessionOutcomeRecord | null,
  now: string
): SessionOutcomeRecord | null {
  const task = sessionOutcomeExcerpt(firstUserText(snapshot))
  if (!task) return null
  const title = source.title ?? generatedConversationTitle(snapshot.messages)
  return {
    key: sessionOutcomeKey(source.provider, source.conversationId),
    provider: source.provider,
    conversationId: source.conversationId,
    projectPath: source.projectPath,
    ...(source.worktreeId ? { worktreeId: source.worktreeId } : {}),
    title: sessionOutcomeExcerpt(title ?? task, SESSION_OUTCOME_TITLE_LIMIT),
    task,
    lastResult: sessionOutcomeExcerpt(lastAssistantText(snapshot)),
    turns: snapshot.messages.filter((message) => message.role === 'user').length,
    filesTouched: sessionOutcomeFiles([...(previous?.filesTouched ?? []), ...(source.filesTouched ?? [])]),
    failures: boundedFailures(snapshot.outcomes),
    // Always `active`: a turn landing is the proof a conversation is still going, and a session
    // that has ended settles its status through `endedSessionOutcome` instead.
    status: 'active',
    startedAt: previous?.startedAt ?? now,
    updatedAt: now
  }
}

/**
 * Frontmatter is a flat `key: value` block (see `frontmatter.ts`), so a Windows path - which
 * carries backslashes and may carry spaces - is written JSON-quoted, exactly as brain-dump topics
 * write theirs.
 */
function decodePath(value: string): string {
  if (!value.startsWith('"')) return value
  try {
    const decoded: unknown = JSON.parse(value)
    return typeof decoded === 'string' ? decoded : value
  } catch {
    return value
  }
}

export function renderSessionOutcome(record: SessionOutcomeRecord): string {
  return [
    '---',
    `key: ${record.key}`,
    `provider: ${record.provider}`,
    `conversation: ${record.conversationId}`,
    `project: ${JSON.stringify(record.projectPath)}`,
    ...(record.worktreeId ? [`worktree: ${record.worktreeId}`] : []),
    `title: ${record.title}`,
    `status: ${record.status}`,
    `turns: ${record.turns}`,
    `started: ${record.startedAt}`,
    `updated: ${record.updatedAt}`,
    '---',
    '',
    '## Task',
    '',
    record.task,
    '',
    '## Last result',
    '',
    record.lastResult,
    '',
    // Both lists are omitted entirely when empty: a record for a conversation that wrote nothing
    // and failed nowhere should not spend the reader's budget saying so twice.
    ...(record.filesTouched.length ? ['## Files', '', ...record.filesTouched.map((path) => `- ${path}`), ''] : []),
    ...(record.failures.length
      ? ['## Failures', '', ...record.failures.map((failure) => renderFailure(failure)), '']
      : [])
  ].join('\n')
}

function renderFailure(failure: AgentTurnOutcome): string {
  const line = `- ${failure.status} (${failure.id}):`
  return failure.message ? `${line} ${failure.message}` : line
}

/**
 * A failure line, read back the way it was written. The turn id is delimited by the first `)`, so
 * a provider that ever mints an id containing one would round-trip lossily - which costs a record
 * one failure entry at the next capture, since failures are re-derived from the transcript anyway.
 */
const FAILURE_LINE = /^- (failed|cancelled) \(([^)]*)\):\s?(.*)$/

function listItems(body: string, heading: string): string[] {
  return section(body, heading)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
}

function section(body: string, heading: string): string {
  const match = new RegExp(`^## ${heading}\\s*$`, 'm').exec(body)
  if (!match) return ''
  const rest = body.slice(match.index + match[0].length)
  const next = /^## /m.exec(rest)
  return (next ? rest.slice(0, next.index) : rest).trim()
}

/**
 * Reads a record back. Only the writer's own output has to round-trip: a record edited into an
 * unreadable shape is discarded and rewritten from the transcript at the next turn boundary,
 * which costs the original `startedAt` and nothing else.
 */
export function parseSessionOutcome(markdown: string): SessionOutcomeRecord | null {
  const parsed = parseFrontmatter(markdown, 'Session outcome')
  if (!parsed.ok) return null
  const { fields, body } = parsed
  const provider = fields.get('provider')
  const conversationId = fields.get('conversation')
  const project = fields.get('project')
  const turns = Number(fields.get('turns'))
  const startedAt = fields.get('started')
  const updatedAt = fields.get('updated')
  if ((provider !== 'claude' && provider !== 'codex') || !conversationId || !project) return null
  if (!Number.isInteger(turns) || turns < 0 || !startedAt || !updatedAt) return null
  const worktreeId = fields.get('worktree')
  const status = fields.get('status')
  const failures: AgentTurnOutcome[] = []
  for (const item of listItems(body, 'Failures')) {
    const match = FAILURE_LINE.exec(item)
    if (match)
      failures.push({ id: match[2], status: match[1] === 'failed' ? 'failed' : 'cancelled', message: match[3] })
  }
  return {
    key: fields.get('key') || sessionOutcomeKey(provider, conversationId),
    provider,
    conversationId,
    projectPath: decodePath(project),
    ...(worktreeId ? { worktreeId } : {}),
    title: fields.get('title') ?? '',
    task: section(body, 'Task'),
    lastResult: section(body, 'Last result'),
    turns,
    filesTouched: listItems(body, 'Files').map((item) => item.slice(2)),
    failures,
    // An unrecognised status reads as `active`: the next turn boundary re-derives it, and the one
    // thing a reader must never conclude from a damaged field is that a session is finished.
    status: status === 'completed' || status === 'abandoned' ? status : 'active',
    startedAt,
    updatedAt
  }
}
