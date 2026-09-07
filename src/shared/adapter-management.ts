import type { AgentProvider } from './agent'

export const ADAPTER_PACKAGES: Record<AgentProvider, string> = {
  claude: '@agentclientprotocol/claude-agent-acp',
  codex: '@agentclientprotocol/codex-acp'
}

/** Only exact published versions are accepted, never npm ranges, paths, URLs or tags. */
export function isAdapterVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length < 128 &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      value
    )
  )
}

export interface AdapterCatalog {
  versions: string[]
  latest?: string
}

export interface AdapterState {
  bundledVersion: string
  /** null follows the bundled version across Toucan upgrades. */
  selectedVersion: string | null
  installedVersions: string[]
  catalog?: AdapterCatalog
  phase: 'idle' | 'checking' | 'installing' | 'validating'
  error?: string
}

export type AdapterSnapshot = Record<AgentProvider, AdapterState>

export interface AdapterManagementApi {
  state(): Promise<AdapterSnapshot>
  check(provider: AgentProvider): Promise<AdapterSnapshot>
  /** null restores the bundle; an exact version installs if necessary, then selects. */
  select(provider: AgentProvider, version: string | null): Promise<AdapterSnapshot>
  onChange(callback: (snapshot: AdapterSnapshot) => void): () => void
}
