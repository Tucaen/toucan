import { EMPTY_CONVERSATION_PAGE, type ConversationListRequest } from '../shared/conversation'
import { CONVERSATION_CHANNELS } from '../shared/ipc-channels'
import type { ConversationHistory } from './conversation-history'
import type { ConversationTitleStore } from './conversation-title-store'
import type { IpcRegistrar } from './ipc-registrar'

/**
 * The renderer's route to past conversations and their durable titles. Every argument is shape-
 * checked here, so a malformed request becomes an empty page or a null verdict rather than a
 * rejected promise the history dialog would have to defend against.
 */
export function registerConversationIpc(
  ipc: IpcRegistrar,
  history: ConversationHistory,
  titles: ConversationTitleStore
): void {
  ipc.handle(CONVERSATION_CHANNELS.list, (_event, request: unknown) => {
    const directories = (request as ConversationListRequest | undefined)?.directories
    if (!Array.isArray(directories) || directories.some((entry) => typeof entry !== 'string')) {
      return EMPTY_CONVERSATION_PAGE
    }
    const { limit, offset } = request as ConversationListRequest
    return history.list({ directories, limit, offset })
  })
  // A transcript the user can see in the list may already be gone; opening one asks first so
  // the browser can say so instead of launching a resume that cannot find its conversation.
  ipc.handle(CONVERSATION_CHANNELS.exists, (_event, path: unknown) =>
    typeof path === 'string' ? history.exists(path) : Promise.resolve(false)
  )
  ipc.handle(
    CONVERSATION_CHANNELS.setTitle,
    (_event, provider: unknown, id: unknown, title: unknown, source: unknown) => {
      if ((provider !== 'claude' && provider !== 'codex') || typeof id !== 'string' || typeof title !== 'string')
        return null
      if (source !== 'generated' && source !== 'manual') return null
      return titles.set(provider, id, title, source)
    }
  )
}
