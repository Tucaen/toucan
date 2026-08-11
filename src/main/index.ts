import { app, BrowserWindow, dialog, ipcMain, WebContents } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, normalize } from 'node:path'
import { IPty, spawn } from 'node-pty'
import type {
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalKind,
  WorkspaceSaveResult,
  WorkspaceState
} from '../shared/terminal'
import { sendTerminalEvent } from './terminal-events'

interface RunningTerminal {
  process: IPty
  owner: WebContents
  discoveryTimer?: ReturnType<typeof setInterval>
}

const terminals = new Map<string, RunningTerminal>()
const claimedCodexSessions = new Set<string>()

interface WorkspaceStateV1 {
  version: 1
  projects: WorkspaceState['projects']
  activeProjectId: string | null
  sidebarCollapsed: boolean
}

function workspaceStatePath(): string {
  return join(app.getPath('userData'), 'prototype-workspace.json')
}

function hasValidProjects(value: unknown): value is Pick<WorkspaceState, 'projects' | 'activeProjectId' | 'sidebarCollapsed'> {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<WorkspaceState>
  if (!Array.isArray(state.projects)) return false
  if (state.activeProjectId !== null && typeof state.activeProjectId !== 'string') return false
  if (typeof state.sidebarCollapsed !== 'boolean') return false

  return state.projects.every((project) => (
    project
    && typeof project.id === 'string'
    && typeof project.name === 'string'
    && typeof project.path === 'string'
    && typeof project.color === 'string'
  ))
}

function isWorkspaceState(value: unknown): value is WorkspaceState {
  if (!hasValidProjects(value)) return false
  const state = value as Partial<WorkspaceState>
  if (state.version !== 2 || !Array.isArray(state.nodes)) return false

  return state.nodes.every((node) => (
    node
    && typeof node.id === 'string'
    && ['terminal', 'claude', 'codex'].includes(node.kind)
    && typeof node.label === 'string'
    && typeof node.projectId === 'string'
    && typeof node.position?.x === 'number'
    && typeof node.position?.y === 'number'
    && typeof node.width === 'number'
    && typeof node.height === 'number'
    && (node.conversationId === undefined || typeof node.conversationId === 'string')
  ))
}

function migrateWorkspaceState(value: unknown): WorkspaceState | null {
  if (isWorkspaceState(value)) return value
  if (!hasValidProjects(value) || (value as WorkspaceStateV1).version !== 1) return null
  const previous = value as WorkspaceStateV1
  return {
    version: 2,
    projects: previous.projects,
    activeProjectId: previous.activeProjectId,
    sidebarCollapsed: previous.sidebarCollapsed,
    nodes: []
  }
}

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

function launchFor(request: TerminalCreateRequest): { executable: string; args: string[] } | { error: string } {
  const { kind } = request
  if (kind === 'terminal') {
    const pwsh = findCommand('pwsh.exe')
    if (pwsh) return { executable: pwsh, args: ['-NoLogo'] }

    const powershell = findCommand('powershell.exe')
    if (powershell) return { executable: powershell, args: ['-NoLogo'] }

    return { executable: process.env.ComSpec ?? 'cmd.exe', args: [] }
  }

  const command = kind === 'claude' ? 'claude' : 'codex'
  const resolved = findCommand(command)
  if (!resolved) {
    return {
      error: `${command} is not installed or is not available on PATH. Install it, restart ADE, and try again.`
    }
  }

  if (request.resume && !request.conversationId) {
    return { error: `ADE does not have a saved ${command} conversation ID for this node.` }
  }

  const commandArgs = kind === 'claude'
    ? request.resume
      ? ['--resume', request.conversationId!]
      : request.conversationId
        ? ['--session-id', request.conversationId]
        : []
    : request.resume
      ? ['resume', request.conversationId!]
      : []

  const extension = extname(resolved).toLowerCase()
  if (extension === '.cmd' || extension === '.bat') {
    return {
      executable: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', resolved, ...commandArgs]
    }
  }

  return { executable: resolved, args: commandArgs }
}


function codexSessionDirectories(now: Date): string[] {
  const root = join(process.env.CODEX_HOME ?? join(app.getPath('home'), '.codex'), 'sessions')
  return [0, 1].map((daysAgo) => {
    const date = new Date(now)
    date.setDate(date.getDate() - daysAgo)
    return join(
      root,
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    )
  })
}

