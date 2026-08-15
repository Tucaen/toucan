import { clipboard, contextBridge, ipcRenderer } from 'electron'
import type {
  AgentCreateRequest,
  AgentCreateResult,
  AgentEventEnvelope,
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
  TerminalExit,
  TerminalOutput,
  TerminalSession,
  WorkspaceSaveResult,
  WorkspaceState
} from '../shared/terminal'

const terminalApi = {
  getInitialProject: (): Promise<ProjectDirectory> => ipcRenderer.invoke('project:initial'),
  pickProject: (): Promise<ProjectDirectory | null> => ipcRenderer.invoke('project:pick'),
  loadWorkspace: (): Promise<WorkspaceState | null> => ipcRenderer.invoke('workspace:load'),
  saveWorkspace: (state: WorkspaceState): Promise<WorkspaceSaveResult> =>
    ipcRenderer.invoke('workspace:save', state),
  getConversationPreview: (
    kind: 'claude' | 'codex',
    conversationId: string
  ): Promise<ConversationPreview | null> => ipcRenderer.invoke('terminal:preview', kind, conversationId),
  create: (request: TerminalCreateRequest): Promise<TerminalCreateResult> =>
    ipcRenderer.invoke('terminal:create', request),
  write: (id: string, data: string): void => ipcRenderer.send('terminal:write', id, data),
  resize: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('terminal:resize', id, cols, rows),
  kill: (id: string): void => ipcRenderer.send('terminal:kill', id),
  copyText: (text: string): void => clipboard.writeText(text),
  readClipboardText: (): string => clipboard.readText(),
  onData: (id: string, callback: (data: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, output: TerminalOutput): void => {
      if (output.id === id) callback(output.data)
    }
    ipcRenderer.on('terminal:data', listener)
    return () => ipcRenderer.removeListener('terminal:data', listener)
  },
  onExit: (id: string, callback: (exitCode: number) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: TerminalExit): void => {
      if (result.id === id) callback(result.exitCode)
    }
    ipcRenderer.on('terminal:exit', listener)
    return () => ipcRenderer.removeListener('terminal:exit', listener)
  },
  onSession: (id: string, callback: (conversationId: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: TerminalSession): void => {
      if (result.id === id) callback(result.conversationId)
    }
    ipcRenderer.on('terminal:session', listener)
    return () => ipcRenderer.removeListener('terminal:session', listener)
  }
}

contextBridge.exposeInMainWorld('terminalApi', terminalApi)

const agentApi = {
  create: (request: AgentCreateRequest): Promise<AgentCreateResult> => ipcRenderer.invoke('agent:create', request),
  prompt: (id: string, text: string): Promise<AgentPromptResult> => ipcRenderer.invoke('agent:prompt', id, text),
  setMode: (id: string, modeId: string): Promise<AgentPromptResult> => ipcRenderer.invoke('agent:set-mode', id, modeId),
  setModel: (id: string, modelId: string): Promise<AgentPromptResult> => (
    ipcRenderer.invoke('agent:set-model', id, modelId)
  ),
  authenticate: (id: string, methodId: string): Promise<AgentCreateResult> => (
    ipcRenderer.invoke('agent:authenticate', id, methodId)
  ),
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

const firstMateApi = {
  status: (): Promise<FirstMateRuntimeStatus> => ipcRenderer.invoke('firstmate:status'),
  install: (): Promise<FirstMateInstallResult> => ipcRenderer.invoke('firstmate:install'),
  authenticateGitHub: (): Promise<FirstMateActionResult> => ipcRenderer.invoke('firstmate:github-auth'),
  trustCodexProject: (): Promise<FirstMateActionResult> => ipcRenderer.invoke('firstmate:trust-codex'),
  lifecycle: (): Promise<FirstMateLifecycleStatus> => ipcRenderer.invoke('firstmate:lifecycle'),
  releaseDispatch: (taskId: string): Promise<FirstMateActionResult> => (
    ipcRenderer.invoke('firstmate:release-dispatch', taskId)
  ),
  retryDispatch: (taskId: string): Promise<FirstMateActionResult> => (
    ipcRenderer.invoke('firstmate:retry-dispatch', taskId)
  ),
  registerProject: (selection: FirstMateProjectSelection): Promise<FirstMateProjectRegistration> => (
    ipcRenderer.invoke('firstmate:register-project', selection)
  ),
  recordedProject: (adeProjectId: string): Promise<FirstMateExternalProject | null> => (
    ipcRenderer.invoke('firstmate:recorded-project', adeProjectId)
  ),
  authorizeProjectInitialization: (adeProjectId: string): Promise<FirstMateProjectRegistration> => (
    ipcRenderer.invoke('firstmate:authorize-project-init', adeProjectId)
  ),
  retireProject: (adeProjectId: string): Promise<FirstMateActionResult> => (
    ipcRenderer.invoke('firstmate:retire-project', adeProjectId)
  )
}

contextBridge.exposeInMainWorld('firstMateApi', firstMateApi)
