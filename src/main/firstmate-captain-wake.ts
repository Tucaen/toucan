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

export function createCaptainWakeGate(options: CaptainWakeGateOptions): CaptainWakeGate {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let pending: { text: string; resolve(result: AgentPromptResult): void } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const startTimer = (): void => {
    clearTimer()
    timer = setTimeout(() => {
      timer = undefined
      if (!pending) return
      const { text, resolve } = pending
      pending = undefined
      resolve({ ok: false, message: `The lifecycle wake expired after ${timeoutMs}ms because the captain did not become idle in time.` })
      options.onExpired?.(text)
    }, timeoutMs)
  }

  return {
    enqueue(text: string): Promise<AgentPromptResult> {
      if (disposed) return Promise.resolve({ ok: false, message: 'The wake gate is disposed.' })
      if (pending) pending.resolve({ ok: true })
      return new Promise<AgentPromptResult>((resolve) => {
        pending = { text, resolve }
        startTimer()
      })
    },

    flush(): void {
      if (!pending) return
      const { text, resolve } = pending
      pending = undefined
      clearTimer()
      try {
        void options.deliver(text).then(
          (result) => resolve(result),
          (error) => resolve({ ok: false, message: errorMessage(error) })
        )
      } catch (error) {
        resolve({ ok: false, message: errorMessage(error) })
      }
    },

    dispose(): void {
      clearTimer()
      if (pending) {
        pending.resolve({ ok: false, message: 'The wake gate was disposed.' })
        pending = undefined
      }
      disposed = true
    }
  }
}
