import type {
  AgentCreateRequest,
  AgentCreateResult,
  AgentEvent,
  AgentPromptContent,
  AgentPromptResult,
  ProviderRateLimits
} from '../shared/agent'
import type {
  ConversationPreview,
  ProjectDirectory,
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalExit,
  TerminalOutput,
  TerminalSession,
  WorkspaceLoadResult,
  WorkspaceSaveResult,
  WorkspaceState
} from '../shared/terminal'
import type {
  WorktreeCreateRequest,
  WorktreeCreateResult,
  WorktreeRemoveRequest,
  WorktreeRemoveResult,
  WorktreeStatus
} from '../shared/worktree'

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
  loadWorkspace(): Promise<WorkspaceLoadResult>
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

export interface UsageApi {
  /** Account-wide plan usage windows per provider; omits a provider with nothing to report. */
  rateLimits(): Promise<ProviderRateLimits>
}

export interface WorktreeApi {
  create(request: WorktreeCreateRequest): Promise<WorktreeCreateResult>
  status(request: { path: string; branch: string; baseRef: string }): Promise<WorktreeStatus>
  /** Refuses with blockers unless the worktree is provably free of unique work, or force is set. */
  remove(request: WorktreeRemoveRequest): Promise<WorktreeRemoveResult>
}

declare global {
  interface Window {
    terminalApi: TerminalApi
    agentApi: AgentApi
    usageApi: UsageApi
    worktreeApi: WorktreeApi
  }
}
