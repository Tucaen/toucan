import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol, session, shell } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node-pty'
import type { AgentCreateRequest, AgentDecisionResponseContent, AgentPromptContent } from '../shared/agent'
import {
  ADAPTER_CHANNELS,
  AGENT_CHANNELS,
  USAGE_CHANNELS,
  WORKSPACE_CHANNELS,
  WORKTREE_CHANNELS
} from '../shared/ipc-channels'
import { autoUpdater } from 'electron-updater'
import { createAcpSessionManager, type AcpSessionManager } from './acp-session-manager'
import { createAgentModelCatalogueStore } from './agent-model-catalogue-store'
import { createAppUpdater, type AppUpdater } from './app-update'
import { forwardAppUpdateChanges, registerAppUpdateIpc } from './app-update-ipc'
import { createVoiceModelStore, type VoiceModelStore } from './voice-model-store'
import { createMainLog } from './main-log'
import { createVoiceModelPort } from './voice-model-download'
import { forwardVoiceModelChanges, registerVoiceModelIpc } from './voice-model-ipc'
import { createDictationCleaner } from './dictation-cleanup'
import { registerDictationCleanupIpc } from './dictation-cleanup-ipc'
import { APP_INDEX_URL, APP_ISOLATION_HEADERS, APP_SCHEME, appContentType, appRequestTarget } from './app-protocol'
import { createAgentEventBroker } from './agent-event-broker'
import { createBrainDumpLibrary } from './brain-dump-library'
import { hiddenProcessOptions } from './background-process'
import {
  createBrainDumpCaptureManager,
  type BrainDumpCaptureManager,
  type BrainDumpCaptureOwner
} from './brain-dump-capture'
import { createBrainDumpCaptureStore } from './brain-dump-capture-store'
import { registerBrainDumpIpc } from './brain-dump-ipc'
import { createBrainDumpChangeWatcher, type BrainDumpChangeWatcher } from './brain-dump-watcher'
import { createFileView, type FileView } from './file-view'
import { createImageArtifactSaver } from './image-save'
import { createLocalFileOpener } from './local-file-open'
import { createWorkspaceContainment } from './workspace-containment'
import { registerFileViewIpc } from './file-view-ipc'
import { createPrettierFileFormatter } from './file-formatter'
import { createGithubIssueReader } from './github-issues'
import { registerGithubIssuesIpc } from './github-issues-ipc'
import { registerDecisionDelegationIpc } from './decision-delegation-ipc'
import { isDecisionProviderInstalled } from './decision-provider'
import { registerTicketIpc } from './ticket-ipc'
import { createTicketLibrary } from './ticket-library'
import { createTicketSkillScaffold } from './ticket-skill-scaffold'
import { createTicketSteering } from './ticket-steering'
import { createTicketChangeWatcher, type TicketChangeWatcher } from './ticket-watcher'
import { createClaudeUsageReader } from './claude-usage'
import { createConversationHistory } from './conversation-history'
import { createConversationTitleStore } from './conversation-title-store'
import { createCodexRateLimitReader } from './codex-rate-limits'
import { createProviderUsage, type ProviderUsage } from './provider-usage'
import { createRemoteAccessStore } from './remote/remote-access-store'
import { forwardRemoteStateChanges, registerRemoteIpc } from './remote/remote-ipc'
import { createRemoteCanvasRequests, type RemoteCanvasRequests } from './remote/canvas-requests'
import { createRemoteAccessServer, type RemoteAccessServer } from './remote/remote-server'
import { createVoiceTranscriber } from './voice-transcription'
import { loadWhisperEngine, VOICE_MODEL_MISSING_MESSAGE } from './whisper-engine'
import { createSessionOutcomeIndexer } from './session-outcome-indexer'
import { createSessionOutcomeStore } from './session-outcome-store'
import { createTerminalShell } from './terminal-shell'
import { createAdapterManager } from './adapter-manager'
import { createAdapterInstaller } from './adapter-installer'
import { registerAdapterManagementIpc } from './adapter-management-ipc'
import { createTerminalContextRegistry, registerTerminalContextIpc } from './terminal-context-registry'
import { createTerminalContextMcp } from './terminal-context-mcp'
import { createTerminalLivenessStore } from './terminal-liveness-store'
import { createTerminalManager, type TerminalManager } from './terminal-manager'
import { createTerminalScrollbackStore } from './terminal-scrollback-store'
import { registerTerminalIpc } from './terminal-ipc'
import { registerConversationIpc } from './conversation-ipc'
import { createProjectAvatarStore } from './project-avatar-store'
import { registerProjectIpc } from './project-ipc'
import { createWorktreeManager, type WorktreeManager } from './git-worktree'
import { createWorkspaceFileIndex, type WorkspaceFileIndexReader } from './workspace-file-index'
import { createWorkspaceStore } from './workspace-store'
import { projectFor, ticketsDirectoryFor, ticketsRelativeDirectoryFor } from './ticket-directory'
import { githubStatusLabelsFor, type GithubStatusLabels } from '../shared/github-issues'
import type {
  WorktreeCreateRequest,
  WorktreeDiscoverRequest,
  WorktreeRemoveRequest,
  WorktreeStatusRequest
} from '../shared/worktree'
import type { GitDiffRequest, GitFileDiffRequest } from '../shared/git-diff'
import type { GitCheckoutRequest } from '../shared/git-branch'

