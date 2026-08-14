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

/**
 * FirstMate's registered delivery postures, in the vocabulary owned by the managed distro's
 * `bin/fm-project-mode.sh`. `no-mistakes-prod-only` is a conditional policy rather than a flat mode.
 */
export type FirstMateDeliveryMode = 'no-mistakes' | 'no-mistakes-prod-only' | 'direct-PR' | 'local-only'

/**
 * Whether no-mistakes initialization, which writes inside the checkout, has been authorized.
 * Registration only records the requirement; ADE never initializes a checkout on its own.
 */
export type FirstMateProjectInitialization = 'not-required' | 'required' | 'authorized'

/** What ADE knows about a sidebar project before it has been registered with FirstMate. */
export interface FirstMateProjectSelection {
  projectId: string
  name: string
  path: string
}

/** One ADE checkout registered as a durable external FirstMate project. */
export interface FirstMateExternalProject {
  /** ADE's stable project identity; two projects may share every other display value. */
  adeProjectId: string
  /** The single-token name FirstMate's fleet registry and posture lookup use. */
  registryName: string
  displayName: string
  windowsPath: string
  wslPath: string
  origin?: string
  mode: FirstMateDeliveryMode
  autonomy: boolean
  initialization: FirstMateProjectInitialization
  registeredAt: string
}

export interface FirstMateProjectRegistration {
  ok: boolean
  project?: FirstMateExternalProject
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
