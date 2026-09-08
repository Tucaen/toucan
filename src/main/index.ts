import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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
import { createAppUpdater, type AppUpdater } from './app-update'
import { forwardAppUpdateChanges, registerAppUpdateIpc } from './app-update-ipc'
import { createVoiceModelStore, type VoiceModelStore } from './voice-model-store'
import { createMainLog } from './main-log'
import { createVoiceModelPort } from './voice-model-download'
import { forwardVoiceModelChanges, registerVoiceModelIpc } from './voice-model-ipc'
import { voiceModelRequestFile } from './voice-model-protocol'
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
import { registerFileViewIpc } from './file-view-ipc'
import { createGithubIssueReader } from './github-issues'
import { registerGithubIssuesIpc } from './github-issues-ipc'
import { registerTicketIpc } from './ticket-ipc'
import { createTicketLibrary } from './ticket-library'
import { createTicketChangeWatcher, type TicketChangeWatcher } from './ticket-watcher'
import { createClaudeUsageReader } from './claude-usage'
import { createConversationHistory } from './conversation-history'
import { createConversationTitleStore } from './conversation-title-store'
import { createCodexRateLimitReader } from './codex-rate-limits'
import { createProviderUsage, type ProviderUsage } from './provider-usage'
import { createRemoteAccessStore } from './remote/remote-access-store'
import { forwardRemoteStateChanges, registerRemoteIpc } from './remote/remote-ipc'
import { createRemoteChatSpawner, type RemoteChatSpawner } from './remote/chat-spawn'
import { createRemoteAccessServer, type RemoteAccessServer } from './remote/remote-server'
import { createRemoteVoiceTranscriber } from './remote/voice-transcription'
import { loadMoonshineEngine } from './remote/voice-engine'
import { VOICE_MODEL_ASSET_DIRECTORY } from '../shared/remote-voice'
import { createSessionProviders } from './session-providers'
import { createAdapterManager } from './adapter-manager'
import { createAdapterInstaller } from './adapter-installer'
import { registerAdapterManagementIpc } from './adapter-management-ipc'
import { createTerminalLivenessStore } from './terminal-liveness-store'
import { createTerminalManager, type TerminalManager } from './terminal-manager'
import { createTerminalScrollbackStore } from './terminal-scrollback-store'
import { registerTerminalIpc } from './terminal-ipc'
import { registerConversationIpc } from './conversation-ipc'
import { registerProjectIpc } from './project-ipc'
import { createWorktreeManager, type WorktreeManager } from './git-worktree'
import { createWorkspaceFileIndex, type WorkspaceFileIndexReader } from './workspace-file-index'
import { createWorkspaceStore } from './workspace-store'
import { projectFor, ticketsDirectoryFor } from './ticket-directory'
import { githubStatusLabelsFor, type GithubStatusLabels } from '../shared/github-issues'
import type {
  WorktreeCreateRequest,
  WorktreeDiscoverRequest,
  WorktreeRemoveRequest,
  WorktreeStatusRequest
} from '../shared/worktree'
import type { GitDiffRequest, GitFileDiffRequest } from '../shared/git-diff'

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
  ipcMain.handle(USAGE_CHANNELS.rateLimits, (_event, options: unknown) =>
    usage.read({ force: Boolean((options as { force?: unknown } | undefined)?.force) })
  )
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
  spawner: RemoteChatSpawner,
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
  // A 291 MB model download outlives any single request, so progress is pushed for the window's lifetime.
  const stopForwardingVoiceModel = forwardVoiceModelChanges(voiceModel, contents)
  // A phone's spawn is performed by a window, so the window has to be reachable from the host -
  // and detaching on destroy is what turns "the desktop closed mid-spawn" into a refusal the
  // phone can read rather than a request that waits out its timeout.
  const detachSpawnWindow = spawner.attach(contents)
  contents.on('destroyed', () => {
    stopForwardingRemoteState()
    stopForwardingUpdates()
    stopForwardingVoiceModel()
    detachSpawnWindow()
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
    void window.loadFile(join(__dirname, '../renderer/index.html'))
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

function registerVoiceCrossOriginIsolation(): void {
  // Moonshine's threaded WASM build needs SharedArrayBuffer, which
  // Chromium only exposes to a crossOriginIsolated page. electron.vite.config.ts
  // sets these headers for the dev server, but a packaged build loads the
  // renderer via loadFile() (file://), which never goes through that dev
  // server. Without this, the WASM module's worker thread dies silently on
  // startup (no SharedArrayBuffer to back its shared memory) and the pending
  // model-load promise never settles, leaving the mic button stuck loading.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Cross-Origin-Embedder-Policy': ['require-corp']
      }
    })
  })
}

function registerVoiceModelProtocol(store: VoiceModelStore, rendererRoot: string): void {
  // Same origin on purpose: a custom scheme would put the model fetch on the wrong side of the
  // cross-origin-isolation headers the WASM needs. Every other file: request passes straight through.
  protocol.handle('file', (request) => {
    const name = voiceModelRequestFile(request.url, rendererRoot)
    const path = name ? store.filePath(name) : null
    if (path) return net.fetch(pathToFileURL(path).toString(), { bypassCustomProtocolHandlers: true })
    return net.fetch(request, { bypassCustomProtocolHandlers: true })
  })
}

