import type { AgentDecisionRequest } from './agent'

/**
 * The request's message as context above its questions, or `undefined` when it would only repeat
 * the one question. Claude's adapter sends a single AskUserQuestion with that question's text as
 * the message, so a form showing both printed the same paragraph twice - on a long screenshot gate
 * a whole phone screen of it. A question set keeps its message: there it introduces several
 * questions and is not any one of them. Shared by the desktop's `StructuredDecisionPanel` and the
 * phone's `DecisionCard`, so both drop the same repeats.
 */
export function decisionContext(request: AgentDecisionRequest): string | undefined {
  const message = request.message.trim()
  if (message === '') return undefined
  const [only] = request.questions
  if (request.questions.length !== 1 || !only) return message
  const said = comparable(message)
  return comparable(only.question).includes(said) ? undefined : message
}

/** Text as compared for a repeat: case, runs of whitespace and closing punctuation do not count. */
function comparable(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.?!:…]+$/u, '')
}
