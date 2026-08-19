import type { AgentPromptResult } from '../shared/agent'
import { errorMessage } from '../shared/text'

export interface CaptainWakeGate<T = string> {
  enqueue(payload: T): Promise<AgentPromptResult>
  flush(): void
  dispose(): void
}

export interface CaptainWakeGateOptions<T = string> {
  deliver(payload: T): Promise<AgentPromptResult>
  onExpired?(pendingPayload: T): void
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 120_000

interface QueuedWake<T> {
  payload: T
  resolve(result: AgentPromptResult): void
  timer: ReturnType<typeof setTimeout>
}

export function createCaptainWakeGate<T = string>(options: CaptainWakeGateOptions<T>): CaptainWakeGate<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const queue: QueuedWake<T>[] = []
  let disposed = false
  let delivering = false

  const removeFromQueue = (item: QueuedWake<T>): void => {
    const index = queue.indexOf(item)
    if (index >= 0) queue.splice(index, 1)
  }

  const deliverNext = (): void => {
    if (delivering || disposed) return
    const item = queue[0]
    if (!item) return
    delivering = true
    clearTimeout(item.timer)
    removeFromQueue(item)
    const settle = (result: AgentPromptResult): void => {
      item.resolve(result)
      delivering = false
      deliverNext()
    }
    try {
      void options.deliver(item.payload).then(settle, (error) => settle({ ok: false, message: errorMessage(error) }))
    } catch (error) {
      settle({ ok: false, message: errorMessage(error) })
    }
  }

  return {
    enqueue(payload: T): Promise<AgentPromptResult> {
      if (disposed) return Promise.resolve({ ok: false, message: 'The wake gate is disposed.' })
      return new Promise<AgentPromptResult>((resolve) => {
        const item: QueuedWake<T> = {
          payload,
          resolve,
          timer: setTimeout(() => {
            removeFromQueue(item)
            resolve({ ok: false, message: `The lifecycle wake expired after ${timeoutMs}ms because the captain did not become idle in time.` })
            options.onExpired?.(payload)
          }, timeoutMs)
        }
        queue.push(item)
      })
    },

    flush(): void {
      deliverNext()
    },

    dispose(): void {
      disposed = true
      for (const item of queue) {
        clearTimeout(item.timer)
        item.resolve({ ok: false, message: 'The wake gate was disposed.' })
      }
      queue.length = 0
    }
  }
}