// Has to run before the app is ready, which is why it is here and not inside a function. The
// privileges are what make the packaged renderer's origin behave like an HTTP one - a secure
// context that `fetch`, the Cache API and cross-origin isolation all accept. See `app-protocol.ts`.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
])

/**
 * Plan usage moves slowly and a Claude read boots a CLI, so this caps how often that happens
 * regardless of how frequently the renderer asks.
 */
const PROVIDER_USAGE_TTL_MS = 5 * 60_000

function localCalendarDate(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function findCommand(command: string): string | null {
  const fallbacks = [
    join(process.env.APPDATA ?? '', 'npm', `${command}.cmd`),
    join(process.env.APPDATA ?? '', 'npm', `${command}.exe`),
    join(app.getPath('home'), '.local', 'bin', `${command}.exe`),
    join(app.getPath('home'), '.local', 'bin', `${command}.cmd`)
  ]
  try {
    const output = execFileSync('where.exe', [command], hiddenProcessOptions({ encoding: 'utf8' }))
    const matches = [
      ...fallbacks.filter((path) => path && existsSync(path)),
      ...output
        .split(/\r?\n/)
        .filter(Boolean)
        .map((path) => path.trim())
    ]
    return (
      matches.find((path) => {
        if (path.includes('\\WindowsApps\\OpenAI.Codex_')) return false
        return ['.exe', '.cmd', '.bat'].includes(extname(path).toLowerCase())
      }) ?? null
    )
  } catch {
    return fallbacks.find((path) => path && existsSync(path)) ?? null
  }
}

function registerWorktreeIpc(worktrees: WorktreeManager): void {
  ipcMain.handle(WORKTREE_CHANNELS.create, (_event, request: WorktreeCreateRequest) => worktrees.create(request))
  ipcMain.handle(WORKTREE_CHANNELS.status, (_event, request: WorktreeStatusRequest) => worktrees.status(request))
  ipcMain.handle(WORKTREE_CHANNELS.remove, (_event, request: WorktreeRemoveRequest) => worktrees.remove(request))
  ipcMain.handle(WORKTREE_CHANNELS.discover, (_event, request: WorktreeDiscoverRequest) => worktrees.discover(request))
  ipcMain.handle(WORKTREE_CHANNELS.diff, (_event, request: GitDiffRequest) => worktrees.diff(request))
  ipcMain.handle(WORKTREE_CHANNELS.diffFile, (_event, request: GitFileDiffRequest) => worktrees.diffFile(request))
  ipcMain.handle(WORKTREE_CHANNELS.currentBranch, (_event, path: string) => worktrees.currentBranch(path))
  ipcMain.handle(WORKTREE_CHANNELS.listBranches, (_event, path: string) => worktrees.listBranches(path))
  ipcMain.handle(WORKTREE_CHANNELS.checkoutBranch, (_event, request: GitCheckoutRequest) =>
    worktrees.checkoutBranch(request)
  )
}

/**
 * The composer's `@` picker asks for this on every mention token, so the reader is deliberately
 * the cached one: an unbounded directory walk per keystroke is exactly what this must not become.
 */
function registerWorkspaceFileIpc(files: WorkspaceFileIndexReader): void {
  ipcMain.handle(WORKSPACE_CHANNELS.fileIndex, (_event, root: unknown) =>
    files.read(typeof root === 'string' ? root : '')
  )
}

function registerUsageIpc(usage: ProviderUsage): void {
  ipcMain.handle(USAGE_CHANNELS.rateLimits, (_event, options: unknown) => {
    const request = options as { force?: unknown; provider?: unknown } | undefined
    const provider = request?.provider
    return usage.read({
      force: Boolean(request?.force),
      ...(provider === 'claude' || provider === 'codex' ? { provider } : {})
    })
  })
}

function registerAgentIpc(manager: AcpSessionManager): void {
  ipcMain.handle(AGENT_CHANNELS.create, (event, request: AgentCreateRequest) => manager.create(request, event.sender))
  ipcMain.handle(AGENT_CHANNELS.prompt, (_event, id: string, content: AgentPromptContent) =>
    manager.prompt(id, content)
  )
  ipcMain.handle(AGENT_CHANNELS.promptWhenIdle, (_event, id: string, content: AgentPromptContent) =>
    manager.promptWhenIdle(id, content)
  )
  ipcMain.handle(AGENT_CHANNELS.setMode, (_event, id: string, modeId: string) => manager.setMode(id, modeId))
  ipcMain.handle(AGENT_CHANNELS.setModel, (_event, id: string, modelId: string) => manager.setModel(id, modelId))
  ipcMain.handle(AGENT_CHANNELS.setEffort, (_event, id: string, effortId: string) => manager.setEffort(id, effortId))
  ipcMain.handle(AGENT_CHANNELS.authenticate, (_event, id: string, methodId: string) =>
    manager.authenticate(id, methodId)
  )
  ipcMain.handle(AGENT_CHANNELS.submitAuthCode, (_event, id: string, code: string) => manager.submitAuthCode(id, code))
  ipcMain.handle(AGENT_CHANNELS.openAuthLink, (_event, url: string) => manager.openAuthLink(url))
  ipcMain.on(AGENT_CHANNELS.approval, (_event, id: string, approvalId: string, optionId?: string) =>
    manager.resolveApproval(id, approvalId, optionId)
  )
  ipcMain.on(
    AGENT_CHANNELS.elicitation,
    (_event, id: string, requestId: string, content?: AgentDecisionResponseContent) =>
      manager.resolveElicitation(id, requestId, content)
  )
  ipcMain.on(AGENT_CHANNELS.cancel, (_event, id: string) => manager.cancel(id))
  ipcMain.on(AGENT_CHANNELS.kill, (_event, id: string) => manager.kill(id))
}

/**
 * Packaged Windows builds take their icon from the executable electron-builder stamps, so
 * this only has to cover `electron-vite dev`, where the app root still holds build/icon.png.
 */
function developmentWindowIcon(): string | undefined {
  const icon = join(app.getAppPath(), 'build', 'icon.png')
  return existsSync(icon) ? icon : undefined
}

function createWindow(
  terminalManager: TerminalManager,
  agentManager: AcpSessionManager,
  brainDumpCapture: BrainDumpCaptureManager,
  brainDumpChanges: BrainDumpChangeWatcher,
  ticketChanges: TicketChangeWatcher,
  fileView: FileView,
  remote: RemoteAccessServer,
  canvasRequests: RemoteCanvasRequests,
  appUpdater: AppUpdater,
  voiceModel: VoiceModelStore
): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    icon: developmentWindowIcon(),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Chromium's spellchecker loads one dictionary, picked from the OS locale - so a German
      // install underlines every English word in a prompt, and an English install does the same to
      // German. Prompts are written in both languages, often mixed inside one sentence, so there is
      // no single dictionary that is right here. Off app-wide rather than per-textarea.
      spellcheck: false
    }
  })

  window.once('ready-to-show', () => window.show())
  const contents = window.webContents
  // The settings dialog has to see a listener that failed or died on its own, not only the state
  // it last asked for, so the window subscribes for as long as it exists.
  const stopForwardingRemoteState = forwardRemoteStateChanges(remote, contents)
  // A download finishes minutes after the window last asked, so the header subscribes for as long
  // as the window exists rather than polling the release feed.
  const stopForwardingUpdates = forwardAppUpdateChanges(appUpdater, contents)
  // A 1.6 GB model download outlives any single request, so progress is pushed for the window's lifetime.
  const stopForwardingVoiceModel = forwardVoiceModelChanges(voiceModel, contents)
  // A phone's canvas requests - spawning a chat, reporting one read - are performed by a window,
  // so the window has to be reachable from the host, and detaching on destroy is what turns "the
  // desktop closed mid-spawn" into a refusal the phone can read rather than a request that waits
  // out its timeout.
  const detachCanvasWindow = canvasRequests.attach(contents)
  contents.on('destroyed', () => {
    stopForwardingRemoteState()
    stopForwardingUpdates()
    stopForwardingVoiceModel()
    detachCanvasWindow()
    terminalManager.disconnectOwner(contents)
    agentManager.killOwned(contents)
    brainDumpCapture.disconnectOwner(contents as unknown as BrainDumpCaptureOwner)
    brainDumpChanges.disconnectOwner(contents)
    ticketChanges.disconnectOwner(contents)
    fileView.disconnectOwner(contents)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = new URL(process.env.ELECTRON_RENDERER_URL)
    if (process.env.TOUCAN_BRAIN_DUMP_PROTOTYPE === '1') {
      rendererUrl.searchParams.set('prototype', 'brain-dump-library')
      rendererUrl.searchParams.set('variant', 'A')
    }
    void window.loadURL(rendererUrl.toString())
  } else {
    void window.loadURL(APP_INDEX_URL)
  }
}

