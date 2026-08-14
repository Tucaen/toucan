import type { AgentProvider } from './agent'

export const FIRSTMATE_PANEL_MIN_WIDTH = 300
export const FIRSTMATE_PANEL_MAX_WIDTH = 720

export type FirstMateRuntimeState = 'missing' | 'installing' | 'ready' | 'error'

export type FirstMateTaskStage = 'implemented' | 'validating' | 'decision' | 'blocked' | 'pr-ready'

export interface FirstMateValidatorRuntime {
  agent: AgentProvider
  model: string
  configSource: 'ade-runtime'
}

export interface FirstMateLifecycleTask {
  id: string
  mode: string
  stage: FirstMateTaskStage
  detail: string
  statusHash: string
  nextAction?: 'start-validation' | 'await-validation' | 'await-decision' | 'await-help' | 'review-pr'
  prUrl?: string
}

export interface FirstMateLifecycleStatus {
  supervision: 'app-native'
  validator?: FirstMateValidatorRuntime
  message?: string
  tasks: FirstMateLifecycleTask[]
}

export interface FirstMateRuntimeStatus {
  state: FirstMateRuntimeState
  distroPath: string
  homePath: string
  host: 'native' | 'wsl'
  backend: 'tmux'
  supervision: 'app-native'
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
