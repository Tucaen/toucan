import { isToucanHeader } from './toucan-prompt'

/**
 * Which user-role messages Toucan wrote rather than the human.
 *
 * Every prompt Toucan composes carries the header `toucanPrompt` writes, and the adapter transcript
 * keeps it as the message's first line, so it survives a history reload or replay where a flag set
 * at injection would not. That header is the only pattern new messages need.
 */
export function isToucanOriginText(text: string): boolean {
  return isToucanHeader(text) || LEGACY_TOUCAN_ORIGIN_PATTERNS.some((pattern) => pattern.test(text.trimStart()))
}

/**
 * Legacy fallback: the prompts Toucan composed before the uniform header, as they sit in the
 * transcripts of chats that already exist. Anchored to the start of the message so a human merely
 * quoting one is not matched. Nothing new is written in these forms; delete this list once old
 * orchestrator chats no longer matter.
 */
const LEGACY_TOUCAN_ORIGIN_PATTERNS: readonly RegExp[] = [
  /^Toucan: /,
  /^\[Toucan[ :]/,
  /^The user pressed (?:Continue|Start now)\b/,
  /^Usage limit reset\. /,
  /^Provider pacing reopened for /
]
