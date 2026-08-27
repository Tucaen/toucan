import { clipboard, contextBridge, ipcRenderer } from 'electron'
import type {
  AgentCreateRequest,
  AgentCreateResult,
  AgentEventEnvelope,
  AgentPromptContent,
  AgentPromptResult,
  AgentRateLimitStatus
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

const terminalApi = {
  getInitialProject: (): Promise<ProjectDirectory> => ipcRenderer.invoke('project:initial'),
  pickProject: (): Promise<ProjectDirectory | null> => ipcRenderer.invoke('project:pick'),
  loadWorkspace: (): Promise<WorkspaceLoadResult> => ipcRenderer.invoke('workspace:load'),
  saveWorkspace: (state: WorkspaceState): Promise<WorkspaceSaveResult> =>
    ipcRenderer.invoke('workspace:save', state),
  getConversationPreview: (
    kind: 'claude' | 'codex',
    conversationId: string
  ): Promise<ConversationPreview | null> => ipcRenderer.invoke('terminal:preview', kind, conversationId),
  create: (request: TerminalCreateRequest): Promise<TerminalCreateResult> =>
    ipcRenderer.invoke('terminal:create', request),
  write: (sessionId: string, incarnationId: string, data: string): void =>
    ipcRenderer.send('terminal:write', sessionId, incarnationId, data),
  resize: (sessionId: string, incarnationId: string, cols: number, rows: number): void =>
    ipcRenderer.send('terminal:resize', sessionId, incarnationId, cols, rows),
  kill: (sessionId: string, incarnationId: string, attachmentId: string): void =>
    ipcRenderer.send('terminal:kill', sessionId, incarnationId, attachmentId),
  copyText: (text: string): void => clipboard.writeText(text),
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
  },
  onSession: (sessionId: string, attachmentId: string, callback: (result: TerminalSession) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: TerminalSession): void => {
      if (result.sessionId === sessionId && result.attachmentId === attachmentId) callback(result)
    }
    ipcRenderer.on('terminal:session', listener)
    return () => ipcRenderer.removeListener('terminal:session', listener)
  }
}

contextBridge.exposeInMainWorld('terminalApi', terminalApi)

const agentApi = {
  create: (request: AgentCreateRequest): Promise<AgentCreateResult> => ipcRenderer.invoke('agent:create', request),
  prompt: (id: string, content: AgentPromptContent): Promise<AgentPromptResult> => (
    ipcRenderer.invoke('agent:prompt', id, content)
  ),
  promptWhenIdle: (id: string, content: AgentPromptContent): Promise<AgentPromptResult> => (
    ipcRenderer.invoke('agent:prompt-when-idle', id, content)
  ),
  setMode: (id: string, modeId: string): Promise<AgentPromptResult> => ipcRenderer.invoke('agent:set-mode', id, modeId),
  setModel: (id: string, modelId: string): Promise<AgentPromptResult> => (
    ipcRenderer.invoke('agent:set-model', id, modelId)
  ),
  setEffort: (id: string, effortId: string): Promise<AgentPromptResult> => (
    ipcRenderer.invoke('agent:set-effort', id, effortId)
  ),
  authenticate: (id: string, methodId: string): Promise<AgentCreateResult> => (
    ipcRenderer.invoke('agent:authenticate', id, methodId)
  ),
  submitAuthCode: (id: string, code: string): Promise<AgentPromptResult> => (
    ipcRenderer.invoke('agent:submit-auth-code', id, code)
  ),
  openAuthLink: (url: string): Promise<void> => ipcRenderer.invoke('agent:open-auth-link', url),
  resolveApproval: (id: string, approvalId: string, optionId?: string): void => (
    ipcRenderer.send('agent:approval', id, approvalId, optionId)
  ),
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
  codexRateLimits: (): Promise<AgentRateLimitStatus | null> => ipcRenderer.invoke('usage:codex-rate-limits')
}

contextBridge.exposeInMainWorld('usageApi', usageApi)

