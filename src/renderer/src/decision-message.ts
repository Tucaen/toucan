/**
 * Agent chat replies carry no structured signal distinguishing a decision-requiring message
 * ("should I fix this or skip it?") from routine narration — both arrive as the same plain
 * `{ type: 'message', role: 'assistant', text }` event. This module is a conservative,
 * text-shape heuristic that drives styling/interaction from that plain text alone.
 *
 * Decision shape: either a trailing question immediately preceded by one compact block of two or
 * more "option lines" (see OPTION_LINE_PATTERNS), or enumerated proposal content followed by a
 * compact confirmation-question block. The latter offers one synthetic Agree action: proposal
 * items are content to approve, not choices to extract.
 *
 * Noise shape: the whole message is a single short paragraph, has no option lines, asks no
 * question, and opens with one of a fixed list of routine status lead-ins.
 */

export type MessageTone = 'decision' | 'noise' | 'normal'

export interface DecisionOption {
  id: string
  label: string
}

const OPTION_LINE_PATTERNS: RegExp[] = [
  // "- **Fix it now**: apply the patch and rerun tests" / "* **Skip it** — leave it as-is"
  /^[-*]\s*\*\*(.+?)\*\*\s*[:\-–—]?\s*(.*)$/,
  // "**Fix it now**: apply the patch" (no leading bullet)
  /^\*\*(.+?)\*\*\s*[:\-–—]?\s*(.*)$/,
  // Codex commonly renders choices as numbered Markdown with a bold label. Requiring the bold
  // label (plus the classifier's trailing question) keeps ordinary numbered procedures out.
  /^\d+[.)]\s*\*\*(.+?)\*\*\s*[:\-–—]?\s*(.*)$/,
  // "Option A: restart the worker" / "- Option 1 - requeue the task"
  /^(?:[-*]\s*)?Option\s+([A-Za-z0-9]+)\s*[:\-–—]\s*(.+)$/i,
  // "A) restart the worker" / "A. requeue the task" — a single letter only, so ordinary numbered
  // step-by-step prose ("1. Run the build", "2. Check the logs") doesn't false-positive.
  /^(?:[-*]\s*)?([A-Z])[).]\s+(.+)$/
]

const NOISE_LEAD_PATTERNS: RegExp[] = [
  /^spawning\b/i,
  /^dispatching\b/i,
  /^dispatched\b/i,
  /^validating\b/i,
  /^checking\b/i,
  /^queued\b/i,
  /^queuing\b/i,
  /^starting\b/i,
  /^resuming\b/i,
  /^continuing\b/i,
  /^still working\b/i,
  /^working on it\b/i,
  /^in progress\b/i,
  /^no action needed\b/i,
  /^nothing (else )?to do\b/i,
  /^all good\b/i,
  /^no changes needed\b/i,
  /^task (dispatched|queued|started)\b/i
]

const NOISE_MAX_LENGTH = 220
const CONFIRMATION_OPTION = 'Agree'

const CONFIRMATION_CUE =
  /\b(?:agree|approve|blocking edges?|correct|feel right|granularity|look good|merge(?:d)?|okay|proposal|sound good|split|tickets?)\b/i
const CONFIRMATION_OPENING = /^(?:are|can|could|did|do|does|has|have|is|should|was|were|will|would)\b/i
const PROPOSAL_CONTEXT =
  /\b(?:blocked by|blocking edges?|breakdown|granularity|implementation|plan|proposal|seams?|steps?|tickets?|what it delivers)\b/i
const CHOICE_CONTEXT = /\b(?:alternatives?|choices?|choose|options?|pick|select)\b/i

function removeListMarker(line: string): string {
  return line.replace(/^(?:[-*]|\d+[.)])\s*/, '')
}

function cleanOptionLine(line: string): string {
  return removeListMarker(line).replace(/\*\*/g, '').trim()
}

function isOptionLine(line: string): boolean {
  const numberedBoldLabel = /^\d+[.)]\s*\*\*(.+?)\*\*/.exec(line)?.[1]
  if (numberedBoldLabel?.trim().endsWith('?')) return false
  return OPTION_LINE_PATTERNS.some((pattern) => pattern.test(line))
}

function nonEmptyLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function extractOptionLines(text: string): string[] {
  return nonEmptyLines(text).filter(isOptionLine).map(cleanOptionLine)
}

function extractDecisionOptionLines(text: string): string[] {
  const lines = text.split('\n').map((line) => line.trim())
  while (lines.at(-1) === '') lines.pop()
  const question = lines.pop() ?? ''
  if (!question.endsWith('?')) return []

  // Markdown commonly leaves one or more blank lines between the list and its question.
  while (lines.at(-1) === '') lines.pop()

  const options: string[] = []
  while (lines.length > 0 && isOptionLine(lines.at(-1) ?? '')) {
    options.unshift(cleanOptionLine(lines.pop() ?? ''))
  }
  return options.length >= 2 ? options : []
}

function cleanQuestionLine(line: string): string {
  return removeListMarker(line)
    .replace(/^\*\*(.*?)\*\*$/, '$1')
    .trim()
}

function isConfirmationQuestion(line: string): boolean {
  const question = cleanQuestionLine(line)
  return question.endsWith('?') && CONFIRMATION_OPENING.test(question) && CONFIRMATION_CUE.test(question)
}

function hasEnumeratedProposal(lines: string[]): boolean {
  return lines.filter((line) => /^(?:[-*]|\d+[.)])\s+\S/.test(line)).length >= 2
}

function hasTrailingConfirmationQuestions(text: string): boolean {
  const lines = nonEmptyLines(text)
  let confirmationQuestions = 0
  while (isConfirmationQuestion(lines.at(-1) ?? '')) {
    confirmationQuestions += 1
    lines.pop()
  }
  const proposalText = lines.join('\n')
  return (
    confirmationQuestions > 0 &&
    hasEnumeratedProposal(lines) &&
    PROPOSAL_CONTEXT.test(proposalText) &&
    !CHOICE_CONTEXT.test(proposalText)
  )
}

function extractDecisionOptionsFromText(text: string): string[] {
  if (hasTrailingConfirmationQuestions(text)) return [CONFIRMATION_OPTION]
  return extractDecisionOptionLines(text)
}

function isNoiseMessage(text: string, optionLines: string[]): boolean {
  if (optionLines.length > 0) return false
  if (text.includes('?')) return false
  if (text.length > NOISE_MAX_LENGTH) return false
  if (text.includes('\n\n')) return false
  return NOISE_LEAD_PATTERNS.some((pattern) => pattern.test(text))
}

export function classifyAssistantMessage(text: string): MessageTone {
  const trimmed = text.trim()
  if (!trimmed) return 'normal'
  const optionLines = extractOptionLines(trimmed)
  if (extractDecisionOptionsFromText(trimmed).length > 0) return 'decision'
  if (isNoiseMessage(trimmed, optionLines)) return 'noise'
  return 'normal'
}

/** Only meaningful when `classifyAssistantMessage` returned 'decision' for the same text. */
export function extractDecisionOptions(text: string): DecisionOption[] {
  return extractDecisionOptionsFromText(text.trim()).map((label, index) => ({ id: `option-${index}`, label }))
}
