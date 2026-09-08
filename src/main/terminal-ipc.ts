import type { TerminalCreateRequest } from '../shared/terminal'
import { TERMINAL_CHANNELS } from '../shared/ipc-channels'
import type { IpcEventRegistrar } from './ipc-registrar'
import type { SessionProviders } from './session-providers'
import type { TerminalEventOwner } from './terminal-events'
import type { TerminalLivenessStore } from './terminal-liveness-store'
import type { TerminalManager } from './terminal-manager'
import type { TerminalScrollbackStore } from './terminal-scrollback-store'

/**
 * The renderer's route to plain terminals and their retained history. Electron-free, like
 * `ticket-ipc.ts`, so the wiring - especially the two-store retirement below - runs under tests.
 */
export function registerTerminalIpc(
  ipc: IpcEventRegistrar<TerminalEventOwner>,
  manager: TerminalManager,
  providers: SessionProviders,
  scrollback: TerminalScrollbackStore,
  liveness: TerminalLivenessStore
): void {
  ipc.handle(TERMINAL_CHANNELS.preview, (_event, kind: unknown, conversationId: unknown) => {
    if ((kind !== 'claude' && kind !== 'codex') || typeof conversationId !== 'string') return null
    return providers.getConversationPreview(kind, conversationId)
  })
  ipc.handle(TERMINAL_CHANNELS.create, (event, request) =>
    manager.create(request as TerminalCreateRequest, event.sender)
  )
  ipc.on(
    TERMINAL_CHANNELS.write,
    (_event, sessionId, incarnationId, data) =>
      void manager.write(sessionId as string, incarnationId as string, data as string)
  )
  ipc.on(
    TERMINAL_CHANNELS.resize,
    (_event, sessionId, incarnationId, cols, rows) =>
      void manager.resize(sessionId as string, incarnationId as string, cols as number, rows as number)
  )
  ipc.on(
    TERMINAL_CHANNELS.kill,
    (_event, sessionId, incarnationId, attachmentId) =>
      void manager.kill(sessionId as string, incarnationId as string, attachmentId as string)
  )
  ipc.handle(TERMINAL_CHANNELS.scrollback, (_event, sessionId: unknown) =>
    typeof sessionId === 'string' ? scrollback.load(sessionId) : null
  )
  // Removing a canvas node retires its durable session outright, so the process verdict goes with
  // the retained output. Keeping it would leave a verdict about a session nothing can reach.
  ipc.handle(TERMINAL_CHANNELS.scrollbackRemove, (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return false
    liveness.remove(sessionId)
    return scrollback.remove(sessionId)
  })
}
