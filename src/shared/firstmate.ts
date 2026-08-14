import type { AgentProvider } from './agent'

export type FirstMateRuntimeState = 'missing' | 'installing' | 'ready' | 'error'

export interface FirstMateRuntimeStatus {
  state: FirstMateRuntimeState
  distroPath: string
  homePath: string
  host: 'native' | 'wsl'
  backend: 'tmux'
  distribution?: string
  githubAuth?: 'authenticated' | 'required'
  codexProjectTrust?: 'trusted' | 'required'
  message?: string
}

export interface FirstMateInstallResult {
  ok: boolean
  status: FirstMateRuntimeStatus
}

export interface FirstMateActionResult {
  ok: boolean
  message?: string
}

export interface FirstMateWorkspaceState {
  provider?: AgentProvider
  conversationId?: string
  permissionMode?: string
  modelId?: string
  worklogCollapsed?: boolean
}
