import type { TerminalCreateRequest } from '../shared/terminal'
import { TERMINAL_CHANNELS } from '../shared/ipc-channels'
import type { IpcEventRegistrar } from './ipc-registrar'
import type { TerminalEventOwner } from './terminal-events'
import type { TerminalLivenessStore } from './terminal-liveness-store'
import type { TerminalManager } from './terminal-manager'
import type { TerminalScrollbackStore } from './terminal-scrollback-store'
import type { WorkspaceContainment } from './workspace-containment'
import { isRecord, isString, optionalString, isTerminalSize } from './ipc-validation'

export function isTerminalCreateRequest(value: unknown): value is TerminalCreateRequest {
  return (
    isRecord(value) &&
    isString(value.id) &&
    value.kind === 'terminal' &&
    isString(value.cwd) &&
    isTerminalSize(value.cols, value.rows) &&
    optionalString(value.sessionId) &&
    optionalString(value.attachmentId) &&
    (value.initialInput === undefined || typeof value.initialInput === 'string')
  )
}

/**
 * The renderer's route to plain terminals and their retained history. Electron-free, like
 * `ticket-ipc.ts`, so the wiring - especially the two-store retirement below - runs under tests.
 */
export function registerTerminalIpc(
  ipc: IpcEventRegistrar<TerminalEventOwner>,
  manager: TerminalManager,
  scrollback: TerminalScrollbackStore,
  liveness: TerminalLivenessStore,
  containment: Pick<WorkspaceContainment, 'contains'>
): void {
  ipc.handle(TERMINAL_CHANNELS.create, async (event, request) => {
    if (!isTerminalCreateRequest(request) || !(await containment.contains(request.cwd)))
      return { ok: false, message: 'Invalid terminal request or directory outside the workspace.' }
    return manager.create(request, event.sender)
  })
  ipc.on(TERMINAL_CHANNELS.write, (_event, sessionId, incarnationId, data) => {
    if (isString(sessionId) && isString(incarnationId) && typeof data === 'string')
      manager.write(sessionId, incarnationId, data)
  })
  ipc.on(TERMINAL_CHANNELS.resize, (_event, sessionId, incarnationId, cols, rows) => {
    if (isString(sessionId) && isString(incarnationId) && isTerminalSize(cols, rows))
      manager.resize(sessionId, incarnationId, cols as number, rows as number)
  })
  ipc.on(TERMINAL_CHANNELS.kill, (_event, sessionId, incarnationId, attachmentId) => {
    if (isString(sessionId) && isString(incarnationId) && isString(attachmentId))
      manager.kill(sessionId, incarnationId, attachmentId)
  })
  ipc.handle(TERMINAL_CHANNELS.scrollback, (_event, sessionId: unknown) =>
    typeof sessionId === 'string' ? scrollback.load(sessionId) : null
  )
  // Removing a canvas node retires its durable session outright, so the process verdict goes with
  // the retained output. Keeping it would leave a verdict about a session nothing can reach.
  ipc.handle(TERMINAL_CHANNELS.scrollbackRemove, (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return false
    liveness.remove(sessionId)
    // The retained tail an agent could read goes the same way, and with it every read cursor: a
    // session nothing can reach must not stay readable through a terminal-context edge.
    manager.forgetSession(sessionId)
    return scrollback.remove(sessionId)
  })
}
