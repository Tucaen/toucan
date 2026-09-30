import { REMOTE_CHANNELS } from '../../shared/ipc-channels'
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
  /**
   * Tells the desktop a paired reader reached this chat's content. Fire-and-forget by design: with
   * no window attached there is nobody whose attention records this could clear, and an error the
   * phone cannot act on would be worse than the badge it will see cleared on the next projection.
   */
  markRead(chatId: string): void
  /**
   * Registers the window that performs these requests and returns a disposer. The most recently
   * attached live window wins, so a reopened window takes over from a destroyed one without a
   * restart.
   */
  attach(window: DesktopWindow): () => void
  /** The renderer's answer to a spawn, routed in from IPC. Unknown ids are ignored: a late reply is not news. */
  complete(requestId: string, result: RemoteChatSpawnResult): void
}

export interface RemoteCanvasRequestsOptions {
  /**
   * How long the renderer has to bring a session up. Generous, because starting an agent means
   * launching a CLI - but bounded, because an HTTP request that never answers is worse than a
   * refusal the reader can retry.
   */
  timeoutMs?: number
  requestId?: () => string
  /** Injectable so tests do not wait in real time. */
  schedule?: (run: () => void, delayMs: number) => { cancel(): void }
}

const DEFAULT_TIMEOUT_MS = 45_000

export function createRemoteCanvasRequests(options: RemoteCanvasRequestsOptions = {}): RemoteCanvasRequests {
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

  return {
    spawn: (request) => spawns.request(request),
    markRead(chatId): void {
      spawns.liveWindow()?.send(REMOTE_CHANNELS.markChatRead, chatId)
    },
    attach: (window) => spawns.attach(window),
    complete: (requestId, result) => spawns.complete(requestId, result)
  }
}
