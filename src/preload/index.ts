import { clipboard, contextBridge, ipcRenderer } from 'electron'
import type {
  AgentCreateRequest,
  AgentDecisionResponseContent,
  AgentCreateResult,
  AgentEventEnvelope,
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
import type { ConversationTitleSource } from '../shared/conversation-title'
import type {
  BrainDumpApi,
  BrainDumpCaptureRequest,
  BrainDumpCaptureState,
  BrainDumpCollection,
  BrainDumpOutcome
} from '../shared/brain-dump'

const terminalApi = {
  getInitialProject: (): Promise<ProjectDirectory> => ipcRenderer.invoke('project:initial'),
  pickProject: (): Promise<ProjectDirectory | null> => ipcRenderer.invoke('project:pick'),
  loadWorkspace: (): Promise<WorkspaceLoadResult> => ipcRenderer.invoke('workspace:load'),
  saveWorkspace: (state: WorkspaceState): Promise<WorkspaceSaveResult> => ipcRenderer.invoke('workspace:save', state),
  getConversationPreview: (kind: 'claude' | 'codex', conversationId: string): Promise<ConversationPreview | null> =>
    ipcRenderer.invoke('terminal:preview', kind, conversationId),
  create: (request: TerminalCreateRequest): Promise<TerminalCreateResult> =>
    ipcRenderer.invoke('terminal:create', request),
  write: (sessionId: string, incarnationId: string, data: string): void =>
    ipcRenderer.send('terminal:write', sessionId, incarnationId, data),
  resize: (sessionId: string, incarnationId: string, cols: number, rows: number): void =>
    ipcRenderer.send('terminal:resize', sessionId, incarnationId, cols, rows),
  kill: (sessionId: string, incarnationId: string, attachmentId: string): void =>
    ipcRenderer.send('terminal:kill', sessionId, incarnationId, attachmentId),
  scrollback: (sessionId: string): Promise<TerminalScrollbackSnapshot | null> =>
    ipcRenderer.invoke('terminal:scrollback', sessionId),
  removeScrollback: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke('terminal:scrollback-remove', sessionId),
  copyText: (text: string): void => clipboard.writeText(text),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),
  showItemInFolder: (path: string): Promise<void> => ipcRenderer.invoke('shell:show-item-in-folder', path),
  readClipboardText: (): string => clipboard.readText(),
  onData: (sessionId: string, attachmentId: string, callback: (output: TerminalOutput) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, output: TerminalOutput): void => {
      if (output.sessionId === sessionId && output.attachmentId === attachmentId) callback(output)
    }
    ipcRenderer.on('terminal:data', listener)
    return () => ipcRenderer.removeListener('terminal:data', listener)
  },
  onExit: (sessionId: string, attachmentId: string, callback: (result: TerminalExit) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: TerminalExit): void => {
      if (result.sessionId === sessionId && result.attachmentId === attachmentId) callback(result)
    }
    ipcRenderer.on('terminal:exit', listener)
    return () => ipcRenderer.removeListener('terminal:exit', listener)
  }
}

contextBridge.exposeInMainWorld('terminalApi', terminalApi)

const agentApi = {
  create: (request: AgentCreateRequest): Promise<AgentCreateResult> => ipcRenderer.invoke('agent:create', request),
  prompt: (id: string, content: AgentPromptContent): Promise<AgentPromptResult> =>
    ipcRenderer.invoke('agent:prompt', id, content),
  promptWhenIdle: (id: string, content: AgentPromptContent): Promise<AgentPromptResult> =>
    ipcRenderer.invoke('agent:prompt-when-idle', id, content),
  setMode: (id: string, modeId: string): Promise<AgentPromptResult> => ipcRenderer.invoke('agent:set-mode', id, modeId),
  setModel: (id: string, modelId: string): Promise<AgentPromptResult> =>
    ipcRenderer.invoke('agent:set-model', id, modelId),
  setEffort: (id: string, effortId: string): Promise<AgentPromptResult> =>
    ipcRenderer.invoke('agent:set-effort', id, effortId),
  authenticate: (id: string, methodId: string): Promise<AgentCreateResult> =>
    ipcRenderer.invoke('agent:authenticate', id, methodId),
  submitAuthCode: (id: string, code: string): Promise<AgentPromptResult> =>
    ipcRenderer.invoke('agent:submit-auth-code', id, code),
  openAuthLink: (url: string): Promise<void> => ipcRenderer.invoke('agent:open-auth-link', url),
  resolveApproval: (id: string, approvalId: string, optionId?: string): void =>
    ipcRenderer.send('agent:approval', id, approvalId, optionId),
  resolveElicitation: (id: string, requestId: string, content?: AgentDecisionResponseContent): void =>
    ipcRenderer.send('agent:elicitation', id, requestId, content),
  cancel: (id: string): void => ipcRenderer.send('agent:cancel', id),
  kill: (id: string): void => ipcRenderer.send('agent:kill', id),
  onEvent: (id: string, callback: (event: AgentEventEnvelope['event']) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, envelope: AgentEventEnvelope): void => {
      if (envelope.id === id) callback(envelope.event)
    }
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  }
}

