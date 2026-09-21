/**
 * The "delegate decisions" policy: one workspace preference, and the session instruction that
 * carries it. A *decision-shaped subtask* is one whose result is a verdict rather than an artifact
 * - choose between options, score candidates, route an intent, classify against fixed labels - and
 * a decision-delegating session is told it may hand those to a *decision provider* reached through
 * an installed agent skill (issue #213; the vocabulary is pinned in `CONTEXT.md`).
 *
 * Toucan bundles and installs nothing: the provider arrives as a user-level Claude plugin the user
 * installed themselves (the #211 lesson - a bundled skill reaches every project at once), so the
 * only question this module's callers answer before launch is whether that plugin is present. The
 * plugin id is the stable handle; the cache directory carries a version and must never be globbed
 * for. Skill presence is the whole probe - no API-key check, because where the key lives is
 * skill-private and a missing one fails visibly in the transcript.
 *
 * Claude only in v1. The module stays provider-generic and `appliedDecisionDelegation` is the one
 * place that says so, because the Codex carriage waits on two things that are not true yet: the
 * skill being installed for Codex at all, and a live verification that the Codex CLI loads
 * user-level skills inside Toucan-launched sessions. Unverified adapter behavior does not ship.
 *
 * Like every session-launch policy here the wording is *requested, not confirmed*: the session
 * carries the instruction, nothing verifies the agent honours it. Routing a subtask to the wrong
 * place costs efficiency, not correctness, which is why the classification is left to the main
 * model's own reasoning - no separate classifier call, no tool gating.
 */

import type { AgentProvider } from './agent-provider'

/**
 * The Claude plugin id the availability probe looks for in `~/.claude/plugins/installed_plugins.json`.
 * Constant across version bumps, unlike the install path beside it.
 */
export const DECISION_PROVIDER_PLUGIN_ID = 'typesafe@typesafe-ai'

/**
 * How the main model names the skill when it invokes it. The skill's own name is `typesafe-ai`,
 * but it arrives inside a plugin, and Claude Code addresses a plugin's skill as `plugin:skill` -
 * so the bare name would not resolve. The plugin half is `typesafe`, from the plugin id above.
 */
export const DECISION_PROVIDER_SKILL_NAME = 'typesafe:typesafe-ai'

/** Why the "On" option is closed when the plugin is absent - the one sentence that says what to do. */
export const DECISION_PROVIDER_INSTALL_HINT = `TypeSafe skill not installed - install \`${DECISION_PROVIDER_PLUGIN_ID}\` for Claude Code`

/** The renderer-facing half of the availability probe, exposed by the preload bridge. */
export interface DecisionDelegationApi {
  /** Whether the decision provider's skill is installed for Claude Code, asked fresh each call. */
  availability(): Promise<boolean>
}

/** Independent of routine delegation, so it is its own preference rather than a field on that one. */
export interface DecisionDelegationPreference {
  enabled: boolean
}

export function isDecisionDelegationPreference(value: unknown): value is DecisionDelegationPreference {
  if (!value || typeof value !== 'object') return false
  return typeof (value as Partial<DecisionDelegationPreference>).enabled === 'boolean'
}

/**
 * What a launch request carries: presence alone, because there is nothing to configure - the
 * provider, its model and its key all live behind the installed skill. `undefined` when the
 * preference is off, so an off session's request is shaped exactly as it was before this existed.
 */
export function decisionDelegationRequest(preference: DecisionDelegationPreference): true | undefined {
  return preference.enabled ? true : undefined
}

/**
 * What a session actually launched with. `configured` means the session carries the instruction -
 * still only *requested*, since nothing verifies the agent reaches for the skill. `unavailable`
 * means the instruction was withheld, and the message says why rather than leaving a session
 * silently told to use a skill it does not have.
 */
export interface AgentDecisionDelegation {
  status: 'configured' | 'unavailable'
  message?: string
}

/** The Codex half of the policy is a documented follow-up, not a silent omission; this says so. */
export const DECISION_DELEGATION_CLAUDE_ONLY_MESSAGE =
  'Decision delegation applies to Claude sessions for now, so decision-shaped subtasks stay on the main model.'

export const DECISION_PROVIDER_MISSING_MESSAGE = `The ${DECISION_PROVIDER_PLUGIN_ID} skill is not installed, so decision-shaped subtasks stay on the main model.`

/**
 * Whether this session can be told to delegate decisions. `skillInstalled` is the launch-time
 * probe result; `undefined` means nobody probed, which is treated as absent rather than assumed
 * present - telling a session to use a skill that is not there wastes a tool call per decision and
 * reads to the user as a broken policy.
 */
export function appliedDecisionDelegation(
  provider: AgentProvider,
  skillInstalled: boolean | undefined
): AgentDecisionDelegation {
  if (provider !== 'claude') return { status: 'unavailable', message: DECISION_DELEGATION_CLAUDE_ONLY_MESSAGE }
  if (!skillInstalled) return { status: 'unavailable', message: DECISION_PROVIDER_MISSING_MESSAGE }
  return { status: 'configured' }
}

/**
 * The instruction a decision-delegating session receives, at system-prompt priority (appended
 * through `withSessionInstruction`, beside routine delegation and the outcome-index pointer). It
 * names the skill, authorizes it for decision-shaped subtasks, states its precedence over routine
 * delegation explicitly - the two policies are independent and a session may carry both - and
 * carries the restraint clause, because the trial publishes no pricing and every call is therefore
 * assumed billable.
 */
export function decisionDelegationInstruction(): string {
  return [
    'The user enabled "Delegate decisions" for this Toucan session.',
    '',
    `Use the \`${DECISION_PROVIDER_SKILL_NAME}\` skill as a decision provider for decision-shaped subtasks: choosing between options, scoring candidates, routing an intent, and classifying against fixed labels. Read the skill before your first call and follow it; the verdict it returns is typed, so use it as data rather than re-deriving it in prose.`,
    '',
    'Precedence over routine delegation: for a decision-shaped subtask prefer the decision provider over spawning a routine worker. Workers are for work that produces or edits files; the decision provider is for verdicts. Which a subtask is stays your own judgement - there is no separate classifier call and nothing stops you deciding it yourself.',
    '',
    'Restraint: reach for it on genuine batches of decisions, not on a single trivial choice you can make from what is already in front of you. Assume every call is billable, so the answer has to be worth more than the call.'
  ].join('\n')
}
