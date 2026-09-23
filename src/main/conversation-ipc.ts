import { EMPTY_CONVERSATION_PAGE, type ConversationListRequest } from '../shared/conversation'
import { CONVERSATION_CHANNELS } from '../shared/ipc-channels'
import type { ConversationHistory } from './conversation-history'
import type { ConversationLineageStore } from './conversation-lineage-store'
import type { ConversationTitleStore } from './conversation-title-store'
import type { IpcRegistrar } from './ipc-registrar'
import type { WorkspaceContainment } from './workspace-containment'

/**
 * The renderer's route to past conversations and their durable titles. Every argument is shape-
 * checked here, so a malformed request becomes an empty page or a null verdict rather than a
 * rejected promise the history dialog would have to defend against.
 */
export function registerConversationIpc(
  ipc: IpcRegistrar,
  history: ConversationHistory,
  titles: ConversationTitleStore,
  lineage: ConversationLineageStore,
  containment: Pick<WorkspaceContainment, 'contains'>
): void {
  ipc.handle(CONVERSATION_CHANNELS.list, async (_event, request: unknown) => {
    const directories = (request as ConversationListRequest | undefined)?.directories
    if (!Array.isArray(directories) || directories.some((entry) => typeof entry !== 'string')) {
      return EMPTY_CONVERSATION_PAGE
    }
    const { limit, offset } = request as ConversationListRequest
    if (
      [limit, offset].some(
        (value) => value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      )
    )
      return EMPTY_CONVERSATION_PAGE
    for (const directory of directories) {
      if (!(await containment.contains(directory))) return EMPTY_CONVERSATION_PAGE
    }
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
  ipc.handle(
    CONVERSATION_CHANNELS.setForkedFrom,
    async (_event, provider: unknown, id: unknown, parentId: unknown): Promise<boolean> => {
      if (provider !== 'claude' && provider !== 'codex') return false
      if (typeof id !== 'string' || !id || typeof parentId !== 'string' || !parentId) return false
      await lineage.setForkedFrom(provider, id, parentId)
      return true
    }
  )
}
