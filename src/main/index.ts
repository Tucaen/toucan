import { app, BrowserWindow, dialog, ipcMain, WebContents } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, normalize } from 'node:path'
import { IPty, spawn } from 'node-pty'
import type {
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalKind,
  WorkspaceSaveResult,
  WorkspaceState
} from '../shared/terminal'

interface RunningTerminal {
  process: IPty
  owner: WebContents
}

const terminals = new Map<string, RunningTerminal>()

function workspaceStatePath(): string {
  return join(app.getPath('userData'), 'prototype-workspace.json')
}

function isWorkspaceState(value: unknown): value is WorkspaceState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<WorkspaceState>
  if (state.version !== 1 || !Array.isArray(state.projects)) return false
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

function findCommand(command: string): string | null {
  try {
    const output = execFileSync('where.exe', [command], {
      encoding: 'utf8',
      windowsHide: true
    })
    const matches = output.split(/\r?\n/).filter(Boolean).map((path) => path.trim())
    return matches.find((path) => {
      if (path.includes('\\WindowsApps\\OpenAI.Codex_')) return false
      return ['.exe', '.cmd', '.bat'].includes(extname(path).toLowerCase())
    }) ?? null
  } catch {
    return null
  }
}

function launchFor(kind: TerminalKind): { executable: string; args: string[] } | { error: string } {
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

  const extension = extname(resolved).toLowerCase()
  if (extension === '.cmd' || extension === '.bat') {
    return {
      executable: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', resolved]
    }
  }

  return { executable: resolved, args: [] }
}

function registerTerminalIpc(): void {
  ipcMain.handle(
    'terminal:create',
    (event, request: TerminalCreateRequest): TerminalCreateResult => {
      if (terminals.has(request.id)) return { ok: true }

      const launch = launchFor(request.kind)
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
        const terminal = spawn(launch.executable, launch.args, {
          name: 'xterm-256color',
          cols: Math.max(2, request.cols),
          rows: Math.max(1, request.rows),
          cwd,
          env: { ...process.env, TERM: 'xterm-256color' }
        })

        const owner = event.sender
        terminals.set(request.id, { process: terminal, owner })
        terminal.onData((data) => owner.send('terminal:data', { id: request.id, data }))
        terminal.onExit(({ exitCode }) => {
          terminals.delete(request.id)
          if (!owner.isDestroyed()) owner.send('terminal:exit', { id: request.id, exitCode })
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
    terminals.get(id)?.process.kill()
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
      return isWorkspaceState(parsed) ? parsed : null
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
  for (const terminal of terminals.values()) terminal.process.kill()
  terminals.clear()
})
