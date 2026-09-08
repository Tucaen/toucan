import { randomUUID } from 'node:crypto'
import { REMOTE_CHANNELS } from '../../shared/ipc-channels'
import type { RemoteChatSpawnRequest, RemoteChatSpawnResult } from '../../shared/remote-spawn'

/**
 * Starting a chat for a phone, performed by the desktop renderer.
 *
 * The canvas is the authority on node identity, geometry, working-directory resolution and launch
 * mode, and none of that is reproducible in main without growing a second, quietly diverging copy
 * of it. So a remote spawn is a *request*: main asks the window to run its own add-node path and
 * waits for the verdict. The renderer answers once the session it created is actually up, which is
 * what lets the HTTP route report an id only for a chat that exists.
 *
 * Every path out of here answers the caller. A desktop with no window open, a window that goes
 * away mid-spawn, a renderer that never replies - each is a distinct refusal with its own words,
 * because "your chat is starting" followed by silence is exactly the failure the phone cannot
 * recover from.
 */
export interface RemoteChatSpawner {
  /** The seam the remote server holds. Never rejects: a failure is a `{ ok: false }` verdict. */
  spawn(request: RemoteChatSpawnRequest): Promise<RemoteChatSpawnResult>
  /**
   * Registers the window that performs spawns and returns a disposer. The most recently attached
   * live window wins, so a reopened window takes over from a destroyed one without a restart.
   */
  attach(window: SpawnWindow): () => void
  /** The renderer's answer, routed in from IPC. Unknown ids are ignored: a late reply is not news. */
  complete(requestId: string, result: RemoteChatSpawnResult): void
}

/** The slice of `WebContents` this needs, so tests do not have to build an Electron window. */
export interface SpawnWindow {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

export interface RemoteChatSpawnerOptions {
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

export function createRemoteChatSpawner(options: RemoteChatSpawnerOptions = {}): RemoteChatSpawner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const newRequestId = options.requestId ?? (() => randomUUID())
  const schedule =
    options.schedule ??
    ((run, delayMs) => {
      const timer = setTimeout(run, delayMs)
      return { cancel: () => clearTimeout(timer) }
    })

  const windows: SpawnWindow[] = []
  const pending = new Map<string, { window: SpawnWindow; settle(result: RemoteChatSpawnResult): void }>()

  const liveWindow = (): SpawnWindow | null => {
    // Destroyed windows are dropped on the way past rather than swept on a timer: this list is
    // read once per spawn, which is exactly when its staleness starts to matter.
    while (windows.length > 0) {
      const candidate = windows[windows.length - 1]
      if (!candidate.isDestroyed()) return candidate
      windows.pop()
    }
    return null
  }

  const failPending = (window: SpawnWindow, message: string): void => {
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
