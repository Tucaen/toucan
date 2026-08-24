import type {
  AgentCreateRequest,
  AgentCreateResult,
  AgentEvent,
  AgentPromptContent,
  AgentPromptResult,
  AgentProvider
} from '../shared/agent'
import type {
  FirstMateActionResult,
  FirstMateExternalProject,
  FirstMateInstallResult,
  FirstMateLifecycleStatus,
  FirstMateProjectRegistration,
  FirstMateProjectSelection,
  FirstMateQuotaStatus,
  FirstMateRuntimeStatus
} from '../shared/firstmate'
import type {
  ConversationPreview,
  ProjectDirectory,
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalExit,
  TerminalOutput,
  TerminalSession,
  WorkspaceSaveResult,
  WorkspaceState
} from '../shared/terminal'

export interface AgentApi {
  create(request: AgentCreateRequest): Promise<AgentCreateResult>
  prompt(id: string, content: AgentPromptContent): Promise<AgentPromptResult>
  promptWhenIdle(id: string, content: AgentPromptContent): Promise<AgentPromptResult>
  setMode(id: string, modeId: string): Promise<AgentPromptResult>
  setModel(id: string, modelId: string): Promise<AgentPromptResult>
  setEffort(id: string, effortId: string): Promise<AgentPromptResult>
  authenticate(id: string, methodId: string): Promise<AgentCreateResult>
  submitAuthCode(id: string, code: string): Promise<AgentPromptResult>
  openAuthLink(url: string): Promise<void>
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
  write(sessionId: string, incarnationId: string, data: string): void
  resize(sessionId: string, incarnationId: string, cols: number, rows: number): void
  kill(sessionId: string, incarnationId: string, attachmentId: string): void
  copyText(text: string): void
  readClipboardText(): string
  onData(sessionId: string, attachmentId: string, callback: (output: TerminalOutput) => void): () => void
  onExit(sessionId: string, attachmentId: string, callback: (result: TerminalExit) => void): () => void
  onSession(sessionId: string, attachmentId: string, callback: (result: TerminalSession) => void): () => void
}

export interface FirstMateApi {
  status(): Promise<FirstMateRuntimeStatus>
  install(): Promise<FirstMateInstallResult>
  repair(): Promise<FirstMateInstallResult>
  authenticateGitHub(): Promise<FirstMateActionResult>
  trustCodexProject(): Promise<FirstMateActionResult>
  lifecycle(): Promise<FirstMateLifecycleStatus>
  viewWorkerTerminal(taskId: string): Promise<FirstMateActionResult>
  quotaStatus(provider: AgentProvider): Promise<FirstMateQuotaStatus>
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
