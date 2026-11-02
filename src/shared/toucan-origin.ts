/**
 * Which user-role messages Toucan wrote rather than the human.
 *
 * Toucan hands its own prompts to a session through the ordinary prompt path (orchestrator wakes,
 * Continue / Start now notices, usage-limit resets, pacing reopens, sibling-session messages), so
 * the adapter transcript - and therefore a history reload or replay - records them as plain user
 * messages with no flag. An origin flag set where Toucan injects the message would reach live
 * events only and be lost on reload, so the one marker every path shares is the text itself. Each
 * pattern below names a prompt Toucan composes (see `orchestratorWakePrompt`, `askPrompt` and
 * `replyPrompt`, and the prompts in `orchestration-control.ts`, `orchestration-start-now.ts` and
 * `orchestration-pacing-coordinator.ts`); they are anchored to the start of the message so a
 * human merely quoting one is not matched.
 */
const TOUCAN_ORIGIN_PATTERNS: readonly RegExp[] = [
  /^Toucan: /,
  /^\[Toucan[ :]/,
  /^The user pressed (?:Continue|Start now)\b/,
  /^Usage limit reset\. /,
  /^Provider pacing reopened for /
]

export function isToucanOriginText(text: string): boolean {
  const start = text.trimStart()
  return TOUCAN_ORIGIN_PATTERNS.some((pattern) => pattern.test(start))
}
