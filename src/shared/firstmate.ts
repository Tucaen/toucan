import type { AgentProvider } from './agent'

export const FIRSTMATE_PANEL_MIN_WIDTH = 300
export const FIRSTMATE_PANEL_MAX_WIDTH = 720

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
  panelWidth?: number
}
