/** The executable and arguments one plain terminal is spawned with. */
export interface ShellLaunch {
  executable: string
  args: string[]
}

/**
 * What the choice is made from: the process environment, and a lookup that answers whether a
 * command is on PATH. Both are injected so the decision is testable without a shell installed.
 */
export interface TerminalShellOptions {
  environment: NodeJS.ProcessEnv
  resolveCommand(command: string): string | null
}

/**
 * The port `TerminalManager` asks before every spawn. An interface rather than a bare function
 * because it is the manager's injection seam: a test substitutes it without a real PATH.
 */
export interface TerminalShell {
  /**
   * Which shell a plain terminal launches. Windows-first: PowerShell 7 if it is installed, Windows
   * PowerShell otherwise, and the environment's own `ComSpec` as the last resort - a machine with
   * neither PowerShell still gets a terminal rather than a failed spawn.
   */
  resolveLaunch(): ShellLaunch
}

export function createTerminalShell(options: TerminalShellOptions): TerminalShell {
  return {
    resolveLaunch(): ShellLaunch {
      const pwsh = options.resolveCommand('pwsh.exe')
      if (pwsh) return { executable: pwsh, args: ['-NoLogo'] }
      const powershell = options.resolveCommand('powershell.exe')
      if (powershell) return { executable: powershell, args: ['-NoLogo'] }
      return { executable: options.environment.ComSpec ?? 'cmd.exe', args: [] }
    }
  }
}
