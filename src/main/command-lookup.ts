/**
 * Where an external command lives on this machine. The answer is cached for the life of the app:
 * a PATH entry does not move under a running process, and the caller that asks most - the ticket
 * board's `gh` probe, twice per project every ten seconds of board activity - was paying for a
 * synchronous `where.exe` each time, on the thread that also draws the window.
 *
 * Both shapes share one cache. `find` is what everything reaching for a command should use;
 * `findSync` exists for the spawn paths that cannot await (`terminal-shell` picks a shell inside a
 * synchronous `create`), and a command either of them resolved is free for the other afterwards.
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'
import { hiddenProcessOptions } from './background-process'

const execFileAsync = promisify(execFile)

/** What `where.exe` may hand back as an executable; anything else on PATH is not launchable. */
const EXECUTABLE_EXTENSIONS = ['.exe', '.cmd', '.bat']

/**
 * What a fallback directory is probed for: an installer writes a shim or a binary, never a `.bat`.
 * `.cmd` first because the dominant fallback is npm's global folder, where a shim is what npm
 * writes - the order only decides anything for a directory holding both.
 */
const FALLBACK_EXTENSIONS = ['.cmd', '.exe']

/**
 * The Microsoft Store's Codex stub: it is on PATH, it is not the CLI, and running it opens the
 * Store rather than answering. Never a resolution, however early it appears in `where.exe`'s list.
 */
const STORE_STUB = '\\WindowsApps\\OpenAI.Codex_'

export interface CommandLookupOptions {
  /**
   * Directories searched before PATH - an npm shim folder, a user-local `bin` - because a globally
   * installed CLI is the one the user means even when an older copy shadows it on PATH.
   */
  fallbackDirectories: readonly string[]
  /**
   * How PATH itself is searched, in each shape. Injected together so a test substitutes one rule
   * rather than two: both take a command name and return `where.exe`'s stdout, and both signal
   * "nothing on PATH" by throwing rather than by returning empty.
   */
  where?: {
    sync(command: string): string
    async(command: string): Promise<string>
  }
  pathExists?: (path: string) => boolean
}

export interface CommandLookup {
  /** The resolved path, or `null` when nothing on this machine answers to `command`. */
  find(command: string): Promise<string | null>
  /** `find` for the callers that cannot await; fills and reads the same cache. */
  findSync(command: string): string | null
}

const defaultWhere = {
  sync: (command: string): string => execFileSync('where.exe', [command], hiddenProcessOptions({ encoding: 'utf8' })),
  async: async (command: string): Promise<string> => {
    const { stdout } = await execFileAsync('where.exe', [command], hiddenProcessOptions({ encoding: 'utf8' }))
    return stdout
  }
}

export function createCommandLookup(options: CommandLookupOptions): CommandLookup {
  const where = options.where ?? defaultWhere
  const exists = options.pathExists ?? existsSync
  const resolved = new Map<string, string | null>()
  /** In flight by command, so ten probes starting at once run one `where.exe` between them. */
  const pending = new Map<string, Promise<string | null>>()

  const fallbacksFor = (command: string): string[] =>
    options.fallbackDirectories.flatMap((directory) =>
      FALLBACK_EXTENSIONS.map((extension) => join(directory, `${command}${extension}`))
    )

  /** The fallbacks that are really there, then PATH's own answers, in that order of preference. */
  const choose = (command: string, output: string | null): string | null => {
    const installed = fallbacksFor(command).filter((path) => exists(path))
    if (output === null) return installed[0] ?? null
    const candidates = [
      ...installed,
      ...output
        .split(/\r?\n/)
        .filter(Boolean)
        .map((path) => path.trim())
    ]
    return (
      candidates.find(
        (path) => !path.includes(STORE_STUB) && EXECUTABLE_EXTENSIONS.includes(extname(path).toLowerCase())
      ) ?? null
    )
  }

  /**
   * Only a *found* command is remembered. "Not installed" is the one answer that changes under a
   * running app - the user installs `gh` and expects the board to notice - and re-probing it costs
   * a `where.exe` that no longer blocks the thread drawing the window, which was the whole problem.
   */
  const remember = (command: string, path: string | null): string | null => {
    if (path !== null) resolved.set(command, path)
    return path
  }

  return {
    async find(command) {
      const cached = resolved.get(command)
      if (cached !== undefined) return cached
      const inFlight = pending.get(command)
      if (inFlight) return inFlight
      const probe = where
        .async(command)
        .then(
          (output) => choose(command, output),
          () => choose(command, null)
        )
        .then((path) => remember(command, path))
        .finally(() => pending.delete(command))
      pending.set(command, probe)
      return probe
    },
    findSync(command) {
      const cached = resolved.get(command)
      if (cached !== undefined) return cached
      let output: string | null = null
      try {
        output = where.sync(command)
      } catch {
        // Nothing on PATH answers to it; a fallback still might.
      }
      return remember(command, choose(command, output))
    }
  }
}
