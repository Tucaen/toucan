import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { errorMessage } from '../shared/text'
import { hiddenProcessOptions } from './background-process'
import { killProcessTree } from './process-tree'
import type { ShellLaunch, TerminalShell } from './terminal-shell'

/**
 * A project's setup command, run to completion without a terminal (#34). On the canvas the setup
 * command is typed into a worktree's terminal on request; a ticket session's worktree has to be set
 * up *before* its chat starts, so it runs here, in the same shell a terminal would have used, and
 * the ticket's start waits for it - in the background, since `spawn` has long answered.
 */

/** Long, because a setup command is typically a full dependency install; bounded, because it is awaited. */
const SETUP_TIMEOUT_MS = 15 * 60 * 1000
const OUTPUT_TAIL_CHARACTERS = 2000
const SETUP_MAX_BUFFER = 16 * 1024 * 1024
/** How long a stopped command's tree may take to let go of its pipes - and the worktree - after the kill. */
const KILL_GRACE_MS = 5_000

/**
 * How the terminal's shell runs one command and exits: PowerShell by `-Command`, `cmd.exe` by
 * `/c`, anything else by `-c`. PowerShell keeps its profile, like the terminal's, since a setup
 * command may lean on what it puts on PATH; a POSIX `-c` shell reads no rc files either way.
 * @internal exported for tests
 */
export function setupCommandLaunch(shell: ShellLaunch, command: string): ShellLaunch {
  const name = basename(shell.executable.replace(/\\/g, '/')).toLowerCase()
  if (name === 'pwsh.exe' || name === 'powershell.exe' || name === 'pwsh' || name === 'powershell') {
    return { executable: shell.executable, args: ['-NoLogo', '-NonInteractive', '-Command', command] }
  }
  if (name === 'cmd.exe' || name === 'cmd') return { executable: shell.executable, args: ['/d', '/s', '/c', command] }
  return { executable: shell.executable, args: ['-c', command] }
}

export type SetupCommandResult = { ok: true } | { ok: false; error: string }

const tail = (text: string): string => {
  const trimmed = text.trim()
  return trimmed.length > OUTPUT_TAIL_CHARACTERS ? `...${trimmed.slice(-OUTPUT_TAIL_CHARACTERS)}` : trimmed
}

export function createSetupCommandRunner(options: {
  shell: TerminalShell
  timeoutMs?: number
}): (command: string, cwd: string, signal?: AbortSignal) => Promise<SetupCommandResult> {
  const timeout = options.timeoutMs ?? SETUP_TIMEOUT_MS
  return (command, cwd, signal) =>
    new Promise<SetupCommandResult>((resolve) => {
      const cancelled: SetupCommandResult = { ok: false, error: `"${command}" was cancelled` }
      if (signal?.aborted) {
        resolve(cancelled)
        return
      }
      const launch = setupCommandLaunch(options.shell.resolveLaunch(), command)
      let settled = false
      let stopping = false
      const settle = (result: SetupCommandResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        resolve(result)
      }
      let child: ReturnType<typeof execFile> | undefined
      // Own timer rather than execFile's `timeout`, which kills only the shell: an `npm install`
      // below it would keep the pipes open and the callback - and the waiting spawn - unanswered.
      // Answered once the tree is gone, so a worktree removed next is no longer held open by it.
      const stop = (result: SetupCommandResult): void => {
        if (stopping) return
        stopping = true
        clearTimeout(timer)
        const running = child
        if (running?.pid === undefined) {
          settle(result)
          return
        }
        // The pipes close once nothing of the tree holds them any more.
        const closed = new Promise<void>((resolve) => {
          const grace = setTimeout(resolve, KILL_GRACE_MS)
          running.once('close', () => {
            clearTimeout(grace)
            resolve()
          })
        })
        // The shell and everything it started; a tree that is already gone is the goal anyway.
        void killProcessTree(running, 'SIGKILL')
          .then(() => closed)
          .then(() => settle(result))
      }
      const timer = setTimeout(
        () => stop({ ok: false, error: `"${command}" timed out after ${Math.round(timeout / 1000)}s` }),
        timeout
      )
      const cancel = (): void => stop(cancelled)
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        // The callback is the child's `'error'` listener too: a shell that cannot start lands here.
        child = execFile(
          launch.executable,
          launch.args,
          hiddenProcessOptions({ cwd, maxBuffer: SETUP_MAX_BUFFER }),
          (error, stdout, stderr) => {
            // A stopped command answers with why it was stopped, not with the kill's exit.
            if (stopping) return
            if (!error) {
              settle({ ok: true })
              return
            }
            const output = tail(`${stdout}
${stderr}`)
            settle({
              ok: false,
              error: `"${command}" ${errorMessage(error)}${
                output
                  ? `
${output}`
                  : ''
              }`
            })
          }
        )
      } catch (error) {
        settle({ ok: false, error: `"${command}" could not start: ${errorMessage(error)}` })
      }
    })
}
