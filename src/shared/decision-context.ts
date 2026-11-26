import type { AgentDecisionRequest } from './agent'

/**
 * The request's message as context above its questions, or `undefined` when it would only repeat
 * the one question. Claude's adapter sends a single AskUserQuestion with that question's text as
 * the message, so a form showing both printed the same paragraph twice - on a long screenshot gate
 * a whole phone screen of it. A question set keeps its message: there it introduces several
 * questions and is not any one of them. "Only repeat" is the whole question or its opening or
 * closing words, so a short message that merely shares a word with the question still shows.
 * Shared by the desktop's and the phone's decision forms, so both drop the same repeats.
 */
export function decisionContext(request: AgentDecisionRequest): string | undefined {
  const message = request.message.trim()
  if (message === '') return undefined
  const [single] = request.questions
  if (request.questions.length !== 1 || !single) return message
  const repeat = comparable(message)
  const question = comparable(single.question)
  return question.startsWith(repeat) || question.endsWith(repeat) ? undefined : message
}

/** Text as compared for a repeat: case, runs of whitespace and closing punctuation do not count. */
function comparable(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.?!:…]+$/u, '')
}
