/**
 * FirstMate's own chat replies carry no structured signal distinguishing a decision-requiring
 * message ("should I fix this or skip it?") from routine narration ("spawning worker...") — both
 * arrive as the same plain `{ type: 'message', role: 'assistant', text }` event. This module is a
 * conservative, text-shape heuristic that drives styling/interaction from that plain text alone.
 *
 * A missed decision highlight is far less harmful than a routine message wrongly flagged as
 * needing a decision (which would erode the whole point of the signal), so both classifiers only
 * fire on a fairly specific shape and fall back to 'normal' (plain styling) otherwise.
 *
 * Decision shape: two or more "option lines" (see OPTION_LINE_PATTERNS — a bold/bulleted label,
 * an "Option A:"/"Option 1:" line, or a single-letter "A)" line) AND the message's last non-empty
 * line ends in a literal "?". Either signal alone is common in ordinary prose; both together is
 * FirstMate's consistent shape for "here are your choices, which one?" — keep that phrasing
 * (labeled options followed by a trailing question) if you want new decision messages to keep
 * getting flagged.
 *
 * Noise shape: the whole message is a single short paragraph, has no option lines, asks no
 * question, and opens with one of a fixed list of routine status lead-ins (spawning, dispatching,
 * validating, "no action needed", ...). Extend NOISE_LEAD_PATTERNS if FirstMate adopts a new
 * routine lead-in phrase that isn't muting today.
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

function cleanOptionLine(line: string): string {
  return line.replace(/^[-*]\s*/, '').replace(/\*\*/g, '').trim()
}

function isOptionLine(line: string): boolean {
  return OPTION_LINE_PATTERNS.some((pattern) => pattern.test(line))
}

function nonEmptyLines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
}

function extractOptionLines(text: string): string[] {
  return nonEmptyLines(text).filter(isOptionLine).map(cleanOptionLine)
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
  const lines = nonEmptyLines(trimmed)
  const lastLine = lines[lines.length - 1] ?? ''
  if (optionLines.length >= 2 && lastLine.endsWith('?')) return 'decision'
  if (isNoiseMessage(trimmed, optionLines)) return 'noise'
  return 'normal'
}

/** Only meaningful when `classifyAssistantMessage` returned 'decision' for the same text. */
export function extractDecisionOptions(text: string): DecisionOption[] {
  return extractOptionLines(text.trim()).map((label, index) => ({ id: `option-${index}`, label }))
}