void app.whenReady().then(async () => {
  // Diagnostics land in a file as well as the console: an installed Toucan.exe has no console.
  const mainLog = createMainLog({ file: join(app.getPath('logs'), 'main.log') })
  registerVoicePermissions()
  registerVoiceCrossOriginIsolation()
  const codexHome = process.env.CODEX_HOME ?? join(app.getPath('home'), '.codex')
  const brainDumpDirectory = join(app.getPath('userData'), 'brain-dumps')
  const agentEnvironment = { ...process.env, TOUCAN_BRAIN_DUMPS_DIR: brainDumpDirectory }
  const providers = createSessionProviders({
    homeDirectory: app.getPath('home'),
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
    providers,
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
  const agentManager = createAcpSessionManager({
    appPath: app.getAppPath(),
    resolveAdapter: adapters.resolve,
    codexHome,
    environment: agentEnvironment,
    broker: agentEvents
  })
  const workspace = createWorkspaceStore(join(app.getPath('userData'), 'prototype-workspace.json'))
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
  const ticketChanges = createTicketChangeWatcher({ directoryFor: ticketsFolderFor })
  // A file node may read anywhere inside a registered project or one of its worktrees and nowhere
  // else. The roots come from the snapshot per call, so a project added a moment ago is readable
  // and one removed a moment ago is not - fail closed, like brain-dump project assignment.
  const fileView = createFileView({
    roots: async () => {
      const state = (await workspace.load()).state
      return [...(state?.projects.map(({ path }) => path) ?? []), ...(state?.worktrees.map(({ path }) => path) ?? [])]
    }
  })
  // Spawning is the one remote operation main cannot perform alone: the canvas owns node identity,
  // geometry and working-directory resolution, so a phone's "New chat" is a request the desktop
  // window runs through its own add-node path and reports the verdict on.
  // The speech model is not in the installer. A dev run finds the one `prepare:voice-model` put in
  // the renderer's public root; an installed build downloads it into userData on first use and
  // the `file:` handler below serves it from there at the URL the renderer has always asked for.
  const voiceModel = createVoiceModelStore({
    preparedDirectories: [join(app.getAppPath(), 'src', 'renderer', 'public', VOICE_MODEL_ASSET_DIRECTORY)],
    downloadDirectory: join(app.getPath('userData'), VOICE_MODEL_ASSET_DIRECTORY),
    port: createVoiceModelPort(),
    log: mainLog('voice model')
  })
  registerVoiceModelIpc(ipcMain, voiceModel)
  registerVoiceModelProtocol(voiceModel, join(__dirname, '..', 'renderer'))
  const chatSpawner = createRemoteChatSpawner()
  // A phone whose browser cannot recognize speech sends its recording here, and main transcribes
  // it with the same prepared model files the renderer dictates with - loaded lazily, because a
  // 300 MB model is not paid for by a desktop nobody dictates to from a phone.
  const voiceTranscriber = createRemoteVoiceTranscriber({
    loadEngine: async () => {
      await voiceModel.ensure()
      return loadMoonshineEngine(voiceModel.directory())
    }
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
      answerDecision: (id, decisionId, content) => agentManager.resolveElicitation(id, decisionId, content)
    },
    spawn: (request) => chatSpawner.spawn(request),
    transcriber: voiceTranscriber
  })
  // Off unless the user turned it on and the setting survived a restart; `start` only ever binds
  // what the stored settings already asked for.
  await remote.start()

  registerTerminalIpc(ipcMain, manager, providers, scrollback, liveness)
  registerAgentIpc(agentManager)
  registerBrainDumpIpc(
    ipcMain,
    createBrainDumpLibrary({ rootDirectory: brainDumpDirectory, today: localCalendarDate }),
    brainDumpCapture,
    brainDumpChanges
  )
  const conversationTitles = createConversationTitleStore(join(app.getPath('userData'), 'conversation-titles.json'))
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
    library: createTicketLibrary({ directoryFor: ticketsFolderFor, today: localCalendarDate }),
    changes: ticketChanges,
    reveal: (path) => shell.showItemInFolder(normalize(path)),
    isGitRepository: (projectPath) => worktrees.isRepository(projectPath)
  })
  registerGithubIssuesIpc(
    ipcMain,
    createGithubIssueReader({ resolveCommand: findCommand, statusLabelsFor: githubLabelsFor })
  )
  registerWorktreeIpc(worktrees)
  registerFileViewIpc(ipcMain, fileView)
  registerWorkspaceFileIpc(createWorkspaceFileIndex())
  registerUsageIpc(
    createProviderUsage({
      readers: {
        claude: createClaudeUsageReader({
          cwd: app.getPath('home'),
          log: mainLog('claude usage')
        }),
        codex: createCodexRateLimitReader({
          homeDirectory: app.getPath('home'),
          environment: process.env,
          command: findCommand('codex')
        })
      },
      ttlMs: PROVIDER_USAGE_TTL_MS
    })
  )
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
    showItemInFolder: (path) => shell.showItemInFolder(path)
  })
  registerRemoteIpc(ipcMain, remote, chatSpawner)
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
    chatSpawner,
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
        chatSpawner,
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
  })
})

app.on('window-all-closed', () => app.quit())
