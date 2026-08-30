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
  TerminalScrollbackSnapshot,
  WorkspaceLoadResult,
  WorkspaceSaveResult,
  WorkspaceState
} from '../shared/terminal'
import type {
  WorktreeCreateRequest,
  WorktreeCreateResult,
  WorktreeDiscoverRequest,
  WorktreeDiscoverResult,
  WorktreeRemoveRequest,
  WorktreeRemoveResult,
  WorktreeStatus
} from '../shared/worktree'
import type { ConversationListPage, ConversationListRequest } from '../shared/conversation'
import type { ConversationTitle, ConversationTitleSource } from '../shared/conversation-title'

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
  /** Historical display data only; never proof that a process is alive or safe to write to. */
  scrollback(sessionId: string): Promise<TerminalScrollbackSnapshot | null>
  /** False means the retained files could not be completely removed. */
  removeScrollback(sessionId: string): Promise<boolean>
  copyText(text: string): void
  openExternal(url: string): Promise<void>
  /** Selects a file in the OS file manager; never opens or executes it. */
  showItemInFolder(path: string): Promise<void>
  readClipboardText(): string
  onData(sessionId: string, attachmentId: string, callback: (output: TerminalOutput) => void): () => void
  onExit(sessionId: string, attachmentId: string, callback: (result: TerminalExit) => void): () => void
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
  /** Worktrees git knows about that the workspace has no record of yet. */
  discover(request: WorktreeDiscoverRequest): Promise<WorktreeDiscoverResult>
}

export interface ConversationApi {
  /** Past conversations for the given directories, newest first and read one page at a time. */
  list(request: ConversationListRequest): Promise<ConversationListPage>
  /** Whether a listed transcript is still on disk. */
  exists(path: string): Promise<boolean>
  setTitle(provider: 'claude' | 'codex', conversationId: string, title: string, source: ConversationTitleSource): Promise<ConversationTitle | null>
}

declare global {
  interface Window {
    terminalApi: TerminalApi
    agentApi: AgentApi
    usageApi: UsageApi
    worktreeApi: WorktreeApi
    conversationApi: ConversationApi
  }
}
