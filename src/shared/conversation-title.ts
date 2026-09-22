import { isFinalAssistantMessage, type AgentMessagePresentation } from './agent'

export type ConversationTitleSource = 'generated' | 'manual'

export interface ConversationTitle {
  title: string
  source: ConversationTitleSource
}

export interface ConversationTitleTurn {
  role: 'user' | 'assistant'
  text: string
  presentation?: AgentMessagePresentation
}

const GENERIC_PROMPT = /^(?:continue|go on|proceed|yes|no|ok(?:ay)?|do it|try again)[.!?]*$/i
const LEADING_REQUEST = /^(?:please|can you|could you|would you)\s+/i
const TITLE_LIMIT = 72

/** One normalization policy for UI, IPC and durable metadata boundaries. */
export function normalizeConversationTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, 120)
}

function titleLine(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*#>\s]+/, '').trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('<') && !line.endsWith(':'))
  // The *last* meaningful line, not the first: a pasted prompt leads with context and background
  // and ends with the ask, so the ask is the line that names the conversation.
  const rawLine = lines.at(-1)
  const withoutRequest = rawLine
    ?.replace(LEADING_REQUEST, '')
    .replace(/[.!?]+$/, '')
    .trim()
  const line =
    rawLine !== withoutRequest && withoutRequest
      ? `${withoutRequest.slice(0, 1).toLocaleUpperCase()}${withoutRequest.slice(1)}`
      : withoutRequest
  if (!line || GENERIC_PROMPT.test(line) || line.length < 12) return null
  if (line.length <= TITLE_LIMIT) return line
  const clipped = line.slice(0, TITLE_LIMIT + 1)
  const boundary = clipped.lastIndexOf(' ')
  return `${clipped.slice(0, boundary >= 36 ? boundary : TITLE_LIMIT).trimEnd()}…`
}

/**
 * Derives a title without asking either agent to run another model turn. This is deliberately
 * deterministic and local: automatic titles consume no provider tokens or account budget.
 */
export function deriveConversationTitle(turns: ConversationTitleTurn[]): string | null {
  const assistantTurns = turns.filter((turn) => isFinalAssistantMessage(turn) && turn.text.trim())
  if (assistantTurns.length === 0) return null
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (turn === undefined || turn.role !== 'user') continue
    const candidate = titleLine(turn.text)
    if (candidate) return candidate
  }
  // A bare "continue" can still reveal its subject through the resulting dialogue. Waiting for
  // two answers keeps a generic first acknowledgement from becoming the title.
  if (assistantTurns.length >= 2) return titleLine(assistantTurns.at(-1)!.text)
  return null
}

/** A transcript message as this module needs to read one, so nothing here depends on the reducer. */
export interface ConversationTitleMessage {
  role: 'user' | 'assistant' | 'thought'
  text: string
  presentation?: AgentMessagePresentation
}

/**
 * The dialogue a generated title is derived from: the user's messages and the assistant's final
 * answers, in order - progress prose would title the conversation after its own scaffolding, and
 * reasoning is not an answer at all. Lives here rather than beside either caller because
 * `isFinalAssistantMessage` is the shared gate, and a second reading of it would be a second
 * answer to what counts as the agent having spoken.
 */
export function generatedConversationTitle(messages: readonly ConversationTitleMessage[]): string | null {
  return deriveConversationTitle(
    messages
      .filter(
        (message): message is ConversationTitleMessage & { role: 'user' | 'assistant' } =>
          message.role === 'user' || isFinalAssistantMessage(message)
      )
      .map(({ role, text, presentation }) => ({ role, text, presentation }))
  )
}
