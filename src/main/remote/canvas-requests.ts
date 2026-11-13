import { REMOTE_CHANNELS } from '../../shared/ipc-channels'
import type { RemoteChatCloseResult } from '../../shared/remote-close'
import type { HistoryRestoreRequest } from '../../shared/remote-history'
import type { RemoteChatSpawnRequest, RemoteChatSpawnResult } from '../../shared/remote-spawn'
import { createWindowRequests, type DesktopWindow } from '../window-requests'

export type { DesktopWindow }

/**
 * What a phone asks of the *canvas*, performed by the desktop renderer.
 *
 * Two of the phone's operations are not session operations at all. Node identity, geometry,
 * working-directory resolution and launch mode are the canvas's, and so is the attention record
 * set behind every unread badge - none of it reproducible in main without growing a second,
 * quietly diverging copy of the workspace. So both are *requests*: main asks the newest live
 * window to run its own path, and the window is the one authority that acts.
 *
 * They differ in exactly one way, which is why they share a module but not a shape. A spawn is
 * awaited - the phone navigates on the verdict, so every path out of `spawn` answers the caller
 * (no window, a window that goes away mid-spawn, a renderer that never replies each have their own
 * words, because "your chat is starting" followed by silence is the failure a phone cannot recover
 * from; the mechanics are `window-requests.ts`). A read is told - it is idempotent, it retires a
 * badge the canvas republishes in the very projection the phone polls, and a lost one costs a
 * redundant frame later rather than a wrong answer now.
 */
export interface RemoteCanvasRequests {
  /** The seam the remote server holds for spawning. Never rejects: a failure is `{ ok: false }`. */
  spawn(request: RemoteChatSpawnRequest): Promise<RemoteChatSpawnResult>
  openHistory(request: HistoryRestoreRequest): Promise<RemoteChatSpawnResult>
  completeOpenHistory(requestId: string, result: RemoteChatSpawnResult): void
  /**
   * Tells the desktop a paired reader reached this chat's content. Fire-and-forget by design: with
   * no window attached there is nobody whose attention records this could clear, and an error the
   * phone cannot act on would be worse than the badge it will see cleared on the next projection.
   */
  markRead(chatId: string): void
  /**
   * Asks the desktop to close this chat's node through the canvas's own remove path. Awaited like a
   * spawn, because the phone leaves the chat on the verdict. Never rejects.
   */
  close(chatId: string): Promise<RemoteChatCloseResult>
  /**
   * Registers the window that performs these requests and returns a disposer. The most recently
   * attached live window wins, so a reopened window takes over from a destroyed one without a
   * restart.
   */
  attach(window: DesktopWindow): () => void
  /** The renderer's answer to a spawn, routed in from IPC. Unknown ids are ignored: a late reply is not news. */
  complete(requestId: string, result: RemoteChatSpawnResult): void
  /** The renderer's answer to a close, routed in from IPC. Unknown ids are ignored. */
  completeClose(requestId: string, result: RemoteChatCloseResult): void
}

export interface RemoteCanvasRequestsOptions {
  /**
   * How long the renderer has to bring a session up. Generous, because starting an agent means
   * launching a CLI - but bounded, because an HTTP request that never answers is worse than a
   * refusal the reader can retry.
   */
  timeoutMs?: number
  /** How long the renderer has to remove a node it was asked to close. */
  closeTimeoutMs?: number
  requestId?: () => string
  /** Injectable so tests do not wait in real time. */
  schedule?: (run: () => void, delayMs: number) => { cancel(): void }
}

const DEFAULT_TIMEOUT_MS = 45_000
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000

export function createRemoteCanvasRequests(options: RemoteCanvasRequestsOptions = {}): RemoteCanvasRequests {
  const history = createWindowRequests<HistoryRestoreRequest, RemoteChatSpawnResult>({
    channel: REMOTE_CHANNELS.openHistory,
    messages: {
      noWindow: 'Toucan has no desktop window to restore this conversation in.',
      windowGone: 'The Toucan window closed while restoring the conversation.',
      timeout: 'The conversation is still opening. Retry this entry to navigate to the same chat.'
    },
    refuse: (message) => ({ ok: false, message }),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    requestId: options.requestId,
    schedule: options.schedule
  })
  const spawns = createWindowRequests<RemoteChatSpawnRequest, RemoteChatSpawnResult>({
    channel: REMOTE_CHANNELS.spawnChat,
    messages: {
      noWindow: 'Toucan is not open on the desktop, so there is nothing to start the chat in.',
      windowGone: 'The Toucan window closed before the chat was started.',
      /*
       * Said carefully. The node is on the canvas by this point - the renderer added it and is still
       * waiting on its session - so claiming nothing happened would be the lie. What the phone is
       * told is what is true: this request is over, and the chat may yet appear in the list.
       */
      timeout: 'The desktop did not finish starting the chat in time. It may still appear in your chat list.'
    },
    refuse: (message) => ({ ok: false, message }),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    requestId: options.requestId,
    schedule: options.schedule
  })

  // Removing a node is synchronous on the canvas, so the wait is short: a renderer that has not
  // answered in this long is not going to, and the phone should hear so rather than hang.
  const closes = createWindowRequests<string, RemoteChatCloseResult>({
    channel: REMOTE_CHANNELS.closeChat,
    messages: {
      noWindow: 'Toucan is not open on the desktop, so there is nothing to close the chat in.',
      windowGone: 'The Toucan window closed before the chat was closed.',
      timeout: 'The desktop did not confirm closing the chat in time. Check the chat list.'
    },
    refuse: (message) => ({ ok: false, message }),
    timeoutMs: options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
    requestId: options.requestId,
    schedule: options.schedule
  })

  return {
    openHistory: (request) => history.request(request),
    completeOpenHistory: (requestId, result) => history.complete(requestId, result),
    spawn: (request) => spawns.request(request),
    close: (chatId) => closes.request(chatId),
    markRead(chatId): void {
      spawns.liveWindow()?.send(REMOTE_CHANNELS.markChatRead, chatId)
    },
    attach: (window) => {
      const detachSpawns = spawns.attach(window)
      const detachCloses = closes.attach(window)
      const detachHistory = history.attach(window)
      return () => {
        detachSpawns()
        detachCloses()
        detachHistory()
      }
    },
    complete: (requestId, result) => spawns.complete(requestId, result),
    completeClose: (requestId, result) => closes.complete(requestId, result)
  }
}
