import type {
  ProjectDirectory,
  TerminalCreateRequest,
  TerminalCreateResult,
  WorkspaceSaveResult,
  WorkspaceState
} from '../shared/terminal'

export interface TerminalApi {
  getInitialProject(): Promise<ProjectDirectory>
  pickProject(): Promise<ProjectDirectory | null>
  loadWorkspace(): Promise<WorkspaceState | null>
  saveWorkspace(state: WorkspaceState): Promise<WorkspaceSaveResult>
  create(request: TerminalCreateRequest): Promise<TerminalCreateResult>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  kill(id: string): void
  copyText(text: string): void
  readClipboardText(): string
  onData(id: string, callback: (data: string) => void): () => void
  onExit(id: string, callback: (exitCode: number) => void): () => void
  onSession(id: string, callback: (conversationId: string) => void): () => void
}

declare global {
  interface Window {
    terminalApi: TerminalApi
  }
}
