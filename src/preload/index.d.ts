import type {
  AgentCreateRequest,
  AgentCreateResult,
  AgentEvent,
  AgentPromptResult
} from '../shared/agent'
import type {
  FirstMateActionResult,
  FirstMateExternalProject,
  FirstMateInstallResult,
  FirstMateLifecycleStatus,
  FirstMateProjectRegistration,
  FirstMateProjectSelection,
  FirstMateRuntimeStatus
} from '../shared/firstmate'
import type {
  ConversationPreview,
  ProjectDirectory,
  TerminalCreateRequest,
  TerminalCreateResult,
  WorkspaceSaveResult,
  WorkspaceState
} from '../shared/terminal'

export interface AgentApi {
  create(request: AgentCreateRequest): Promise<AgentCreateResult>
  prompt(id: string, text: string): Promise<AgentPromptResult>
  setMode(id: string, modeId: string): Promise<AgentPromptResult>
  setModel(id: string, modelId: string): Promise<AgentPromptResult>
  authenticate(id: string, methodId: string): Promise<AgentCreateResult>
  resolveApproval(id: string, approvalId: string, optionId?: string): void
  cancel(id: string): void
  kill(id: string): void
  onEvent(id: string, callback: (event: AgentEvent) => void): () => void
}

export interface TerminalApi {
  getInitialProject(): Promise<ProjectDirectory>
  pickProject(): Promise<ProjectDirectory | null>
  loadWorkspace(): Promise<WorkspaceState | null>
  saveWorkspace(state: WorkspaceState): Promise<WorkspaceSaveResult>
  getConversationPreview(kind: 'claude' | 'codex', conversationId: string): Promise<ConversationPreview | null>
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

export interface FirstMateApi {
  status(): Promise<FirstMateRuntimeStatus>
  install(): Promise<FirstMateInstallResult>
  repair(): Promise<FirstMateInstallResult>
  authenticateGitHub(): Promise<FirstMateActionResult>
  trustCodexProject(): Promise<FirstMateActionResult>
  lifecycle(): Promise<FirstMateLifecycleStatus>
  releaseDispatch(taskId: string): Promise<FirstMateActionResult>
  retryDispatch(taskId: string): Promise<FirstMateActionResult>
  registerProject(selection: FirstMateProjectSelection): Promise<FirstMateProjectRegistration>
  recordedProject(adeProjectId: string): Promise<FirstMateExternalProject | null>
  authorizeProjectInitialization(adeProjectId: string): Promise<FirstMateProjectRegistration>
  setAutonomyCeiling(adeProjectId: string, allowed: boolean): Promise<FirstMateProjectRegistration>
  retireProject(adeProjectId: string): Promise<FirstMateActionResult>
}

declare global {
  interface Window {
    terminalApi: TerminalApi
    agentApi: AgentApi
    firstMateApi: FirstMateApi
  }
}