function registerVoicePermissions(): void {
  // Dictation: allow Toucan's own window to request microphone audio, never camera video.
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission, _origin, details) =>
      permission === 'media' &&
      details.mediaType === 'audio' &&
      contents !== null &&
      BrowserWindow.fromWebContents(contents) !== null
  )
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
    callback(
      permission === 'media' &&
        mediaTypes?.length === 1 &&
        mediaTypes[0] === 'audio' &&
        BrowserWindow.fromWebContents(contents) !== null
    )
  })
}

/**
 * Serves the packaged renderer on one cross-origin-isolated origin. See `app-protocol.ts` for why
 * this is not `file:`; the dev server sets the same two isolation headers itself
 * (`electron.vite.config.ts`), so both runs are isolated the same way.
 */
function registerAppProtocol(rendererRoot: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const target = appRequestTarget(request.url)
    const path = target === null ? null : join(rendererRoot, ...target.split('/'))
    if (!path) return new Response('Not found', { status: 404, headers: APP_ISOLATION_HEADERS })
    const response = await net.fetch(pathToFileURL(path).toString(), { bypassCustomProtocolHandlers: true })
    const headers = new Headers(response.headers)
    for (const [name, value] of Object.entries(APP_ISOLATION_HEADERS)) headers.set(name, value)
    // A custom scheme has no server behind it to label what it serves, and Chromium will not run a
    // module script or stream a WebAssembly compile off a guessed type.
    const contentType = appContentType(path)
    if (contentType) headers.set('Content-Type', contentType)
    return new Response(response.body, { status: response.status, headers })
  })
}

