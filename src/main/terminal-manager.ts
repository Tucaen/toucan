import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { normalize } from 'node:path'
import type { TerminalCreateRequest, TerminalCreateResult, TerminalLiveness } from '../shared/terminal'
import type { SessionLaunch, SessionProviders } from './session-providers'
import { sendTerminalEvent, type TerminalEventOwner } from './terminal-events'
import { errorMessage } from '../shared/text'
import type { TerminalScrollbackStore } from './terminal-scrollback-store'
import type { TerminalLivenessStore } from './terminal-liveness-store'
import { TERMINAL_CHANNELS } from '../shared/ipc-channels'

export interface TerminalProcess {
  onData(listener: (data: string) => void): unknown
  onExit(listener: (event: { exitCode: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

interface RunningTerminal {
  sessionId: string
  incarnationId: string
  process: TerminalProcess
  owner: TerminalEventOwner | null
  attachmentId: string
  liveness: TerminalLiveness
}

export interface TerminalManagerOptions {
  providers: SessionProviders
  spawn(launch: SessionLaunch, request: TerminalCreateRequest, cwd: string): TerminalProcess
  pathExists?(path: string): boolean
  pathIsDirectory?(path: string): boolean
  createIncarnationId?(): string
  scrollback?: TerminalScrollbackStore
  liveness?: TerminalLivenessStore
}

export interface TerminalManager {
  create(request: TerminalCreateRequest, owner: TerminalEventOwner): TerminalCreateResult
  write(sessionId: string, incarnationId: string, data: string): boolean
  resize(sessionId: string, incarnationId: string, cols: number, rows: number): boolean
  kill(sessionId: string, incarnationId: string, attachmentId: string): boolean
  disconnectOwner(owner: TerminalEventOwner): void
  killAll(): void
  state(sessionId: string): { incarnationId: string; liveness: TerminalLiveness } | undefined
}

export function createTerminalManager(options: TerminalManagerOptions): TerminalManager {
  const terminals = new Map<string, RunningTerminal>()
  const lastStates = new Map<string, { incarnationId: string; liveness: TerminalLiveness }>()
  const pathExists = options.pathExists ?? existsSync
  const pathIsDirectory = options.pathIsDirectory ?? ((path: string) => statSync(path).isDirectory())

  const matches = (sessionId: string, incarnationId: string): RunningTerminal | undefined => {
    const terminal = terminals.get(sessionId)
    return terminal?.incarnationId === incarnationId ? terminal : undefined
  }

  /**
   * Records a verdict in memory, and durably whenever the owner actually observed it.
   * `unverifiable` is a restore-time conclusion rather than an observation — the owner can only
   * report that it holds a process or that the process is gone — so it is never written to disk.
   */
  const remember = (sessionId: string, incarnationId: string, liveness: TerminalLiveness): void => {
    lastStates.set(sessionId, { incarnationId, liveness })
    if (liveness !== 'unverifiable') options.liveness?.record(sessionId, incarnationId, liveness)
  }

  const stop = (sessionId: string, incarnationId: string, attachmentId?: string): boolean => {
    const terminal = matches(sessionId, incarnationId)
    if (!terminal || (attachmentId !== undefined && terminal.attachmentId !== attachmentId)) return false
    terminals.delete(sessionId)
    terminal.owner = null
    // Toucan asked for this termination, so the verdict is recorded on the request rather than on
    // the exit callback. Shutdown kills the callback along with the process that would deliver it,
    // and a terminal Toucan itself killed must not come back as `unverifiable`.
    terminal.liveness = 'exited'
    remember(sessionId, incarnationId, 'exited')
    terminal.process.kill()
    return true
  }

  return {
    create(request, owner): TerminalCreateResult {
      const sessionId = request.sessionId ?? request.id
      const attachmentId = request.attachmentId ?? request.id
      const existing = terminals.get(sessionId)
      if (existing) {
        existing.owner = owner
        existing.attachmentId = attachmentId
        existing.liveness = 'live'
        remember(sessionId, existing.incarnationId, 'live')
        return {
          ok: true,
          sessionId: existing.sessionId,
          incarnationId: existing.incarnationId,
          liveness: 'live'
        }
      }
      const launch = options.providers.resolveLaunch()

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
        const terminal = options.spawn(launch, request, cwd)
        const incarnationId = (options.createIncarnationId ?? randomUUID)()
        const running: RunningTerminal = {
          sessionId,
          incarnationId,
          process: terminal,
          owner,
          attachmentId,
          liveness: 'live'
        }
        terminals.set(sessionId, running)
        remember(sessionId, incarnationId, 'live')
        options.scrollback?.begin(sessionId, incarnationId)
        terminal.onData((data) => {
          if (terminals.get(sessionId) === running) {
            options.scrollback?.append(sessionId, incarnationId, data)
          }
          if (terminals.get(sessionId) === running && running.owner) {
            sendTerminalEvent(running.owner, TERMINAL_CHANNELS.data, {
              sessionId,
              incarnationId,
              attachmentId: running.attachmentId,
              data
            })
          }
        })
        terminal.onExit(({ exitCode }) => {
          const current = terminals.get(sessionId)
          if (current && current !== running) return
          if (current === running) terminals.delete(sessionId)
          if (lastStates.get(sessionId)?.incarnationId !== incarnationId) return
          remember(sessionId, incarnationId, 'exited')
          if (running.owner)
            sendTerminalEvent(running.owner, TERMINAL_CHANNELS.exit, {
              sessionId,
              incarnationId,
              attachmentId: running.attachmentId,
              exitCode
            })
        })
        // Only a freshly spawned incarnation gets seeded input; reattaching to a terminal that
        // already exists returns above, so a setup command can never be replayed into a shell
        // that has already run it.
        if (request.initialInput) terminal.write(request.initialInput)
        return { ok: true, sessionId, incarnationId, liveness: lastStates.get(sessionId)?.liveness ?? 'live' }
      } catch (error) {
        return { ok: false, message: `Could not start the session: ${errorMessage(error)}` }
      }
    },
    write(sessionId, incarnationId, data): boolean {
      const terminal = matches(sessionId, incarnationId)
      if (!terminal) return false
      terminal.process.write(data)
      return true
    },
    resize(sessionId, incarnationId, cols, rows): boolean {
      if (cols < 2 || rows < 1) return false
      const terminal = matches(sessionId, incarnationId)
      if (!terminal) return false
      terminal.process.resize(cols, rows)
      return true
    },
    kill(sessionId, incarnationId, attachmentId): boolean {
      return stop(sessionId, incarnationId, attachmentId)
    },
    disconnectOwner(owner): void {
      for (const terminal of terminals.values()) {
        if (terminal.owner === owner) {
          terminal.owner = null
          terminal.liveness = 'unverifiable'
          remember(terminal.sessionId, terminal.incarnationId, 'unverifiable')
        }
      }
    },
    killAll(): void {
      for (const terminal of [...terminals.values()]) stop(terminal.sessionId, terminal.incarnationId)
    },
    state(sessionId) {
      return lastStates.get(sessionId)
    }
  }
}
