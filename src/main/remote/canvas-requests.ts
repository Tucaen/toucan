import { randomUUID } from 'node:crypto'
import { REMOTE_CHANNELS } from '../../shared/ipc-channels'
import type { RemoteChatSpawnRequest, RemoteChatSpawnResult } from '../../shared/remote-spawn'

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
 * from). A read is told - it is idempotent, it retires a badge the canvas republishes in the very
 * projection the phone polls, and a lost one costs a redundant frame later rather than a wrong
 * answer now.
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

/** The slice of `WebContents` this needs, so tests do not have to build an Electron window. */
export interface DesktopWindow {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
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

const NO_WINDOW_MESSAGE = 'Toucan is not open on the desktop, so there is nothing to start the chat in.'
const WINDOW_GONE_MESSAGE = 'The Toucan window closed before the chat was started.'
/**
 * Said carefully. The node is on the canvas by this point - the renderer added it and is still
 * waiting on its session - so claiming nothing happened would be the lie. What the phone is told
 * is what is true: this request is over, and the chat may yet appear in the list.
 */
const TIMEOUT_MESSAGE = 'The desktop did not finish starting the chat in time. It may still appear in your chat list.'

export function createRemoteCanvasRequests(options: RemoteCanvasRequestsOptions = {}): RemoteCanvasRequests {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const newRequestId = options.requestId ?? (() => randomUUID())
  const schedule =
    options.schedule ??
    ((run, delayMs) => {
      const timer = setTimeout(run, delayMs)
      return { cancel: () => clearTimeout(timer) }
    })

  const windows: DesktopWindow[] = []
  const pending = new Map<string, { window: DesktopWindow; settle(result: RemoteChatSpawnResult): void }>()

  const liveWindow = (): DesktopWindow | null => {
    // Destroyed windows are dropped on the way past rather than swept on a timer: this list is
    // read once per request, which is exactly when its staleness starts to matter.
    while (windows.length > 0) {
      const candidate = windows[windows.length - 1]
      if (!candidate.isDestroyed()) return candidate
      windows.pop()
    }
    return null
  }

  const failPending = (window: DesktopWindow, message: string): void => {
    for (const [id, entry] of [...pending]) {
      if (entry.window === window) {
        pending.delete(id)
        entry.settle({ ok: false, message })
      }
    }
  }

  return {
    spawn(request): Promise<RemoteChatSpawnResult> {
      const window = liveWindow()
      if (!window) return Promise.resolve({ ok: false, message: NO_WINDOW_MESSAGE })

      const requestId = newRequestId()
      return new Promise<RemoteChatSpawnResult>((resolve) => {
        const timer = schedule(() => {
          if (!pending.delete(requestId)) return
          resolve({ ok: false, message: TIMEOUT_MESSAGE })
        }, timeoutMs)
        pending.set(requestId, {
          window,
          settle: (result) => {
            timer.cancel()
            resolve(result)
          }
        })
        window.send(REMOTE_CHANNELS.spawnChat, requestId, request)
      })
    },
    markRead(chatId): void {
      liveWindow()?.send(REMOTE_CHANNELS.markChatRead, chatId)
    },
    attach(window): () => void {
      windows.push(window)
      return () => {
        const index = windows.indexOf(window)
        if (index !== -1) windows.splice(index, 1)
        // A window that goes away mid-spawn will never answer, and its caller is holding an open
        // HTTP request, so the refusal is issued here rather than left to the timeout.
        failPending(window, WINDOW_GONE_MESSAGE)
      }
    },
    complete(requestId, result): void {
      const entry = pending.get(requestId)
      if (!entry) return
      pending.delete(requestId)
      entry.settle(result)
    }
  }
}
