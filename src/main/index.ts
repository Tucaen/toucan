import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, extname, join, normalize } from 'node:path'
import { spawn } from 'node-pty'
import type { AgentCreateRequest, AgentPromptContent } from '../shared/agent'
import type { ConversationListRequest } from '../shared/conversation'
import type { TerminalCreateRequest, WorkspaceState } from '../shared/terminal'
import { createAcpSessionManager, type AcpSessionManager } from './acp-session-manager'
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
import { createClaudeUsageReader } from './claude-usage'
import { createConversationHistory, type ConversationHistory } from './conversation-history'
import { createConversationTitleStore, type ConversationTitleStore } from './conversation-title-store'
import { createCodexRateLimitReader } from './codex-rate-limits'
import { createProviderUsage, type ProviderUsage } from './provider-usage'
import { createSessionProviders, type SessionProviders } from './session-providers'
import { createTerminalManager, type TerminalManager } from './terminal-manager'
import { createTerminalScrollbackStore, type TerminalScrollbackStore } from './terminal-scrollback-store'
import { createWorktreeManager, type WorktreeManager, type WorktreeStatusRequest } from './git-worktree'
import { createWorkspaceStore } from './workspace-store'
import type { WorktreeCreateRequest, WorktreeDiscoverRequest, WorktreeRemoveRequest } from '../shared/worktree'

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

function registerTerminalIpc(
  manager: TerminalManager,
  providers: SessionProviders,
  scrollback: TerminalScrollbackStore,
  liveness: TerminalLivenessStore
): void {
  ipcMain.handle('terminal:preview', (_event, kind: unknown, conversationId: unknown) => {
    if ((kind !== 'claude' && kind !== 'codex') || typeof conversationId !== 'string') return null
    return providers.getConversationPreview(kind, conversationId)
  })
  ipcMain.handle('terminal:create', (event, request: TerminalCreateRequest) => manager.create(request, event.sender))
  ipcMain.on('terminal:write', (_event, sessionId: string, incarnationId: string, data: string) =>
    manager.write(sessionId, incarnationId, data)
  )
  ipcMain.on('terminal:resize', (_event, sessionId: string, incarnationId: string, cols: number, rows: number) =>
    manager.resize(sessionId, incarnationId, cols, rows)
  )
  ipcMain.on('terminal:kill', (_event, sessionId: string, incarnationId: string, attachmentId: string) =>
    manager.kill(sessionId, incarnationId, attachmentId)
  )
  ipcMain.handle('terminal:scrollback', (_event, sessionId: unknown) =>
    typeof sessionId === 'string' ? scrollback.load(sessionId) : null
  )
  // Removing a canvas node retires its durable session outright, so the process verdict goes with
  // the retained output. Keeping it would leave a verdict about a session nothing can reach.
  ipcMain.handle('terminal:scrollback-remove', (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return false
    liveness.remove(sessionId)
    return scrollback.remove(sessionId)
  })
}

function registerConversationIpc(history: ConversationHistory, titles: ConversationTitleStore): void {
  ipcMain.handle('conversation:list', (_event, request: unknown) => {
    const directories = (request as ConversationListRequest | undefined)?.directories
    if (!Array.isArray(directories) || directories.some((entry) => typeof entry !== 'string')) {
      return { entries: [], total: 0, hasMore: false }
    }
    const { limit, offset } = request as ConversationListRequest
    return history.list({ directories, limit, offset })
  })
  // A transcript the user can see in the list may already be gone; opening one asks first so
  // the browser can say so instead of launching a resume that cannot find its conversation.
  ipcMain.handle('conversation:exists', (_event, path: unknown) =>
    typeof path === 'string' ? history.exists(path) : Promise.resolve(false)
  )
  ipcMain.handle(
    'conversation:set-title',
    (_event, provider: unknown, id: unknown, title: unknown, source: unknown) => {
      if ((provider !== 'claude' && provider !== 'codex') || typeof id !== 'string' || typeof title !== 'string')
        return null
      if (source !== 'generated' && source !== 'manual') return null
      return titles.set(provider, id, title, source)
    }
  )
}

function registerWorktreeIpc(worktrees: WorktreeManager): void {
  ipcMain.handle('worktree:create', (_event, request: WorktreeCreateRequest) => worktrees.create(request))
  ipcMain.handle('worktree:status', (_event, request: WorktreeStatusRequest) => worktrees.status(request))
  ipcMain.handle('worktree:remove', (_event, request: WorktreeRemoveRequest) => worktrees.remove(request))
  ipcMain.handle('worktree:discover', (_event, request: WorktreeDiscoverRequest) => worktrees.discover(request))
}

function registerUsageIpc(usage: ProviderUsage): void {
  ipcMain.handle('usage:rate-limits', () => usage.read())
}

