/** The two agent providers Toucan can run a chat node on. Its own module so policy modules the agent contract references can name a provider without a cycle. */
export type AgentProvider = 'claude' | 'codex'
