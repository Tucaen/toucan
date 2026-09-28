import type { AgentProvider } from '../../shared/agent-provider'
import type { WorktreeCreateRequest, WorktreeCreateResult } from '../../shared/worktree'

/**
 * "New worktree" as one action: git creates the checkout, the canvas registers it, and one
 * ordinary chat opens in it on the provider the dialog chose. The provider is the session's, not
 * the worktree's - it never reaches git, and later chats in the same worktree may use another.
 *
 * The three steps are injected so the ordering rules live here, apart from React and IPC:
 *
 * - Nothing is registered and no chat starts until git has said yes, so a refused creation leaves
 *   no phantom node behind.
 * - A worktree git created is registered before the chat is attempted and stays registered whatever
 *   the chat does. Retrying a chat is the worktree node's business from then on; the checkout is
 *   never created a second time.
 * - One submission at a time. The dialog's own `busy` flag only takes effect on the next render, so
 *   two submits in one tick would both pass it; this guard settles synchronously.
 */
export interface CreatedWorktree {
  path: string
  branch: string
  baseRef: string
}

export interface WorktreeCreationSteps<Worktree> {
  create(request: WorktreeCreateRequest): Promise<WorktreeCreateResult>
  /** Puts the created worktree on the canvas and returns the record a chat attaches to. */
  register(created: CreatedWorktree): Worktree
  /** Opens one ordinary chat in the worktree; the new node's id, or null when it refused. */
  startChat(worktree: Worktree, provider: AgentProvider): string | null
}

export interface WorktreeCreationRequest extends WorktreeCreateRequest {
  provider: AgentProvider
}

export type WorktreeCreationOutcome<Worktree> =
  | { status: 'failed'; message: string }
  | { status: 'created'; worktree: Worktree; chatId: string }
  /** Git created the checkout and it is registered, but its first chat did not open. */
  | { status: 'chat-failed'; worktree: Worktree; message: string }

export const WORKTREE_CREATE_FAILED = 'The worktree could not be created.'
export const WORKTREE_CHAT_FAILED = 'The chat could not be started.'

export interface WorktreeCreator<Worktree> {
  /** Null, doing nothing, while an earlier submission is still in flight. */
  submit(request: WorktreeCreationRequest): Promise<WorktreeCreationOutcome<Worktree>> | null
  pending(): boolean
}

export function createWorktreeCreator<Worktree>(steps: WorktreeCreationSteps<Worktree>): WorktreeCreator<Worktree> {
  let inFlight = false

  const run = async ({ provider, ...request }: WorktreeCreationRequest): Promise<WorktreeCreationOutcome<Worktree>> => {
    let result: WorktreeCreateResult
    try {
      result = await steps.create(request)
    } catch (error) {
      return { status: 'failed', message: errorMessage(error, WORKTREE_CREATE_FAILED) }
    }
    if (!result.ok || !result.worktree) return { status: 'failed', message: result.message ?? WORKTREE_CREATE_FAILED }

    const worktree = steps.register(result.worktree)
    try {
      const chatId = steps.startChat(worktree, provider)
      return chatId
        ? { status: 'created', worktree, chatId }
        : { status: 'chat-failed', worktree, message: WORKTREE_CHAT_FAILED }
    } catch (error) {
      return { status: 'chat-failed', worktree, message: errorMessage(error, WORKTREE_CHAT_FAILED) }
    }
  }

  return {
    submit(request) {
      if (inFlight) return null
      inFlight = true
      return run(request).finally(() => {
        inFlight = false
      })
    },
    pending: () => inFlight
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
