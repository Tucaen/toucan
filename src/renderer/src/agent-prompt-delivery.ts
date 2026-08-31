import { errorMessage } from '../../shared/text'

export interface AgentPromptDeliveryResult {
  ok: boolean
  message?: string
  prompt?: string
}

/**
 * Picks which agent API a submit should route through: the queue-capable one while the
 * agent is still working on its current turn, the direct one once it's ready for a new turn.
 */
export function chooseAgentPromptApi<T>(status: string, api: { prompt: T; promptWhenIdle: T }): T {
  return status === 'working' ? api.promptWhenIdle : api.prompt
}

export interface DispatchOrderSlot {
  /** Resolves once the previously reserved slot's holder has called its own `release`. */
  previous: Promise<void>
  release(): void
}

export interface DispatchOrderGate {
  reserve(): DispatchOrderSlot
}

/**
 * Serializes cross-process dispatch order across concurrent submissions whose own async setup
 * (e.g. an async composePrompt) may resolve in a different order than they were submitted in.
 * Call `reserve()` synchronously at submission time, before that setup starts, to claim a FIFO
 * position; await the returned `previous` right before the actual dispatch call, then call
 * `release()` immediately once that call has been issued (not once it resolves) so the next
 * reserved slot can proceed without waiting for this submission's full round trip.
 */
export function createDispatchOrderGate(): DispatchOrderGate {
  let tail: Promise<void> = Promise.resolve()
  return {
    reserve(): DispatchOrderSlot {
      const previous = tail
      let release: () => void = () => {}
      tail = new Promise<void>((resolve) => {
        release = resolve
      })
      return { previous, release }
    }
  }
}

/**
 * Resolves request-time context before crossing the agent boundary. A failed composition returns
 * without invoking `deliver`, so callers can safely retry on the same conversation later.
 */
export async function deliverAgentPrompt(
  text: string,
  compose: ((text: string) => string | Promise<string>) | undefined,
  deliver: (prompt: string) => Promise<{ ok: boolean; message?: string }>,
  onPrepared?: (prompt: string) => void
): Promise<AgentPromptDeliveryResult> {
  let prompt: string
  try {
    prompt = compose ? await compose(text) : text
    onPrepared?.(prompt)
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }

  try {
    const result = await deliver(prompt)
    return { ...result, prompt }
  } catch (error) {
    return { ok: false, message: errorMessage(error), prompt }
  }
}