function registerAgentIpc(manager: AcpSessionManager): void {
  ipcMain.handle('agent:create', (event, request: AgentCreateRequest) => manager.create(request, event.sender))
  ipcMain.handle('agent:prompt', (_event, id: string, content: AgentPromptContent) => manager.prompt(id, content))
  ipcMain.handle('agent:prompt-when-idle', (_event, id: string, content: AgentPromptContent) =>
    manager.promptWhenIdle(id, content)
  )
  ipcMain.handle('agent:set-mode', (_event, id: string, modeId: string) => manager.setMode(id, modeId))
  ipcMain.handle('agent:set-model', (_event, id: string, modelId: string) => manager.setModel(id, modelId))
  ipcMain.handle('agent:set-effort', (_event, id: string, effortId: string) => manager.setEffort(id, effortId))
  ipcMain.handle('agent:authenticate', (_event, id: string, methodId: string) => manager.authenticate(id, methodId))
  ipcMain.handle('agent:submit-auth-code', (_event, id: string, code: string) => manager.submitAuthCode(id, code))
  ipcMain.handle('agent:open-auth-link', (_event, url: string) => manager.openAuthLink(url))
  ipcMain.on('agent:approval', (_event, id: string, approvalId: string, optionId?: string) =>
    manager.resolveApproval(id, approvalId, optionId)
  )
  ipcMain.on('agent:cancel', (_event, id: string) => manager.cancel(id))
  ipcMain.on('agent:kill', (_event, id: string) => manager.kill(id))
}

function registerProjectIpc(workspace: ReturnType<typeof createWorkspaceStore>): void {
  ipcMain.handle('project:initial', () => {
    const path = process.cwd()
    return { name: basename(path), path }
  })
  ipcMain.handle('project:pick', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Add project folder',
      properties: ['openDirectory']
    }
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)

    if (result.canceled || result.filePaths.length === 0) return null
    const path = normalize(result.filePaths[0])
    return { name: basename(path), path }
  })
  // Markdown links in agent replies must open in the user's browser; loading one in the
  // renderer would navigate the app window away. Only web URLs are forwarded - never file:,
  // and never a shell-interpreted scheme.
  ipcMain.handle('shell:open-external', async (_event, url: unknown) => {
    if (typeof url !== 'string') return
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    await shell.openExternal(parsed.toString())
  })
  // A file-operation tool card offers to reveal the file it touched. This only ever selects a
  // path in the OS file manager - it never opens or executes it.
  ipcMain.handle('shell:show-item-in-folder', (_event, path: unknown) => {
    if (typeof path !== 'string' || !path.trim()) return
    shell.showItemInFolder(normalize(path))
  })
  ipcMain.handle('workspace:load', () => workspace.load())
  ipcMain.handle('workspace:save', (_event, state: WorkspaceState) => workspace.save(state))
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
  brainDumpChanges: BrainDumpChangeWatcher
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
      sandbox: false
    }
  })

  window.once('ready-to-show', () => window.show())
  const contents = window.webContents
  contents.on('destroyed', () => {
    terminalManager.disconnectOwner(contents)
    agentManager.killOwned(contents)
    brainDumpCapture.disconnectOwner(contents as unknown as BrainDumpCaptureOwner)
    brainDumpChanges.disconnectOwner(contents)
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

function registerVoicePrototypePermissions(): void {
  // PROTOTYPE: allow Toucan's own window to request microphone audio, never camera video.
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

function registerVoicePrototypeCrossOriginIsolation(): void {
  // PROTOTYPE: Moonshine's threaded WASM build needs SharedArrayBuffer, which
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

void app.whenReady().then(async () => {
  registerVoicePrototypePermissions()
  registerVoicePrototypeCrossOriginIsolation()
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
  const agentManager = createAcpSessionManager({
    appPath: app.getAppPath(),
    codexHome,
    environment: agentEnvironment
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
    registeredProjectPaths: async () => (await workspace.load()).state?.projects.map(({ path }) => path) ?? [],
    initialState: await captureStore.load(),
    publish: (state) => void captureStore.save(state).catch(() => {})
  })
  const brainDumpChanges = await createBrainDumpChangeWatcher({ rootDirectory: brainDumpDirectory })

  registerTerminalIpc(manager, providers, scrollback)
  registerAgentIpc(agentManager)
  registerBrainDumpIpc(
    ipcMain as unknown as Parameters<typeof registerBrainDumpIpc>[0],
    createBrainDumpLibrary({ rootDirectory: brainDumpDirectory, today: localCalendarDate }),
    brainDumpCapture,
    brainDumpChanges
  )
  const conversationTitles = createConversationTitleStore(join(app.getPath('userData'), 'conversation-titles.json'))
  registerConversationIpc(
    createConversationHistory({
      homeDirectory: app.getPath('home'),
      environment: process.env,
      titles: conversationTitles
    }),
    conversationTitles
  )
  registerWorktreeIpc(createWorktreeManager())
  registerUsageIpc(
    createProviderUsage({
      readers: {
        claude: createClaudeUsageReader({ cwd: app.getPath('home') }),
        codex: createCodexRateLimitReader({
          homeDirectory: app.getPath('home'),
          environment: process.env,
          command: findCommand('codex')
        })
      },
      ttlMs: PROVIDER_USAGE_TTL_MS
    })
  )
  registerProjectIpc(workspace)
  createWindow(manager, agentManager, brainDumpCapture, brainDumpChanges)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0)
      createWindow(manager, agentManager, brainDumpCapture, brainDumpChanges)
  })
  app.on('before-quit', () => {
    manager.killAll()
    agentManager.killAll()
    brainDumpCapture.shutdown()
    brainDumpChanges.shutdown()
  })
})

app.on('window-all-closed', () => app.quit())
