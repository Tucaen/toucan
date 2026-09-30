import { randomUUID } from 'node:crypto'

/**
 * Main asking the desktop renderer to perform something only the canvas can do, and waiting for
 * its verdict. Node identity, geometry and session launch are the canvas's, so a phone's spawn
 * (`remote/canvas-requests.ts`) and an orchestrator's ticket session (`ticket-spawner.ts`) are both
 * requests the newest live window runs through its own path.
 *
 * Every path out of `request` answers the caller - no window, a window that goes away mid-request,
 * a renderer that never replies each have their own words - because the caller is holding an open
 * HTTP request on the other side, and silence is the one answer it cannot act on.
 */

/** The slice of `WebContents` this needs, so tests do not have to build an Electron window. */
export interface DesktopWindow {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

export interface WindowRequestMessages {
  noWindow: string
  windowGone: string
  timeout: string
}

export interface WindowRequestsOptions<Result> {
  /** The channel the request is sent on, as `(requestId, request)`. */
  channel: string
  messages: WindowRequestMessages
  /** How a refusal in one of `messages`' words is expressed as this request's result. */
  refuse(message: string): Result
  timeoutMs: number
  requestId?: () => string
  /** Injectable so tests do not wait in real time. */
  schedule?: (run: () => void, delayMs: number) => { cancel(): void }
}

export interface WindowRequests<Request, Result> {
  /** Never rejects: a failure is the result `refuse` builds. */
  request(request: Request): Promise<Result>
  /** The most recently attached window that is still alive. */
  liveWindow(): DesktopWindow | null
  /**
   * Registers a window that performs these requests and returns a disposer. The most recently
   * attached live window wins, so a reopened window takes over from a destroyed one.
   */
  attach(window: DesktopWindow): () => void
  /** The renderer's answer, routed in from IPC. Unknown ids are ignored: a late reply is not news. */
  complete(requestId: string, result: Result): void
}

export function createWindowRequests<Request, Result>(
  options: WindowRequestsOptions<Result>
): WindowRequests<Request, Result> {
  const newRequestId = options.requestId ?? (() => randomUUID())
  const schedule =
    options.schedule ??
    ((run, delayMs) => {
      const timer = setTimeout(run, delayMs)
      return { cancel: () => clearTimeout(timer) }
    })

  const windows: DesktopWindow[] = []
  const pending = new Map<string, { window: DesktopWindow; settle(result: Result): void }>()

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
        entry.settle(options.refuse(message))
      }
    }
  }

  return {
    request(request): Promise<Result> {
      const window = liveWindow()
      if (!window) return Promise.resolve(options.refuse(options.messages.noWindow))

      const requestId = newRequestId()
      return new Promise<Result>((resolve) => {
        const timer = schedule(() => {
          if (!pending.delete(requestId)) return
          resolve(options.refuse(options.messages.timeout))
        }, options.timeoutMs)
        pending.set(requestId, {
          window,
          settle: (result) => {
            timer.cancel()
            resolve(result)
          }
        })
        window.send(options.channel, requestId, request)
      })
    },
    liveWindow,
    attach(window): () => void {
      windows.push(window)
      return () => {
        const index = windows.indexOf(window)
        if (index !== -1) windows.splice(index, 1)
        // A window that goes away mid-request will never answer, and its caller is waiting, so the
        // refusal is issued here rather than left to the timeout.
        failPending(window, options.messages.windowGone)
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
