export type TerminalKind = 'terminal' | 'claude' | 'codex'

export interface TerminalCreateRequest {
  id: string
  kind: TerminalKind
  cols: number
  rows: number
  cwd: string
}

export interface ProjectDirectory {
  name: string
  path: string
}

export interface WorkspaceProject extends ProjectDirectory {
  id: string
  color: string
}

export interface WorkspaceState {
  version: 1
  projects: WorkspaceProject[]
  activeProjectId: string | null
  sidebarCollapsed: boolean
}

export interface WorkspaceSaveResult {
  ok: boolean
  message?: string
}

export interface TerminalCreateResult {
  ok: boolean
  message?: string
}

export interface TerminalOutput {
  id: string
  data: string
}

export interface TerminalExit {
  id: string
  exitCode: number
}
