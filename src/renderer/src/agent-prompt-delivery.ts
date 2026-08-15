export interface AgentPromptDeliveryResult {
  ok: boolean
  message?: string
  prompt?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
