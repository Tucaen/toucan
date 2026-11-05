import { randomUUID } from 'node:crypto'

/**
 * Main asking the desktop renderer to perform something only the canvas can do, and waiting for
 * its verdict. Node identity, geometry and session launch are the canvas's, so a phone's spawn
 * (`remote/canvas-requests.ts`) and an orchestrator's ticket session (`ticket-spawner.ts`) are both
 * requests the newest live window runs through its own path.
 *
 * Every path out of `request` answers the caller - no window, a window that goes away mid-request,
 * a renderer that never replies each have their own words - because the caller is holding an open
 * HTTP request on the other side, and silence is the one answer it cannot act on. A request that
 * opts into `pending` answers a timeout with that instead of a refusal and stays open, so what the
 * renderer settles later still reaches whoever asked (`WindowRequestObserver.late`).
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

export interface WindowRequestsOptions<Result, Progress = never> {
  /** The channel the request is sent on, as `(requestId, request)`. */
  channel: string
  messages: WindowRequestMessages
  /** How a refusal in one of `messages`' words is expressed as this request's result. */
  refuse(message: string): Result
  /** How long a request waits, counted from the last sign of life (`progress`, `touch`) - or from the ask. */
  timeoutMs: number
  /**
   * Absent, a timeout is a refusal and the request is forgotten: a late answer is not news.
   * Present, the timeout answers with this instead (`progress` is the latest the window reported)
   * and the request stays open, so the window's eventual answer goes to `observer.late`.
   */
  pending?(message: string, progress: Progress | undefined): Result
  requestId?: () => string
  /** Injectable so tests do not wait in real time. */
  schedule?: (run: () => void, delayMs: number) => { cancel(): void }
}

/** What a caller wants of one request beyond its answer. */
export interface WindowRequestObserver<Result, Progress = never> {
  /** This request's wait, replacing the default. */
  timeoutMs?: number
  /** The window reported something about the request before answering it. */
  progress?(progress: Progress): void
  /** The window's answer to a request that already answered `pending`. */
  late?(result: Result): void
}

export interface WindowRequests<Request, Result, Progress = never> {
  /** Never rejects: a failure is the result `refuse` builds. */
  request(request: Request, observer?: WindowRequestObserver<Result, Progress>): Promise<Result>
  /** The most recently attached window that is still alive. */
  liveWindow(): DesktopWindow | null
  /**
   * Registers a window that performs these requests and returns a disposer. The most recently
   * attached live window wins, so a reopened window takes over from a destroyed one.
   */
  attach(window: DesktopWindow): () => void
  /** The renderer's answer, routed in from IPC. Unknown ids are ignored: a late reply is not news. */
  complete(requestId: string, result: Result): void
  /** The renderer's report on a request it has not answered; it also restarts the request's wait. */
  progress(requestId: string, progress: Progress): void
  /** A sign of life from elsewhere: restarts the request's wait without saying anything about it. */
  touch(requestId: string): void
}

interface Entry<Result, Progress> {
  window: DesktopWindow
  observer?: WindowRequestObserver<Result, Progress>
  latest?: Progress
  /** The wait ran out and the caller was answered `pending`; only `observer.late` is owed now. */
  answered: boolean
  settle(result: Result): void
  rearm(): void
}

export function createWindowRequests<Request, Result, Progress = never>(
  options: WindowRequestsOptions<Result, Progress>
): WindowRequests<Request, Result, Progress> {
  const newRequestId = options.requestId ?? (() => randomUUID())
  const schedule =
    options.schedule ??
    ((run, delayMs) => {
      const timer = setTimeout(run, delayMs)
      return { cancel: () => clearTimeout(timer) }
    })

  const windows: DesktopWindow[] = []
  const pending = new Map<string, Entry<Result, Progress>>()

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
    request(request, observer): Promise<Result> {
      const window = liveWindow()
      if (!window) return Promise.resolve(options.refuse(options.messages.noWindow))

      const requestId = newRequestId()
      const timeoutMs = observer?.timeoutMs ?? options.timeoutMs
      return new Promise<Result>((resolve) => {
        const entry: Entry<Result, Progress> = {
          window,
          observer,
          answered: false,
          settle: (result) => {
            timer.cancel()
            if (entry.answered) observer?.late?.(result)
            else resolve(result)
          },
          rearm: () => {
            timer.cancel()
            timer = arm()
          }
        }
        const arm = () =>
          schedule(() => {
            if (pending.get(requestId) !== entry || entry.answered) return
            if (options.pending) {
              entry.answered = true
              resolve(options.pending(options.messages.timeout, entry.latest))
              return
            }
            pending.delete(requestId)
            resolve(options.refuse(options.messages.timeout))
          }, timeoutMs)
        let timer = arm()
        pending.set(requestId, entry)
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
    },
    progress(requestId, progress): void {
      const entry = pending.get(requestId)
      if (!entry) return
      entry.latest = progress
      entry.observer?.progress?.(progress)
      if (!entry.answered) entry.rearm()
    },
    touch(requestId): void {
      const entry = pending.get(requestId)
      if (entry && !entry.answered) entry.rearm()
    }
  }
}