contextBridge.exposeInMainWorld('agentApi', agentApi)

const usageApi = {
  rateLimits: (): Promise<ProviderRateLimits> => ipcRenderer.invoke('usage:rate-limits')
}

contextBridge.exposeInMainWorld('usageApi', usageApi)

const worktreeApi = {
  create: (request: WorktreeCreateRequest): Promise<WorktreeCreateResult> =>
    ipcRenderer.invoke('worktree:create', request),
  status: (request: { path: string; branch: string; baseRef: string }): Promise<WorktreeStatus> =>
    ipcRenderer.invoke('worktree:status', request),
  remove: (request: WorktreeRemoveRequest): Promise<WorktreeRemoveResult> =>
    ipcRenderer.invoke('worktree:remove', request),
  discover: (request: WorktreeDiscoverRequest): Promise<WorktreeDiscoverResult> =>
    ipcRenderer.invoke('worktree:discover', request)
}

contextBridge.exposeInMainWorld('worktreeApi', worktreeApi)

const conversationApi = {
  list: (request: ConversationListRequest): Promise<ConversationListPage> =>
    ipcRenderer.invoke('conversation:list', request),
  exists: (path: string): Promise<boolean> => ipcRenderer.invoke('conversation:exists', path),
  setTitle: (provider: 'claude' | 'codex', conversationId: string, title: string, source: ConversationTitleSource) =>
    ipcRenderer.invoke('conversation:set-title', provider, conversationId, title, source)
}

contextBridge.exposeInMainWorld('conversationApi', conversationApi)

const brainDumpApi: BrainDumpApi = {
  list: (collection: BrainDumpCollection) => ipcRenderer.invoke('brain-dump:list', collection),
  resolve: (slug: string) => ipcRenderer.invoke('brain-dump:resolve', slug),
  archive: (slug: string, outcome: BrainDumpOutcome) => ipcRenderer.invoke('brain-dump:archive', slug, outcome),
  assignProject: (slug: string, projectPath: string | undefined) =>
    ipcRenderer.invoke('brain-dump:assign-project', slug, projectPath),
  startCapture: (request: BrainDumpCaptureRequest) => ipcRenderer.invoke('brain-dump:capture-start', request),
  currentCapture: () => ipcRenderer.invoke('brain-dump:capture-current'),
  resolveCaptureApproval: (jobId: string, approvalId: string, optionId?: string) =>
    ipcRenderer.invoke('brain-dump:capture-approval', jobId, approvalId, optionId),
  cancelCapture: (jobId: string) => ipcRenderer.invoke('brain-dump:capture-cancel', jobId),
  onCapture: (callback: (state: BrainDumpCaptureState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: BrainDumpCaptureState): void => callback(state)
    ipcRenderer.on('brain-dump:capture-event', listener)
    return () => ipcRenderer.removeListener('brain-dump:capture-event', listener)
  },
  onLibraryChange: (callback: (collection: BrainDumpCollection) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, collection: BrainDumpCollection): void => callback(collection)
    ipcRenderer.on('brain-dump:library-change', listener)
    return () => ipcRenderer.removeListener('brain-dump:library-change', listener)
  }
}

contextBridge.exposeInMainWorld('brainDumpApi', brainDumpApi)
