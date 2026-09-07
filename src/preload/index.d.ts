import type {
  AgentCreateRequest,
  AgentDecisionResponseContent,
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
import type { WorkspaceFileIndex } from '../shared/workspace-files'
import type { RemoteAccessSettings, RemoteAccessState, RemoteWorkspaceProjection } from '../shared/remote-access'
import type { RemoteChatSpawnRequest, RemoteChatSpawnResult } from '../shared/remote-spawn'
import type { ConversationTitle, ConversationTitleSource } from '../shared/conversation-title'
import type { BrainDumpApi } from '../shared/brain-dump'
import type { TicketFilesApi, TicketGithubApi } from '../shared/ticket-source'
import type { AppUpdateApi } from '../shared/app-update'
import type { VoiceModelApi } from '../shared/voice-model'
import type { FileViewApi } from '../shared/file-view'
import type { AdapterManagementApi } from '../shared/adapter-management'

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
  resolveElicitation(id: string, requestId: string, content?: AgentDecisionResponseContent): void
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

export interface WorkspaceFilesApi {
  /**
   * A bounded, cached listing of one working directory for the composer's `@` picker. Always the
   * node's resolved `workingDirectory` - a worktree session must never be offered the checkout's
   * files, since the reference it inserts would point at the wrong tree.
   */
  index(root: string): Promise<WorkspaceFileIndex>
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
  setTitle(
    provider: 'claude' | 'codex',
    conversationId: string,
    title: string,
    source: ConversationTitleSource
  ): Promise<ConversationTitle | null>
}

export interface RemoteApi {
  state(): Promise<RemoteAccessState>
  /** Starts, stops or rebinds the listener and returns the state that actually took effect. */
  applySettings(settings: RemoteAccessSettings): Promise<RemoteAccessState>
  /** Mints a new pairing token; clients holding the old one are unauthorized from then on. */
  regenerateToken(): Promise<RemoteAccessState>
  /** The canvas projection a paired phone lists. The canvas stays its only authority. */
  publishWorkspace(projection: RemoteWorkspaceProjection): void
  onStateChange(callback: (state: RemoteAccessState) => void): () => void
  /**
   * A spawn the host wants performed. Node identity and geometry are the canvas's, so main asks
   * rather than mints; the renderer answers on `completeSpawn` once the session is up or has
   * failed, and the phone's HTTP request is waiting on exactly that answer.
   */
  onSpawnChat(callback: (requestId: string, request: RemoteChatSpawnRequest) => void): () => void
  completeSpawn(requestId: string, result: RemoteChatSpawnResult): void
}

declare global {
  interface Window {
    adapterManagementApi: AdapterManagementApi
    terminalApi: TerminalApi
    agentApi: AgentApi
    workspaceFilesApi: WorkspaceFilesApi
    usageApi: UsageApi
    worktreeApi: WorktreeApi
    conversationApi: ConversationApi
    remoteApi: RemoteApi
    brainDumpApi: BrainDumpApi
    ticketsApi: TicketFilesApi
    githubIssuesApi: TicketGithubApi
    fileViewApi: FileViewApi
    appUpdateApi: AppUpdateApi
    voiceModelApi: VoiceModelApi
  }
}
