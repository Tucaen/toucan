import { clipboard, contextBridge, ipcRenderer } from 'electron'
import type { AgentApi, AgentEventEnvelope, UsageApi } from '../shared/agent'
import type { TerminalApi, TerminalExit, TerminalOutput } from '../shared/terminal'
import type { WorktreeApi } from '../shared/worktree'
import type { ConversationApi } from '../shared/conversation'
import type { WorkspaceFilesApi } from '../shared/workspace-files'
import type { RemoteAccessState } from '../shared/remote-access'
import type { RemoteApi } from '../shared/remote-api'
import type { RemoteChatSpawnRequest } from '../shared/remote-spawn'
import type { BrainDumpApi, BrainDumpCaptureState, BrainDumpCollection } from '../shared/brain-dump'
import type { TicketFilesApi, TicketGithubApi } from '../shared/ticket-source'
import type { TicketSkillApi } from '../shared/ticket-skill'
import type { FileViewApi } from '../shared/file-view'
import type { AppUpdateApi, AppUpdateSnapshot } from '../shared/app-update'
import type { VoiceModelApi, VoiceModelStatus } from '../shared/voice-model'
import type { AdapterManagementApi, AdapterSnapshot } from '../shared/adapter-management'
import type { TerminalContextApi } from '../shared/terminal-context'
import type { ProjectAvatarApi } from '../shared/project-avatar'
import {
  ADAPTER_CHANNELS,
  AGENT_CHANNELS,
  APP_UPDATE_CHANNELS,
  BRAIN_DUMP_CHANNELS,
  CONVERSATION_CHANNELS,
  FILE_VIEW_CHANNELS,
  GITHUB_ISSUES_CHANNELS,
  PROJECT_CHANNELS,
  REMOTE_CHANNELS,
  SHELL_CHANNELS,
  TERMINAL_CHANNELS,
  TERMINAL_CONTEXT_CHANNELS,
  TICKET_CHANNELS,
  USAGE_CHANNELS,
  VOICE_MODEL_CHANNELS,
  WORKSPACE_CHANNELS,
  WORKTREE_CHANNELS
} from '../shared/ipc-channels'

/**
 * One `ipcRenderer.on` subscription behind a disposer, so every `on*` member reads the same way
 * and none can forget to remove its listener.
 */
function subscribe<Args extends unknown[]>(channel: string, listener: (...args: Args) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, ...args: Args): void => listener(...args)
  ipcRenderer.on(channel, wrapped as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void)
  return () => {
    ipcRenderer.removeListener(channel, wrapped as (event: Electron.IpcRendererEvent, ...args: unknown[]) => void)
  }
}

const adapterManagementApi: AdapterManagementApi = {
  state: () => ipcRenderer.invoke(ADAPTER_CHANNELS.state),
  check: (provider) => ipcRenderer.invoke(ADAPTER_CHANNELS.check, provider),
  select: (provider, version) => ipcRenderer.invoke(ADAPTER_CHANNELS.select, provider, version),
  onChange: (callback) => subscribe(ADAPTER_CHANNELS.changed, (snapshot: AdapterSnapshot) => callback(snapshot))
}
contextBridge.exposeInMainWorld('adapterManagementApi', adapterManagementApi)

