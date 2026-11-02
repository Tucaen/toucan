/**
 * The one header every prompt Toucan composes carries, and the one place it is written.
 *
 * Toucan hands its own prompts (orchestrator wakes, Continue / Start now / usage-reset / pacing
 * notices, sibling-session messages, ticket-board steers) to a session through the ordinary prompt
 * path, so the adapter transcript records them as plain user messages. A flag set where Toucan
 * injects the message would reach live events only and be lost on a history reload or replay, so
 * the marker every path shares is the text itself: a first line `[Toucan: <label>]`.
 *
 * The form is deliberate. Brackets and the `Toucan:` lead make a single anchored pattern
 * (`isToucanHeader`) that a human's prose rarely begins with; the label after it names the kind
 * (and, for messaging, the parties) in words, so the receiving agent reads who is speaking and why
 * before the body, and a prompt keeps a header that reads the same wherever it is shown. Followup
 * texts an orchestrator sends to its ticket sessions are the orchestrator's own words and are not
 * wrapped; neither are the human's prompts.
 *
 * Every Toucan-composed prompt goes through `toucanPrompt`. It is also the single place an
 * out-of-band origin flag could be attached later (a field on the prompt request, reaching live
 * events only), so a new producer must not hand-write the header.
 */
const TOUCAN_HEADER = /^\[Toucan: [^\]\r\n]+\]/

/** The prompt `body` under Toucan's header; `label` is the kind in a few words, never a full sentence. */
export function toucanPrompt(label: string, body: string): string {
  return `[Toucan: ${label}]\n${body}`
}

/** Whether `text` opens with Toucan's header; anchored, so a human merely quoting one is not matched. */
export function isToucanHeader(text: string): boolean {
  return TOUCAN_HEADER.test(text.trimStart())
}
