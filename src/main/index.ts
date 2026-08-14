import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, extname, join, normalize } from 'node:path'
import { spawn } from 'node-pty'
import type { AgentCreateRequest } from '../shared/agent'
import type { TerminalCreateRequest } from '../shared/terminal'
import { createAcpSessionManager, type AcpSessionManager } from './acp-session-manager'
import { createFirstMateRuntime, type FirstMateRuntime } from './firstmate-runtime'
import { createSessionProviders, type SessionProviders } from './session-providers'
import { createTerminalManager, type TerminalManager } from './terminal-manager'
import { createWorkspaceStore } from './workspace-store'

function findCommand(command: string): string | null {
  const fallbacks = [
    join(process.env.APPDATA ?? '', 'npm', `${command}.cmd`),
    join(process.env.APPDATA ?? '', 'npm', `${command}.exe`),
    join(app.getPath('home'), '.local', 'bin', `${command}.exe`),
    join(app.getPath('home'), '.local', 'bin', `${command}.cmd`)
  ]
  try {
    const output = execFileSync('where.exe', [command], {
      encoding: 'utf8',
      windowsHide: true
    })
    const matches = [
      ...fallbacks.filter((path) => path && existsSync(path)),
      ...output.split(/\r?\n/).filter(Boolean).map((path) => path.trim())
    ]
    return matches.find((path) => {
      if (path.includes('\\WindowsApps\\OpenAI.Codex_')) return false
      return ['.exe', '.cmd', '.bat'].includes(extname(path).toLowerCase())
    }) ?? null
  } catch {
    return fallbacks.find((path) => path && existsSync(path)) ?? null
  }
}

function registerTerminalIpc(manager: TerminalManager, providers: SessionProviders): void {
  ipcMain.handle('terminal:preview', (_event, kind: unknown, conversationId: unknown) => {
    if ((kind !== 'claude' && kind !== 'codex') || typeof conversationId !== 'string') return null
    return providers.getConversationPreview(kind, conversationId)
  })
  ipcMain.handle('terminal:create', (event, request: TerminalCreateRequest) => (
    manager.create(request, event.sender)
  ))
  ipcMain.on('terminal:write', (_event, id: string, data: string) => manager.write(id, data))
  ipcMain.on('terminal:resize', (_event, id: string, cols: number, rows: number) => (
    manager.resize(id, cols, rows)
  ))
  ipcMain.on('terminal:kill', (_event, id: string) => manager.kill(id))
}

function registerAgentIpc(manager: AcpSessionManager): void {
  ipcMain.handle('agent:create', (event, request: AgentCreateRequest) => manager.create(request, event.sender))
  ipcMain.handle('agent:prompt', (_event, id: string, text: string) => manager.prompt(id, text))
  ipcMain.handle('agent:set-mode', (_event, id: string, modeId: string) => manager.setMode(id, modeId))
  ipcMain.handle('agent:set-model', (_event, id: string, modelId: string) => manager.setModel(id, modelId))
  ipcMain.handle('agent:authenticate', (_event, id: string, methodId: string) => (
    manager.authenticate(id, methodId)
  ))
  ipcMain.on('agent:approval', (_event, id: string, approvalId: string, optionId?: string) => (
    manager.resolveApproval(id, approvalId, optionId)
  ))
  ipcMain.on('agent:cancel', (_event, id: string) => manager.cancel(id))
  ipcMain.on('agent:kill', (_event, id: string) => manager.kill(id))
}

function registerFirstMateIpc(runtime: FirstMateRuntime): void {
  ipcMain.handle('firstmate:status', () => runtime.status())
  ipcMain.handle('firstmate:install', () => runtime.install())
  ipcMain.handle('firstmate:github-auth', () => runtime.authenticateGitHub())
  ipcMain.handle('firstmate:trust-codex', () => runtime.trustCodexProject())
}

function registerProjectIpc(): void {
  const workspace = createWorkspaceStore(join(app.getPath('userData'), 'prototype-workspace.json'))

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
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)

    if (result.canceled || result.filePaths.length === 0) return null
    const path = normalize(result.filePaths[0])
    return { name: basename(path), path }
  })
  ipcMain.handle('workspace:load', () => workspace.load())
  ipcMain.handle('workspace:save', (_event, state) => workspace.save(state))
}

function createWindow(terminalManager: TerminalManager, agentManager: AcpSessionManager): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0d12',
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
    terminalManager.killOwned(contents)
    agentManager.killOwned(contents)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerVoicePrototypePermissions(): void {
  // PROTOTYPE: allow ADE's own window to request microphone audio, never camera video.
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => (
    permission === 'media'
    && details.mediaType === 'audio'
    && contents !== null
    && BrowserWindow.fromWebContents(contents) !== null
  ))
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
    callback(
      permission === 'media'
      && mediaTypes?.length === 1
      && mediaTypes[0] === 'audio'
      && BrowserWindow.fromWebContents(contents) !== null
    )
  })
}

app.whenReady().then(() => {
  registerVoicePrototypePermissions()
  const codexHome = process.env.CODEX_HOME ?? join(app.getPath('home'), '.codex')
  const providers = createSessionProviders({
    homeDirectory: app.getPath('home'),
    environment: process.env,
    resolveCommand: findCommand
  })
  const manager = createTerminalManager({
    providers,
    spawn: (launch, request, cwd) => spawn(launch.executable, launch.args, {
      name: 'xterm-256color',
      cols: Math.max(2, request.cols),
      rows: Math.max(1, request.rows),
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' }
    })
  })
  const firstMateRuntime = createFirstMateRuntime({
    rootPath: join(app.getPath('userData'), 'firstmate'),
    platform: process.platform,
    codexHome,
    resolveGit: () => findCommand('git')
  })
  const agentManager = createAcpSessionManager({
    appPath: app.getAppPath(),
    codexHome,
    resolveFirstMateLaunch: (provider) => firstMateRuntime.launch(provider)
  })

  registerTerminalIpc(manager, providers)
  registerAgentIpc(agentManager)
  registerFirstMateIpc(firstMateRuntime)
  registerProjectIpc()
  createWindow(manager, agentManager)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(manager, agentManager)
  })
  app.on('before-quit', () => {
    manager.killAll()
    agentManager.killAll()
  })
})

app.on('window-all-closed', () => app.quit())