const terminalApi: TerminalApi = {
  getInitialProject: () => ipcRenderer.invoke(PROJECT_CHANNELS.initial),
  pickProject: () => ipcRenderer.invoke(PROJECT_CHANNELS.pick),
  loadWorkspace: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.load),
  saveWorkspace: (state) => ipcRenderer.invoke(WORKSPACE_CHANNELS.save, state),
  getConversationPreview: (kind, conversationId) => ipcRenderer.invoke(TERMINAL_CHANNELS.preview, kind, conversationId),
  create: (request) => ipcRenderer.invoke(TERMINAL_CHANNELS.create, request),
  write: (sessionId, incarnationId, data) => ipcRenderer.send(TERMINAL_CHANNELS.write, sessionId, incarnationId, data),
  resize: (sessionId, incarnationId, cols, rows) =>
    ipcRenderer.send(TERMINAL_CHANNELS.resize, sessionId, incarnationId, cols, rows),
  kill: (sessionId, incarnationId, attachmentId) =>
    ipcRenderer.send(TERMINAL_CHANNELS.kill, sessionId, incarnationId, attachmentId),
  scrollback: (sessionId) => ipcRenderer.invoke(TERMINAL_CHANNELS.scrollback, sessionId),
  removeScrollback: (sessionId) => ipcRenderer.invoke(TERMINAL_CHANNELS.scrollbackRemove, sessionId),
  copyText: (text) => clipboard.writeText(text),
  openExternal: (url) => ipcRenderer.invoke(SHELL_CHANNELS.openExternal, url),
  showItemInFolder: (path) => ipcRenderer.invoke(SHELL_CHANNELS.showItemInFolder, path),
  openLocalFile: (path) => ipcRenderer.invoke(SHELL_CHANNELS.openLocalFile, path),
  saveImage: (request) => ipcRenderer.invoke(SHELL_CHANNELS.saveImage, request),
  readClipboardText: () => clipboard.readText(),
  onData: (sessionId, attachmentId, callback) =>
    subscribe(TERMINAL_CHANNELS.data, (output: TerminalOutput) => {
      if (output.sessionId === sessionId && output.attachmentId === attachmentId) callback(output)
    }),
  onExit: (sessionId, attachmentId, callback) =>
    subscribe(TERMINAL_CHANNELS.exit, (result: TerminalExit) => {
      if (result.sessionId === sessionId && result.attachmentId === attachmentId) callback(result)
    })
}

contextBridge.exposeInMainWorld('terminalApi', terminalApi)

/** The canvas mirrors its terminal-context edges into main's registry; full-set replace, one way. */
const terminalContextApi: TerminalContextApi = {
  replaceEdges: (edges) => ipcRenderer.send(TERMINAL_CONTEXT_CHANNELS.replaceEdges, edges)
}

contextBridge.exposeInMainWorld('terminalContextApi', terminalContextApi)

const projectAvatarApi: ProjectAvatarApi = {
  choose: (projectId) => ipcRenderer.invoke(PROJECT_CHANNELS.avatarChoose, projectId),
  read: (projectId) => ipcRenderer.invoke(PROJECT_CHANNELS.avatarRead, projectId),
  remove: (projectId) => ipcRenderer.invoke(PROJECT_CHANNELS.avatarRemove, projectId)
}

contextBridge.exposeInMainWorld('projectAvatarApi', projectAvatarApi)

const agentApi: AgentApi = {
  create: (request) => ipcRenderer.invoke(AGENT_CHANNELS.create, request),
  prompt: (id, content) => ipcRenderer.invoke(AGENT_CHANNELS.prompt, id, content),
  promptWhenIdle: (id, content) => ipcRenderer.invoke(AGENT_CHANNELS.promptWhenIdle, id, content),
  setMode: (id, modeId) => ipcRenderer.invoke(AGENT_CHANNELS.setMode, id, modeId),
  setModel: (id, modelId) => ipcRenderer.invoke(AGENT_CHANNELS.setModel, id, modelId),
  setEffort: (id, effortId) => ipcRenderer.invoke(AGENT_CHANNELS.setEffort, id, effortId),
  authenticate: (id, methodId) => ipcRenderer.invoke(AGENT_CHANNELS.authenticate, id, methodId),
  submitAuthCode: (id, code) => ipcRenderer.invoke(AGENT_CHANNELS.submitAuthCode, id, code),
  openAuthLink: (url) => ipcRenderer.invoke(AGENT_CHANNELS.openAuthLink, url),
  resolveApproval: (id, approvalId, optionId) => ipcRenderer.send(AGENT_CHANNELS.approval, id, approvalId, optionId),
  resolveElicitation: (id, requestId, content) => ipcRenderer.send(AGENT_CHANNELS.elicitation, id, requestId, content),
  cancel: (id) => ipcRenderer.send(AGENT_CHANNELS.cancel, id),
  kill: (id) => ipcRenderer.send(AGENT_CHANNELS.kill, id),
  onEvent: (id, callback) =>
    subscribe(AGENT_CHANNELS.event, (envelope: AgentEventEnvelope) => {
      if (envelope.id === id) callback(envelope.event)
    })
}

contextBridge.exposeInMainWorld('agentApi', agentApi)

const workspaceFilesApi: WorkspaceFilesApi = {
  index: (root) => ipcRenderer.invoke(WORKSPACE_CHANNELS.fileIndex, root)
}

