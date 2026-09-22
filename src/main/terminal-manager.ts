import { randomUUID } from 'node:crypto'
import { isTerminalSize } from './ipc-validation'
import { existsSync, statSync } from 'node:fs'
import { normalize } from 'node:path'
import type { TerminalCreateRequest, TerminalCreateResult, TerminalLiveness } from '../shared/terminal'
import type { ShellLaunch, TerminalShell } from './terminal-shell'
import { sendTerminalEvent, type TerminalEventOwner } from './terminal-events'
import { errorMessage } from '../shared/text'
import type { TerminalScrollbackStore } from './terminal-scrollback-store'
import type { TerminalLivenessStore } from './terminal-liveness-store'
import { TERMINAL_CHANNELS } from '../shared/ipc-channels'
import { createTerminalOutputTails, type TerminalOutputRead, type TerminalReadOptions } from './terminal-output-tail'

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
  shell: TerminalShell
  spawn(launch: ShellLaunch, request: TerminalCreateRequest, cwd: string): TerminalProcess
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
  /**
   * Serves a bounded slice of the terminal's retained output to one agent session, advancing that
   * session's read cursor (`terminal-output-tail.ts`). Undefined means there is nothing to read
   * about this terminal at all - it was never started here, or its session has been retired.
   *
   * This grants nothing: whether `agentId` may read `sessionId` is the edge registry's call-time
   * decision, made before this is ever reached. The id is here only because the cursor is per
   * reader - two agents watching one dev server each get their own "since last time".
   */
  readOutput(agentId: string, sessionId: string, options?: TerminalReadOptions): TerminalOutputRead | undefined
  /** Drops a retired session's retained output and read cursors. */
  forgetSession(sessionId: string): void
}

export function createTerminalManager(options: TerminalManagerOptions): TerminalManager {
  const terminals = new Map<string, RunningTerminal>()
  const lastStates = new Map<string, { incarnationId: string; liveness: TerminalLiveness }>()
  // Outlives the incarnation that filled it, exactly like `lastStates`: a read after a crash has
  // to return the crash output, labelled with the verdict `lastStates` holds.
  const outputTails = createTerminalOutputTails()
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
    options.scrollback?.flush(sessionId, incarnationId)
    terminal.process.kill()
    return true
  }

  return {
    create(request, owner): TerminalCreateResult {
      if (!isTerminalSize(request.cols, request.rows)) return { ok: false, message: 'Invalid terminal size.' }
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
      const launch = options.shell.resolveLaunch()

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
        outputTails.begin(sessionId, incarnationId)
        terminal.onData((data) => {
          if (terminals.get(sessionId) === running) {
            options.scrollback?.append(sessionId, incarnationId, data)
            outputTails.append(sessionId, incarnationId, data)
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
          options.scrollback?.flush(sessionId, incarnationId)
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
      if (!isTerminalSize(cols, rows)) return false
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
    },
    readOutput(agentId, sessionId, options): TerminalOutputRead | undefined {
      const state = lastStates.get(sessionId)
      if (!state) return undefined
      const read = outputTails.read(agentId, sessionId, options)
      if (!read) return undefined
      return {
        terminalSessionId: sessionId,
        incarnationId: read.incarnationId,
        // The verdict travels with the output rather than being read out of it, so a crashed
        // build's output arrives labelled `exited` instead of looking like a build still running.
        liveness: state.liveness,
        text: read.text,
        delta: read.delta,
        skippedBytes: read.skippedBytes
      }
    },
    forgetSession(sessionId): void {
      outputTails.forget(sessionId)
    }
  }
}
