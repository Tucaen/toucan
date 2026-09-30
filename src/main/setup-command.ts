import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { errorMessage } from '../shared/text'
import { hiddenProcessOptions } from './background-process'
import type { ShellLaunch, TerminalShell } from './terminal-shell'

/**
 * A project's setup command, run to completion without a terminal (#34). On the canvas the setup
 * command is typed into a worktree's terminal on request; a ticket session's worktree has to be set
 * up *before* its chat starts, so it runs here, in the same shell a terminal would have used, and
 * the spawn waits for it.
 */

/** Long, because a setup command is typically a full dependency install; bounded, because it is awaited. */
const SETUP_TIMEOUT_MS = 15 * 60 * 1000
const OUTPUT_TAIL_CHARACTERS = 2000
const SETUP_MAX_BUFFER = 16 * 1024 * 1024

/**
 * How the terminal's shell runs one command and exits: PowerShell by `-Command`, `cmd.exe` by
 * `/c`, anything else by `-c`. The profile is kept, like the terminal's, since a setup command may
 * lean on what it puts on PATH.
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
}): (command: string, cwd: string) => Promise<SetupCommandResult> {
  const timeout = options.timeoutMs ?? SETUP_TIMEOUT_MS
  return (command, cwd) =>
    new Promise<SetupCommandResult>((resolve) => {
      const launch = setupCommandLaunch(options.shell.resolveLaunch(), command)
      try {
        // The callback is the child's `'error'` listener too: a shell that cannot start lands here.
        execFile(
          launch.executable,
          launch.args,
          hiddenProcessOptions({ cwd, timeout, maxBuffer: SETUP_MAX_BUFFER }),
          (error, stdout, stderr) => {
            if (!error) {
              resolve({ ok: true })
              return
            }
            const output = tail(`${stdout}\n${stderr}`)
            const reason = error.killed ? `timed out after ${Math.round(timeout / 1000)}s` : errorMessage(error)
            resolve({ ok: false, error: `"${command}" ${reason}${output ? `\n${output}` : ''}` })
          }
        )
      } catch (error) {
        resolve({ ok: false, error: `"${command}" could not start: ${errorMessage(error)}` })
      }
    })
}