contextBridge.exposeInMainWorld('workspaceFilesApi', workspaceFilesApi)

const usageApi: UsageApi = {
  rateLimits: (options) => ipcRenderer.invoke(USAGE_CHANNELS.rateLimits, options)
}

contextBridge.exposeInMainWorld('usageApi', usageApi)

const worktreeApi: WorktreeApi = {
  create: (request) => ipcRenderer.invoke(WORKTREE_CHANNELS.create, request),
  status: (request) => ipcRenderer.invoke(WORKTREE_CHANNELS.status, request),
  remove: (request) => ipcRenderer.invoke(WORKTREE_CHANNELS.remove, request),
  discover: (request) => ipcRenderer.invoke(WORKTREE_CHANNELS.discover, request),
  diff: (request) => ipcRenderer.invoke(WORKTREE_CHANNELS.diff, request),
  diffFile: (request) => ipcRenderer.invoke(WORKTREE_CHANNELS.diffFile, request),
  currentBranch: (path) => ipcRenderer.invoke(WORKTREE_CHANNELS.currentBranch, path),
  listBranches: (path) => ipcRenderer.invoke(WORKTREE_CHANNELS.listBranches, path),
  checkoutBranch: (request) => ipcRenderer.invoke(WORKTREE_CHANNELS.checkoutBranch, request)
}

contextBridge.exposeInMainWorld('worktreeApi', worktreeApi)

const conversationApi: ConversationApi = {
  list: (request) => ipcRenderer.invoke(CONVERSATION_CHANNELS.list, request),
  exists: (path) => ipcRenderer.invoke(CONVERSATION_CHANNELS.exists, path),
  setTitle: (provider, conversationId, title, source) =>
    ipcRenderer.invoke(CONVERSATION_CHANNELS.setTitle, provider, conversationId, title, source)
}

contextBridge.exposeInMainWorld('conversationApi', conversationApi)

const remoteApi: RemoteApi = {
  state: () => ipcRenderer.invoke(REMOTE_CHANNELS.state),
  applySettings: (settings) => ipcRenderer.invoke(REMOTE_CHANNELS.applySettings, settings),
  regenerateToken: () => ipcRenderer.invoke(REMOTE_CHANNELS.regenerateToken),
  publishWorkspace: (projection) => ipcRenderer.send(REMOTE_CHANNELS.publishWorkspace, projection),
  onStateChange: (callback) => subscribe(REMOTE_CHANNELS.stateChanged, (state: RemoteAccessState) => callback(state)),
  onSpawnChat: (callback) =>
    subscribe(REMOTE_CHANNELS.spawnChat, (requestId: string, request: RemoteChatSpawnRequest) =>
      callback(requestId, request)
    ),
  completeSpawn: (requestId, result) => ipcRenderer.send(REMOTE_CHANNELS.spawnChatResult, requestId, result),
  onMarkChatRead: (callback) => subscribe(REMOTE_CHANNELS.markChatRead, (chatId: string) => callback(chatId))
}

contextBridge.exposeInMainWorld('remoteApi', remoteApi)

const brainDumpApi: BrainDumpApi = {
  list: (collection) => ipcRenderer.invoke(BRAIN_DUMP_CHANNELS.list, collection),
  resolve: (slug) => ipcRenderer.invoke(BRAIN_DUMP_CHANNELS.resolve, slug),
  archive: (slug, outcome) => ipcRenderer.invoke(BRAIN_DUMP_CHANNELS.archive, slug, outcome),
  assignProject: (slug, projectPath) => ipcRenderer.invoke(BRAIN_DUMP_CHANNELS.assignProject, slug, projectPath),
  startCapture: (request) => ipcRenderer.invoke(BRAIN_DUMP_CHANNELS.captureStart, request),
  currentCapture: () => ipcRenderer.invoke(BRAIN_DUMP_CHANNELS.captureCurrent),
  resolveCaptureApproval: (jobId, approvalId, optionId) =>
    ipcRenderer.invoke(BRAIN_DUMP_CHANNELS.captureApproval, jobId, approvalId, optionId),
  cancelCapture: (jobId) => ipcRenderer.invoke(BRAIN_DUMP_CHANNELS.captureCancel, jobId),
  onCapture: (callback) =>
    subscribe(BRAIN_DUMP_CHANNELS.captureEvent, (state: BrainDumpCaptureState) => callback(state)),
  onLibraryChange: (callback) =>
    subscribe(BRAIN_DUMP_CHANNELS.libraryChange, (collection: BrainDumpCollection) => callback(collection))
}

