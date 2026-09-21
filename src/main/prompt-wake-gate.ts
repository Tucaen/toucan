import type { AgentPromptResult } from '../shared/agent'
import { errorMessage } from '../shared/text'

/**
 * A FIFO queue of prompts parked behind a turn in flight. `enqueue` resolves only once the payload
 * has actually been delivered, so a caller can tell a queued send from a dispatched one; `flush`
 * is the boundary a finished turn calls to drain the queue, one delivery at a time.
 */
export interface PromptWakeGate<T = string> {
  enqueue(payload: T): Promise<AgentPromptResult>
  flush(): void
  dispose(): void
}

export interface PromptWakeGateOptions<T = string> {
  deliver(payload: T): Promise<AgentPromptResult>
}

interface QueuedWake<T> {
  payload: T
  resolve(result: AgentPromptResult): void
}

export function createPromptWakeGate<T = string>(options: PromptWakeGateOptions<T>): PromptWakeGate<T> {
  const queue: QueuedWake<T>[] = []
  let disposed = false
  let delivering = false

  const deliverNext = (): void => {
    if (delivering || disposed) return
    const item = queue.shift()
    if (!item) return
    delivering = true
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
        queue.push({ payload, resolve })
      })
    },

    flush(): void {
      deliverNext()
    },

    dispose(): void {
      disposed = true
      for (const item of queue) {
        item.resolve({ ok: false, message: 'The wake gate was disposed.' })
      }
      queue.length = 0
    }
  }
}
