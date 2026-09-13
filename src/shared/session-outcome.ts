import { isFinalAssistantMessage } from './agent'
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
 * The record this snapshot describes, or `null` when there is nothing worth writing down yet - a
 * conversation with no user message has not been asked anything. `previous` is the record already
 * on disk: only `startedAt` is carried over from it, so a record is otherwise re-derived in full
 * at every turn boundary and cannot drift from the transcript it describes.
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
    ''
  ].join('\n')
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
    startedAt,
    updatedAt
  }
}
