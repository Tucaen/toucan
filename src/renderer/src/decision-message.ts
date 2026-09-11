/**
 * Agent chat replies carry no structured signal distinguishing a decision-requiring message
 * ("should I fix this or skip it?") from routine narration — both arrive as the same plain
 * `{ type: 'message', role: 'assistant', text }` event. This module is a conservative,
 * text-shape heuristic that drives styling/interaction from that plain text alone.
 *
 * Decision shape: either a trailing single-sentence question immediately preceded by one compact block of two or
 * more "option lines" (see OPTION_LINE_PATTERNS), or enumerated proposal content followed by a
 * single confirmation question. The latter offers one synthetic Agree action: proposal items are
 * content to approve, not choices to extract. Several questions cannot share one unambiguous
 * answer, so they remain ordinary prose unless the provider sends a structured elicitation.
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

/** A line that is a Markdown list item: a bullet or number, whitespace, then content. */
const LIST_ITEM = /^(?:[-*]|\d+[.)])\s+\S/

function isListItem(line: string): boolean {
  return LIST_ITEM.test(line)
}

function removeListMarker(line: string): string {
  return line.replace(/^(?:[-*]|\d+[.)])\s*/, '')
}

/** Strips the list marker and Markdown emphasis so a line can be shown as plain UI text. */
function cleanMarkdownLine(line: string): string {
  return removeListMarker(line).replace(/\*\*/g, '').trim()
}

function isOptionLine(line: string): boolean {
  // Numbered bold question lists resemble Codex's numbered choice lists. A question mark anywhere
  // on that shape makes it a question, not a clickable answer; genuine bullet options may still
  // describe an action with a question and are disambiguated by their trailing choice question.
  if (/^\d+[.)]\s*\*\*(.+?)\*\*/.test(line) && line.includes('?')) return false
  return OPTION_LINE_PATTERNS.some((pattern) => pattern.test(line))
}

function nonEmptyLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function extractOptionLines(text: string): string[] {
  return nonEmptyLines(text).filter(isOptionLine).map(cleanMarkdownLine)
}

/**
 * A choice decision closes on a question line ("Which would you like?"), not a closing paragraph
 * that happens to end on a question mark ("...I'd do the sidebar move. Want me to implement it?").
 * Prose before the question means the preceding list is discussion, not options to pick from, so
 * an interior sentence boundary disqualifies the line.
 */
function isSingleSentenceQuestion(line: string): boolean {
  const question = cleanMarkdownLine(line)
  if (!question.endsWith('?')) return false
  return !/[.!?]\s/.test(question.slice(0, -1))
}

function extractDecisionOptionLines(text: string): string[] {
  const lines = text.split('\n').map((line) => line.trim())
  while (lines.at(-1) === '') lines.pop()
  const question = lines.pop() ?? ''
  if (!isSingleSentenceQuestion(question)) return []

  // Markdown commonly leaves one or more blank lines between the list and its question.
  while (lines.at(-1) === '') lines.pop()

  const options: string[] = []
  while (lines.length > 0 && isOptionLine(lines.at(-1) ?? '')) {
    options.unshift(cleanMarkdownLine(lines.pop() ?? ''))
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

/**
 * A question line, judged loosely enough to catch the numbered members of a question block whose
 * text does not end on the question mark ("1. Which app is that? It may be out of scope."). Only
 * the panel's wording depends on this; classification stays on the strict confirmation shape.
 */
function isQuestionLine(line: string): boolean {
  const question = cleanMarkdownLine(line)
  if (question === '') return false
  return question.endsWith('?') || (isListItem(line) && question.includes('?'))
}

function hasEnumeratedProposal(lines: string[]): boolean {
  return lines.filter(isListItem).length >= 2
}

function hasSingleTrailingConfirmationQuestion(text: string): boolean {
  const lines = nonEmptyLines(text)
  const questions: string[] = []
  while (isQuestionLine(lines.at(-1) ?? '')) questions.unshift(lines.pop() ?? '')
  const proposalText = lines.join('\n')
  return (
    questions.length === 1 &&
    isConfirmationQuestion(questions[0] ?? '') &&
    hasEnumeratedProposal(lines) &&
    PROPOSAL_CONTEXT.test(proposalText) &&
    !CHOICE_CONTEXT.test(proposalText)
  )
}

function extractDecisionOptionsFromText(text: string): string[] {
  if (hasSingleTrailingConfirmationQuestion(text)) return [CONFIRMATION_OPTION]
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

/**
 * Every question the message closes on, cleaned for display, in the order asked. The legacy
 * decision classifier only admits one confirmation question, but keeping extraction complete
 * prevents callers from silently losing wording when examining a non-decision message.
 */
export function decisionQuestions(text: string): string[] {
  const trimmed = text.trim()
  const lines = nonEmptyLines(trimmed)
  // A choice decision answers itself through its option lines, so only its closing question is a
  // question — an option line that happens to end on a question mark is not one.
  if (!hasSingleTrailingConfirmationQuestion(trimmed) && extractDecisionOptionLines(trimmed).length > 0) {
    const last = lines.at(-1) ?? ''
    return isQuestionLine(last) ? [cleanMarkdownLine(last)] : []
  }
  const questions: string[] = []
  while (isQuestionLine(lines.at(-1) ?? '')) questions.unshift(cleanMarkdownLine(lines.pop() ?? ''))
  return questions
}

/** Only meaningful when `classifyAssistantMessage` returned 'decision' for the same text. */
export function extractDecisionOptions(text: string): DecisionOption[] {
  return extractDecisionOptionsFromText(text.trim()).map((label, index) => ({ id: `option-${index}`, label }))
}
