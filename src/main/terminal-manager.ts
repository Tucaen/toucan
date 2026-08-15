import { existsSync, statSync } from 'node:fs'
import { normalize } from 'node:path'
import type { TerminalCreateRequest, TerminalCreateResult } from '../shared/terminal'
import type { SessionLaunch, SessionProviders } from './session-providers'
import { sendTerminalEvent, type TerminalEventOwner } from './terminal-events'
import { errorMessage } from '../shared/text'

export interface TerminalProcess {
  onData(listener: (data: string) => void): unknown
  onExit(listener: (event: { exitCode: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

interface RunningTerminal {
  process: TerminalProcess
  owner: TerminalEventOwner
  discoveryTimer?: ReturnType<typeof setInterval>
}

export interface TerminalManagerOptions {
  providers: SessionProviders
  spawn(launch: SessionLaunch, request: TerminalCreateRequest, cwd: string): TerminalProcess
  pathExists?(path: string): boolean
  pathIsDirectory?(path: string): boolean
  now?(): number
  discoveryIntervalMs?: number
}

export interface TerminalManager {
  create(request: TerminalCreateRequest, owner: TerminalEventOwner): TerminalCreateResult
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  kill(id: string): void
  killOwned(owner: TerminalEventOwner): void
  killAll(): void
}

export function createTerminalManager(options: TerminalManagerOptions): TerminalManager {
  const terminals = new Map<string, RunningTerminal>()
  const claimedConversations = new Set<string>()
  const pathExists = options.pathExists ?? existsSync
  const pathIsDirectory = options.pathIsDirectory ?? ((path: string) => statSync(path).isDirectory())

  const stop = (id: string): void => {
    const terminal = terminals.get(id)
    if (!terminal) return
    if (terminal.discoveryTimer) clearInterval(terminal.discoveryTimer)
    terminal.process.kill()
    terminals.delete(id)
  }

  return {
    create(request, owner): TerminalCreateResult {
      if (terminals.has(request.id)) return { ok: true }
      const launch = options.providers.resolveLaunch(request)
      if ('error' in launch) return { ok: false, message: launch.error }

      let cwd: string
      try {
        cwd = normalize(request.cwd)
        if (!pathExists(cwd) || !pathIsDirectory(cwd)) {
          return { ok: false, message: `The project folder no longer exists: ${cwd}` }
        }
      } catch {
        return { ok: false, message: `The project folder is not accessible: ${request.cwd}` }
      }

      try {
        const startedAt = (options.now ?? Date.now)()
        const terminal = options.spawn(launch, request, cwd)
        const running: RunningTerminal = { process: terminal, owner }
        terminals.set(request.id, running)
        if (request.kind === 'codex' && !request.resume) {
          let attempts = 0
          running.discoveryTimer = setInterval(() => {
            attempts += 1
            const current = terminals.get(request.id)
            if (!current || attempts > 120) {
              if (running.discoveryTimer) clearInterval(running.discoveryTimer)
              running.discoveryTimer = undefined
              return
            }
            const conversationId = options.providers.discoverConversation(
              request.kind,
              cwd,
              startedAt,
              claimedConversations
            )
            if (!conversationId) return
            claimedConversations.add(conversationId)
            if (running.discoveryTimer) clearInterval(running.discoveryTimer)
            running.discoveryTimer = undefined
            sendTerminalEvent(owner, 'terminal:session', { id: request.id, conversationId })
          }, options.discoveryIntervalMs ?? 250)
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
        return { ok: false, message: `Could not start the session: ${errorMessage(error)}` }
      }
    },
    write(id, data): void {
      terminals.get(id)?.process.write(data)
    },
    resize(id, cols, rows): void {
      if (cols < 2 || rows < 1) return
      terminals.get(id)?.process.resize(cols, rows)
    },
    kill(id): void {
      stop(id)
    },
    killOwned(owner): void {
      for (const [id, terminal] of terminals) {
        if (terminal.owner === owner) stop(id)
      }
    },
    killAll(): void {
      for (const id of [...terminals.keys()]) stop(id)
    }
  }
}