contextBridge.exposeInMainWorld('brainDumpApi', brainDumpApi)

/** The files ticket source, seen from the renderer. Other sources reach the board differently. */
const ticketsApi: TicketFilesApi = {
  list: (projectPath) => ipcRenderer.invoke(TICKET_CHANNELS.list, projectPath),
  setStatus: (projectPath, slug, status) => ipcRenderer.invoke(TICKET_CHANNELS.setStatus, projectPath, slug, status),
  remove: (projectPath, slug) => ipcRenderer.invoke(TICKET_CHANNELS.remove, projectPath, slug),
  isGitRepository: (projectPath) => ipcRenderer.invoke(TICKET_CHANNELS.isGitRepository, projectPath),
  revealInFolder: (projectPath, slug) => void ipcRenderer.invoke(TICKET_CHANNELS.reveal, projectPath, slug),
  onChange: (callback) => subscribe(TICKET_CHANNELS.changed, (projectPath: string) => callback(projectPath))
}

contextBridge.exposeInMainWorld('ticketsApi', ticketsApi)

/** Scaffolding a project its own tickets skill: about the checkout, not about any one ticket. */
const ticketSkillApi: TicketSkillApi = {
  state: (projectPath) => ipcRenderer.invoke(TICKET_CHANNELS.skillState, projectPath),
  write: (projectPath) => ipcRenderer.invoke(TICKET_CHANNELS.writeSkill, projectPath),
  revealInFolder: (projectPath) => void ipcRenderer.invoke(TICKET_CHANNELS.revealSkill, projectPath)
}

contextBridge.exposeInMainWorld('ticketSkillApi', ticketSkillApi)

const githubIssuesApi: TicketGithubApi = {
  availability: (projectPath) => ipcRenderer.invoke(GITHUB_ISSUES_CHANNELS.availability, projectPath),
  list: (projectPath) => ipcRenderer.invoke(GITHUB_ISSUES_CHANNELS.list, projectPath)
}

contextBridge.exposeInMainWorld('githubIssuesApi', githubIssuesApi)

/** One project file for the canvas's file node; main decides what is readable and writable. */
const fileViewApi: FileViewApi = {
  read: (path) => ipcRenderer.invoke(FILE_VIEW_CHANNELS.read, path),
  write: (request) => ipcRenderer.invoke(FILE_VIEW_CHANNELS.write, request),
  watch: (path) => ipcRenderer.invoke(FILE_VIEW_CHANNELS.watch, path),
  unwatch: (path) => ipcRenderer.invoke(FILE_VIEW_CHANNELS.unwatch, path),
  onChange: (callback) => subscribe(FILE_VIEW_CHANNELS.changed, (path: string) => callback(path))
}

contextBridge.exposeInMainWorld('fileViewApi', fileViewApi)

const appUpdateApi: AppUpdateApi = {
  state: () => ipcRenderer.invoke(APP_UPDATE_CHANNELS.state),
  check: () => ipcRenderer.invoke(APP_UPDATE_CHANNELS.check),
  restart: () => ipcRenderer.invoke(APP_UPDATE_CHANNELS.restart),
  onChange: (callback) => subscribe(APP_UPDATE_CHANNELS.changed, (snapshot: AppUpdateSnapshot) => callback(snapshot))
}

contextBridge.exposeInMainWorld('appUpdateApi', appUpdateApi)

const voiceModelApi: VoiceModelApi = {
  state: () => ipcRenderer.invoke(VOICE_MODEL_CHANNELS.state),
  ensure: () => ipcRenderer.invoke(VOICE_MODEL_CHANNELS.ensure),
  files: () => ipcRenderer.invoke(VOICE_MODEL_CHANNELS.files),
  onChange: (callback) => subscribe(VOICE_MODEL_CHANNELS.changed, (status: VoiceModelStatus) => callback(status))
}

contextBridge.exposeInMainWorld('voiceModelApi', voiceModelApi)
