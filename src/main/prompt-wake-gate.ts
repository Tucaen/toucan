import type { AgentPromptResult } from '../shared/agent'
import { errorMessage } from '../shared/text'

export interface PromptWakeGate<T = string> {
  enqueue(payload: T): Promise<AgentPromptResult>
  flush(): void
  /** A host-observed boundary at which the active turn can cooperatively yield to queued work. */
  checkpoint(force?: boolean): void
  hasPending(): boolean
  dispose(): void
}

export interface PromptWakeGateOptions<T = string> {
  deliver(payload: T): Promise<AgentPromptResult>
  requestCheckpoint?(): void
  checkpointMs?: number
}

export const DEFAULT_CHECKPOINT_MS = 60_000

interface QueuedWake<T> {
  payload: T
  resolve(result: AgentPromptResult): void
}

export function createPromptWakeGate<T = string>(options: PromptWakeGateOptions<T>): PromptWakeGate<T> {
  const checkpointMs = options.checkpointMs ?? DEFAULT_CHECKPOINT_MS
  const queue: QueuedWake<T>[] = []
  let disposed = false
  let delivering = false
  let checkpointDue = false
  let checkpointRequested = false
  let checkpointTimer: ReturnType<typeof setTimeout> | undefined

  const armCheckpoint = (): void => {
    if (checkpointTimer || checkpointDue || queue.length === 0 || delivering || disposed) return
    checkpointTimer = setTimeout(() => {
      checkpointTimer = undefined
      checkpointDue = true
    }, checkpointMs)
  }

  const clearCheckpoint = (): void => {
    if (checkpointTimer) clearTimeout(checkpointTimer)
    checkpointTimer = undefined
    checkpointDue = false
    checkpointRequested = false
  }

  const removeFromQueue = (item: QueuedWake<T>): void => {
    const index = queue.indexOf(item)
    if (index >= 0) queue.splice(index, 1)
  }

  const deliverNext = (): void => {
    if (delivering || disposed) return
    const item = queue[0]
    if (!item) return
    clearCheckpoint()
    delivering = true
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
        const item: QueuedWake<T> = { payload, resolve }
        queue.push(item)
        armCheckpoint()
      })
    },

    flush(): void {
      deliverNext()
    },

    checkpoint(force = false): void {
      if (disposed || delivering || queue.length === 0) return
      if (!force && !checkpointDue) return
      if (checkpointRequested) return
      checkpointRequested = true
      options.requestCheckpoint?.()
    },

    hasPending(): boolean {
      return queue.length > 0 || delivering
    },

    dispose(): void {
      disposed = true
      clearCheckpoint()
      for (const item of queue) {
        item.resolve({ ok: false, message: 'The wake gate was disposed.' })
      }
      queue.length = 0
    }
  }
}
