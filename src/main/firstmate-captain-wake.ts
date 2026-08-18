import type { AgentPromptResult } from '../shared/agent'
import { errorMessage } from '../shared/text'

export interface CaptainWakeGate {
  enqueue(text: string): Promise<AgentPromptResult>
  flush(): void
  dispose(): void
}

export interface CaptainWakeGateOptions {
  deliver(text: string): Promise<AgentPromptResult>
  onExpired?(pendingText: string): void
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 120_000

interface QueuedWake {
  text: string
  resolve(result: AgentPromptResult): void
  timer: ReturnType<typeof setTimeout>
}

export function createCaptainWakeGate(options: CaptainWakeGateOptions): CaptainWakeGate {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const queue: QueuedWake[] = []
  let disposed = false
  let delivering = false

  const removeFromQueue = (item: QueuedWake): void => {
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
      void options.deliver(item.text).then(settle, (error) => settle({ ok: false, message: errorMessage(error) }))
    } catch (error) {
      settle({ ok: false, message: errorMessage(error) })
    }
  }

  return {
    enqueue(text: string): Promise<AgentPromptResult> {
      if (disposed) return Promise.resolve({ ok: false, message: 'The wake gate is disposed.' })
      return new Promise<AgentPromptResult>((resolve) => {
        const item: QueuedWake = {
          text,
          resolve,
          timer: setTimeout(() => {
            removeFromQueue(item)
            resolve({ ok: false, message: `The lifecycle wake expired after ${timeoutMs}ms because the captain did not become idle in time.` })
            options.onExpired?.(text)
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
