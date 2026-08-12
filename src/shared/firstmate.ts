export type FirstMateRuntimeState = 'missing' | 'installing' | 'ready' | 'error'

export interface FirstMateRuntimeStatus {
  state: FirstMateRuntimeState
  distroPath: string
  homePath: string
  workerSupport: 'native' | 'wsl_required'
  message?: string
}

export interface FirstMateInstallResult {
  ok: boolean
  status: FirstMateRuntimeStatus
}

export interface FirstMateWorkspaceState {
  conversationId?: string
  permissionMode?: string
  modelId?: string
  worklogCollapsed?: boolean
}