void app.whenReady().then(async () => {
  // Diagnostics land in a file as well as the console: an installed Toucan.exe has no console.
  const mainLog = createMainLog({ file: join(app.getPath('logs'), 'main.log') })
  registerVoicePermissions()
  const codexHome = process.env.CODEX_HOME ?? join(app.getPath('home'), '.codex')
  const brainDumpDirectory = join(app.getPath('userData'), 'brain-dumps')
  const agentEnvironment = { ...process.env, TOUCAN_BRAIN_DUMPS_DIR: brainDumpDirectory }
  const terminalShell = createTerminalShell({
    environment: process.env,
    resolveCommand: findCommand
  })
  const scrollback = createTerminalScrollbackStore({
    directory: join(app.getPath('userData'), 'terminal-scrollback')
  })
  const liveness = createTerminalLivenessStore({
    path: join(app.getPath('userData'), 'terminal-liveness.json')
  })
  const manager = createTerminalManager({
    shell: terminalShell,
    scrollback,
    liveness,
    spawn: (launch, request, cwd) =>
      spawn(launch.executable, launch.args, {
        name: 'xterm-256color',
        cols: Math.max(2, request.cols),
        rows: Math.max(1, request.rows),
        cwd,
        env: { ...process.env, TERM: 'xterm-256color' }
      })
  })
  // Sessions publish their events here; the renderer subscribes per session at create, and the
  // remote server will subscribe the same way. Created at the composition root so both can share it.
  const agentEvents = createAgentEventBroker()
  const adapterDirectory = join(app.getPath('userData'), 'adapters')
  const adapters = await createAdapterManager({
    appPath: app.getAppPath(),
    directory: adapterDirectory,
    installer: createAdapterInstaller({ directory: join(adapterDirectory, 'installer') })
  })
  registerAdapterManagementIpc(ipcMain, adapters)
  adapters.onChange((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) window.webContents.send(ADAPTER_CHANNELS.changed, snapshot)
    }
  })
  // What providers have been seen to offer, kept across restarts. It exists for one reason: a
  // surface that has to choose a model before any session is running - the phone's new-chat form -
  // has nothing else to offer, because a model list is advertised by a live ACP session.
  const modelCatalogue = createAgentModelCatalogueStore({
    path: join(app.getPath('userData'), 'agent-models.json'),
    log: mainLog('agent models')
  })
  const workspace = createWorkspaceStore(join(app.getPath('userData'), 'prototype-workspace.json'))
  const conversationTitles = createConversationTitleStore(join(app.getPath('userData'), 'conversation-titles.json'))
  // What each conversation was asked for and where it stands, extracted from the same transcript
  // snapshots the broker already keeps. No UI and no IPC by design: a later session asks an agent
  // to read the folder (see `docs/plans/session-outcome-index.md`).
  const sessionOutcomesDirectory = join(app.getPath('userData'), 'session-outcomes')
  // Created up front rather than at the first record: every session is handed this folder as an
  // additional directory, and a provider sandbox cannot grant a path that is not there yet.
  mkdirSync(sessionOutcomesDirectory, { recursive: true })
  const sessionOutcomes = createSessionOutcomeIndexer({
    broker: agentEvents,
    store: createSessionOutcomeStore({ directory: sessionOutcomesDirectory }),
    // The node/worktree association lives only in the persisted canvas snapshot, so that is where
    // the record's `worktree` attribute is read from.
    worktreeIdForNode: async (nodeId) =>
      (await workspace.load()).state?.nodes.find((node) => node.id === nodeId)?.worktreeId,
    // The same durable title every other surface shows, so a record cannot name the conversation
    // something the user renamed away from.
    titleFor: async (provider, conversationId) => (await conversationTitles.get(provider, conversationId))?.title,
    log: mainLog('session outcomes')
  })
  // Main's copy of the canvas's terminal-context edges, and the MCP server that answers reads
  // against it (docs/plans/terminal-context-edge.md). The registry is the call-time capability
  // check; the server's localhost listener starts lazily with the first session that has an edge.
  const terminalContextEdges = createTerminalContextRegistry()
  const terminalContextMcp = createTerminalContextMcp({
    registry: terminalContextEdges,
    readOutput: (agentId, terminalSessionId, readOptions) =>
      manager.readOutput(agentId, terminalSessionId, readOptions),
    log: mainLog('terminal context')
  })
  // One probe, both readers: the session manager decides what a launch carries, the picker's
  // channel decides what the menu offers. Neither caches - the user may install the skill while
  // Toucan is running.
  const decisionProviderInstalled = (): boolean => isDecisionProviderInstalled(app.getPath('home'))
  const agentManager = createAcpSessionManager({
    appPath: app.getAppPath(),
    appVersion: app.getVersion(),
    resolveAdapter: adapters.resolve,
    codexHome,
    environment: agentEnvironment,
    broker: agentEvents,
    onModelsAdvertised: (provider, models) => modelCatalogue.record(provider, models),
    sessionOutcomes,
    sessionOutcomesDirectory,
    terminalContext: terminalContextMcp,
    decisionProviderInstalled
  })
  const captureStore = createBrainDumpCaptureStore(join(app.getPath('userData'), 'brain-dump-capture.json'))
  const brainDumpCapture = createBrainDumpCaptureManager({
    agent: {
      create: (request, owner) => agentManager.create(request, owner as unknown as Electron.WebContents),
      prompt: (id, content) => agentManager.prompt(id, content),
      resolveApproval: (id, approvalId, optionId) => agentManager.resolveApproval(id, approvalId, optionId),
      cancel: (id) => agentManager.cancel(id),
      kill: (id) => agentManager.kill(id)
    },
    homeDirectory: app.getPath('home'),
    libraryDirectory: brainDumpDirectory,
    registeredProjectPaths: async () => (await workspace.load()).state?.projects.map(({ path }) => path) ?? [],
    initialState: await captureStore.load(),
    publish: (state) => void captureStore.save(state).catch(() => {})
  })
  const brainDumpChanges = await createBrainDumpChangeWatcher({ rootDirectory: brainDumpDirectory })
  // The snapshot is the only place a project's `ticketsDirectory` is recorded, so it is read per
  // call rather than cached: a project whose folder setting changed is read from the new folder on
  // the very next listing. Which folder that is, is decided in `ticket-directory.ts`.
  const ticketsFolderFor = async (projectPath: string): Promise<string> =>
    ticketsDirectoryFor(projectPath, (await workspace.load()).state?.projects ?? [])
  // Same reasoning for the GitHub label mapping: a per-project workspace setting, read per listing.
  const githubLabelsFor = async (projectPath: string): Promise<GithubStatusLabels> =>
    githubStatusLabelsFor(
      projectFor(projectPath, (await workspace.load()).state?.projects ?? [])?.githubInProgressLabel
    )
  const ticketLibrary = createTicketLibrary({ directoryFor: ticketsFolderFor, today: localCalendarDate })
  // The scaffolded skill names the folder the way the *project* writes it, so it reads the same
  // setting the board does, one step before it is resolved against the checkout.
  const ticketSkill = createTicketSkillScaffold({
    directoryFor: async (projectPath) =>
      ticketsRelativeDirectoryFor(projectPath, (await workspace.load()).state?.projects ?? []),
    today: localCalendarDate
  })
  // The board is not the only reader of a ticket-folder change: a file an agent just wrote that
  // this listing cannot parse is fed back to that agent, through the same listing the board
  // renders, so generation and rendering can never be held to two different schemas.
  const ticketSteering = createTicketSteering({
    diagnosticsFor: async (projectPath) => (await ticketLibrary.list(projectPath)).diagnostics,
    recentWrites: () => agentManager.recentWrites(),
    steer: (agentId, text) => agentManager.promptWhenIdle(agentId, text),
    log: mainLog('tickets')
  })
  const ticketChanges = createTicketChangeWatcher({
    directoryFor: ticketsFolderFor,
    onChanged: (projectPath) => void ticketSteering.check(projectPath)
  })
  // A file node may read anywhere inside a registered project or one of its worktrees and nowhere
  // else. The roots come from the snapshot per call, so a project added a moment ago is readable
  // and one removed a moment ago is not - fail closed, like brain-dump project assignment.
  const workspaceRoots = async (): Promise<string[]> => {
    const state = (await workspace.load()).state
    return [...(state?.projects.map(({ path }) => path) ?? []), ...(state?.worktrees.map(({ path }) => path) ?? [])]
  }
  const fileView = createFileView({
    roots: workspaceRoots,
    formatter: createPrettierFileFormatter({ roots: workspaceRoots })
  })
  // Opening an artifact with its associated application answers to the same roots, through the
  // same containment rule - it is the one path action that can run something.
  const openLocalFile = createLocalFileOpener({
    contains: createWorkspaceContainment({ roots: workspaceRoots }).contains,
    openPath: (path) => shell.openPath(path)
  })
  // Spawning is the one remote operation main cannot perform alone: the canvas owns node identity,
  // geometry and working-directory resolution, so a phone's "New chat" is a request the desktop
  // window runs through its own add-node path and reports the verdict on.
  // The speech engine and its checkpoint are not in the installer: the store downloads both into
  // userData the first time dictation is asked for (pins in `shared/whisper-assets.ts`).
  const voiceModel = createVoiceModelStore({
    rootDirectory: join(app.getPath('userData'), 'models', 'whisper'),
    port: createVoiceModelPort(),
    log: mainLog('voice model')
  })
  registerAppProtocol(join(__dirname, '..', 'renderer'))
  const canvasRequests = createRemoteCanvasRequests()
  // Every recording lands here - the composer's over IPC, a phone's over `/api/transcribe` - and
  // main decodes it with one whisper-server child, loaded lazily: a 1.6 GB model is not paid for
  // by a desktop nobody dictates to.
  const voiceTranscriber = createVoiceTranscriber({
    loadEngine: async (signal) => {
      await voiceModel.ensure()
      const paths = voiceModel.paths()
      if (!paths) throw new Error(VOICE_MODEL_MISSING_MESSAGE)
      // The signal is what reaches the child when the load is given up on or Toucan quits.
      return loadWhisperEngine({ ...paths, log: mainLog('speech engine'), signal })
    }
  })
  registerVoiceModelIpc(ipcMain, voiceModel, voiceTranscriber)
  const stopDictationCleanup = registerDictationCleanupIpc(ipcMain, createDictationCleaner())
  // One usage cache for both surfaces. The desktop header polls it over IPC and the phone reads it
  // over `/api/usage`, so two clients asking about the same account still cost one provider read
  // per TTL rather than one per client - which is the whole reason this sits in main at all.
  const providerUsage = createProviderUsage({
    readers: {
      claude: createClaudeUsageReader({
        cwd: app.getPath('home'),
        log: mainLog('claude usage')
      }),
      codex: createCodexRateLimitReader({
        homeDirectory: app.getPath('home'),
        environment: process.env,
        command: findCommand('codex'),
        appPath: app.getAppPath(),
        appVersion: app.getVersion()
      })
    },
    ttlMs: PROVIDER_USAGE_TTL_MS
  })
  const remote = createRemoteAccessServer({
    store: createRemoteAccessStore({ path: join(app.getPath('userData'), 'remote-access.json') }),
    // The mobile client is built beside the main and renderer bundles, so the same path resolves
    // in `electron-vite dev` and inside a packaged build.
    clientRoot: join(app.getAppPath(), 'out', 'mobile'),
    // Live chats are read straight off the session broker: the phone is just another subscriber
    // to the same fan-out the desktop renderer receives.
    chats: agentEvents,
    // What a paired phone may drive. `startPrompt` rather than `prompt` on purpose: the phone
    // needs to know its message was delivered, which is decided immediately, not when the turn it
    // started finally ends. And it is the non-steering path, so a busy session refuses out loud
    // instead of the prompt being injected into a turn already under way.
    // Answering is the reason the phone is useful at all: without it a remote chat stalls at the
    // first permission request. Both answer paths are the *same* manager operations the desktop's
    // own cards call, so the pending-request map decides a race between the two devices.
    sessions: {
      prompt: (id, text) => agentManager.startPrompt(id, text),
      approve: (id, approvalId, optionId) => agentManager.resolveApproval(id, approvalId, optionId),
      answerDecision: (id, decisionId, content) => agentManager.resolveElicitation(id, decisionId, content),
      // The same operation the desktop's own model picker calls, so both surfaces change one
      // selection and both learn about it from the session's `models` event.
      setModel: (id, modelId) => agentManager.setModel(id, modelId)
    },
    spawn: (request) => canvasRequests.spawn(request),
    // Reading a chat on the phone has to retire its badge everywhere, and the attention records
    // behind that badge are the canvas's - so this is a request to the window, like spawning, and
    // not something main applies on its own.
    read: (chatId) => canvasRequests.markRead(chatId),
    // Read per request: a provider that advertises a new model is offered the moment a session has
    // seen it, without the listener knowing anything happened.
    models: () => modelCatalogue.read(),
    // Read without `force`, which is the whole rate story of this route. It does not mean no
    // provider CLI ever runs for a phone - an expired cache starts a real read, and a desktop
    // nobody is sitting at has nothing else keeping it warm - it means the *rate* is
    // `PROVIDER_USAGE_TTL_MS` and is the host's to set. A paired client cannot raise it by asking
    // more often, which is the property a network surface needs.
    usage: () => providerUsage.read(),
    transcriber: voiceTranscriber
  })
  // Off unless the user turned it on and the setting survived a restart; `start` only ever binds
  // what the stored settings already asked for.
  await remote.start()

  registerTerminalIpc(ipcMain, manager, scrollback, liveness)
  registerAgentIpc(agentManager)
  registerTerminalContextIpc(ipcMain, terminalContextEdges)
  registerBrainDumpIpc(
    ipcMain,
    createBrainDumpLibrary({ rootDirectory: brainDumpDirectory, today: localCalendarDate }),
    brainDumpCapture,
    brainDumpChanges
  )
  registerConversationIpc(
    ipcMain,
    createConversationHistory({
      homeDirectory: app.getPath('home'),
      environment: process.env,
      titles: conversationTitles
    }),
    conversationTitles
  )
  // One manager for both: the delete confirmation asks git the same question worktree discovery
  // does, so it asks the same object rather than shelling out on its own.
  const worktrees = createWorktreeManager()
  registerTicketIpc(ipcMain, {
    library: ticketLibrary,
    changes: ticketChanges,
    skill: ticketSkill,
    reveal: (path) => shell.showItemInFolder(normalize(path)),
    isGitRepository: (projectPath) => worktrees.isRepository(projectPath)
  })
  registerDecisionDelegationIpc(ipcMain, decisionProviderInstalled)
  registerGithubIssuesIpc(
    ipcMain,
    createGithubIssueReader({ resolveCommand: findCommand, statusLabelsFor: githubLabelsFor })
  )
  registerWorktreeIpc(worktrees)
  registerFileViewIpc(ipcMain, fileView)
  registerWorkspaceFileIpc(createWorkspaceFileIndex())
  registerUsageIpc(providerUsage)
  registerProjectIpc(ipcMain, {
    workspace,
    initialProjectPath: () => process.cwd(),
    pickProjectDirectory: async (sender) => {
      const owner = BrowserWindow.fromWebContents(sender as Electron.WebContents)
      const options: Electron.OpenDialogOptions = {
        title: 'Add project folder',
        properties: ['openDirectory']
      }
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    },
    openExternal: (url) => shell.openExternal(url),
    showItemInFolder: (path) => shell.showItemInFolder(path),
    openLocalFile,
    // Saving an image out of the transcript answers to the user's own pick, not to the workspace
    // roots: the bytes are already in the renderer's hands, and where a copy of them may be put
    // is exactly what the save dialog is for.
    saveImage: createImageArtifactSaver({
      showSaveDialog: async (sender, defaultName) => {
        const owner = BrowserWindow.fromWebContents(sender as Electron.WebContents)
        const options: Electron.SaveDialogOptions = { title: 'Save image', defaultPath: defaultName }
        const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
        return result.canceled || !result.filePath ? null : result.filePath
      },
      writeFile: (path, bytes) => writeFile(path, bytes)
    }),
    // Upload-and-copy semantics and their reasoning live in `shared/project-avatar.ts`; this is
    // only the Electron wiring. The filter offers exactly what nativeImage decodes (PNG and JPEG)
    // so the picker never advertises a format the decoder would refuse.
    avatars: createProjectAvatarStore({
      directory: join(app.getPath('userData'), 'project-avatars'),
      pickImageFile: async (sender) => {
        const owner = BrowserWindow.fromWebContents(sender as Electron.WebContents)
        const options: Electron.OpenDialogOptions = {
          title: 'Choose avatar image',
          properties: ['openFile'],
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }]
        }
        const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
        return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
      },
      decodeImage: (path) => {
        const image = nativeImage.createFromPath(path)
        if (image.isEmpty()) return Promise.resolve(null)
        const { width, height } = image.getSize()
        return Promise.resolve({
          width,
          height,
          toPng: (rect, edge) => image.crop(rect).resize({ width: edge, height: edge, quality: 'best' }).toPNG()
        })
      }
    })
  })
  registerRemoteIpc(ipcMain, remote, canvasRequests)
  // Self-updating from the public releases repo. Constructed before the window so the header is
  // subscribed to the very first check, and started after it so a slow feed never delays the UI.
  const appUpdater = createAppUpdater({
    updater: autoUpdater,
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    environment: process.env,
    log: mainLog('update')
  })
  registerAppUpdateIpc(ipcMain, appUpdater)
  createWindow(
    manager,
    agentManager,
    brainDumpCapture,
    brainDumpChanges,
    ticketChanges,
    fileView,
    remote,
    canvasRequests,
    appUpdater,
    voiceModel
  )
  void appUpdater.check()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0)
      createWindow(
        manager,
        agentManager,
        brainDumpCapture,
        brainDumpChanges,
        ticketChanges,
        fileView,
        remote,
        canvasRequests,
        appUpdater,
        voiceModel
      )
  })
  app.on('before-quit', () => {
    manager.killAll()
    agentManager.killAll()
    brainDumpCapture.shutdown()
    brainDumpChanges.shutdown()
    ticketChanges.shutdown()
    fileView.shutdown()
    void remote.shutdown()
    voiceTranscriber.shutdown()
    stopDictationCleanup()
  })
})

app.on('window-all-closed', () => app.quit())
