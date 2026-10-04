/**
 * The one home of "which agent provider". Its own module so policy modules the agent contract
 * references can name a provider without a cycle - and so adding a third provider is an edit to
 * `AGENT_PROVIDERS` rather than a grep for the literals across main, shared, renderer and mobile.
 */
export const AGENT_PROVIDERS = ['claude', 'codex'] as const

/** The two agent providers Toucan can run a chat node on. */
export type AgentProvider = (typeof AGENT_PROVIDERS)[number]

/**
 * What a provider calls itself wherever it is shown; the `AgentProvider` id is lowercase wiring and
 * never display text. One table, so two surfaces labelling the same provider cannot disagree.
 */
export const AGENT_PROVIDER_LABELS: Record<AgentProvider, string> = {
  claude: 'Claude',
  codex: 'Codex'
}

/** Narrows unvalidated input - IPC arguments, a persisted snapshot, a record on disk - to a provider. */
export function isAgentProvider(value: unknown): value is AgentProvider {
  return AGENT_PROVIDERS.includes(value as AgentProvider)
}
