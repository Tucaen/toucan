import type { ConversationTitle, ConversationTitleSource } from './conversation-title'

export type ConversationProvider = 'claude' | 'codex'

export interface ConversationSummary {
  /** The provider's own conversation ID - what `launchMode: 'resume'` is handed. */
  id: string
  provider: ConversationProvider
  /** Absolute path of the transcript, so a later open can verify it still exists. */
  path: string
  /** The agent's own title when it recorded one, else an excerpt of the first user message. */
  title: string
  /** Durable Toucan metadata when present; provider transcript titles count as generated. */
  titleSource?: ConversationTitleSource
  /** ISO timestamp of the last recorded turn, falling back to the file's mtime. */
  updatedAt: string
  /** User and assistant turns only; tool calls, meta records and sidechains are not counted. */
  messageCount: number
  /** The directory the conversation ran in: a project checkout or one of its worktrees. */
  cwd: string
}

export interface ConversationListRequest {
  /**
   * Directories whose transcripts to list - a project checkout plus any worktrees of it.
   * Both providers key their on-disk transcripts by working directory, so this is the filter.
   */
  directories: string[]
  /** How many summaries to parse for this page. Everything outside it stays unread. */
  limit?: number
  offset?: number
}

export interface ConversationListPage {
  entries: ConversationSummary[]
  /** Candidate transcripts matching the request, including the ones this page did not read. */
  total: number
  hasMore: boolean
}

/** What an unanswerable listing request gets: a page shaped like every other, holding nothing. */
export const EMPTY_CONVERSATION_PAGE: ConversationListPage = { entries: [], total: 0, hasMore: false }

export interface ConversationApi {
  /** Past conversations for the given directories, newest first and read one page at a time. */
  list(request: ConversationListRequest): Promise<ConversationListPage>
  /** Whether a listed transcript is still on disk. */
  exists(path: string): Promise<boolean>
  setTitle(
    provider: ConversationProvider,
    conversationId: string,
    title: string,
    source: ConversationTitleSource
  ): Promise<ConversationTitle | null>
}