function findNewCodexSession(cwd: string, startedAt: number): string | null {
  const candidates: Array<{ id: string; startedAt: number }> = []
  for (const directory of codexSessionDirectories(new Date(startedAt))) {
    if (!existsSync(directory)) continue
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      try {
        const filePath = join(directory, entry.name)
        if (statSync(filePath).birthtimeMs < startedAt - 3000) continue
        const firstLine = readFileSync(filePath, 'utf8').split(/\r?\n/, 1)[0]
        const record = JSON.parse(firstLine) as {
          type?: string
          payload?: { id?: string; cwd?: string; timestamp?: string }
        }
        const id = record.payload?.id
        const sessionCwd = record.payload?.cwd
        const sessionStartedAt = Date.parse(record.payload?.timestamp ?? '')
        if (
          record.type === 'session_meta'
          && id
          && sessionCwd
          && !claimedCodexSessions.has(id)
          && normalize(sessionCwd).toLocaleLowerCase() === normalize(cwd).toLocaleLowerCase()
          && Number.isFinite(sessionStartedAt)
          && sessionStartedAt >= startedAt - 3000
        ) {
          candidates.push({ id, startedAt: sessionStartedAt })
        }
      } catch {
        // The CLI may still be writing its first record; the next poll will retry.
      }
    }
  }

  candidates.sort((left, right) => Math.abs(left.startedAt - startedAt) - Math.abs(right.startedAt - startedAt))
  return candidates[0]?.id ?? null
}

function discoverCodexSession(id: string, cwd: string, startedAt: number): void {
  let attempts = 0
  const running = terminals.get(id)
  if (!running) return

  running.discoveryTimer = setInterval(() => {
    attempts += 1
    const current = terminals.get(id)
    if (!current || attempts > 120) {
      if (running.discoveryTimer) clearInterval(running.discoveryTimer)
      return
    }

    const conversationId = findNewCodexSession(cwd, startedAt)
    if (!conversationId) return
    claimedCodexSessions.add(conversationId)
    if (running.discoveryTimer) clearInterval(running.discoveryTimer)
    running.discoveryTimer = undefined
    sendTerminalEvent(current.owner, 'terminal:session', { id, conversationId })
  }, 250)
}

function registerTerminalIpc(): void {
  ipcMain.handle(
    'terminal:create',
    (event, request: TerminalCreateRequest): TerminalCreateResult => {
      if (terminals.has(request.id)) return { ok: true }

      const launch = launchFor(request)
      if ('error' in launch) return { ok: false, message: launch.error }

      let cwd: string
      try {
        cwd = normalize(request.cwd)
        if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
          return { ok: false, message: `The project folder no longer exists: ${cwd}` }
        }
      } catch {
        return { ok: false, message: `The project folder is not accessible: ${request.cwd}` }
      }

      try {
        const startedAt = Date.now()
        const terminal = spawn(launch.executable, launch.args, {
          name: 'xterm-256color',
          cols: Math.max(2, request.cols),
          rows: Math.max(1, request.rows),
          cwd,
          env: { ...process.env, TERM: 'xterm-256color' }
        })

        const owner = event.sender
        terminals.set(request.id, { process: terminal, owner })
        if (request.kind === 'codex' && !request.resume) {
          discoverCodexSession(request.id, cwd, startedAt)
        }
        terminal.onData((data) => sendTerminalEvent(owner, 'terminal:data', { id: request.id, data }))
        terminal.onExit(({ exitCode }) => {
          const running = terminals.get(request.id)
          if (running?.discoveryTimer) clearInterval(running.discoveryTimer)
          terminals.delete(request.id)
          sendTerminalEvent(owner, 'terminal:exit', { id: request.id, exitCode })
        })
        return { ok: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, message: `Could not start the session: ${message}` }
      }
    }
  )

  ipcMain.on('terminal:write', (_event, id: string, data: string) => {
    terminals.get(id)?.process.write(data)
  })

  ipcMain.on('terminal:resize', (_event, id: string, cols: number, rows: number) => {
    if (cols < 2 || rows < 1) return
    terminals.get(id)?.process.resize(cols, rows)
  })

  ipcMain.on('terminal:kill', (_event, id: string) => {
    const terminal = terminals.get(id)
    if (terminal?.discoveryTimer) clearInterval(terminal.discoveryTimer)
    terminal?.process.kill()
    terminals.delete(id)
  })
}

function registerProjectIpc(): void {
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

  ipcMain.handle('workspace:load', (): WorkspaceState | null => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(workspaceStatePath(), 'utf8'))
      return migrateWorkspaceState(parsed)
    } catch {
      return null
    }
  })

  ipcMain.handle(
    'workspace:save',
    (_event, state: WorkspaceState): WorkspaceSaveResult => {
      if (!isWorkspaceState(state)) return { ok: false, message: 'The workspace state is invalid.' }
      try {
        writeFileSync(workspaceStatePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
        return { ok: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, message }
      }
    }
  )
}

function createWindow(): void {
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
    for (const [id, terminal] of terminals) {
      if (terminal.owner === contents) {
        if (terminal.discoveryTimer) clearInterval(terminal.discoveryTimer)
        terminal.process.kill()
        terminals.delete(id)
      }
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerTerminalIpc()
  registerProjectIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => app.quit())

app.on('before-quit', () => {
  for (const terminal of terminals.values()) {
    if (terminal.discoveryTimer) clearInterval(terminal.discoveryTimer)
    terminal.process.kill()
  }
  terminals.clear()
})
