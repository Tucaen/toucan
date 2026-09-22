import { join } from 'node:path'

/**
 * Where Claude Code keeps its per-user state. `CLAUDE_CONFIG_DIR` relocates the whole directory,
 * and every reader of it has to agree: the cleanup launcher forwards the variable to the CLI it
 * spawns, so a probe that looked under `~/.claude` regardless reported "not installed" for a
 * plugin the same CLI would have loaded (#221). The value is a path, not a list - Toucan reads the
 * single directory Claude Code itself treats as authoritative - and a blank one is not a
 * relocation, only an empty variable left behind by a shell.
 */
export function claudeConfigRoot(homeDirectory: string, environment: NodeJS.ProcessEnv = process.env): string {
  const relocated = environment.CLAUDE_CONFIG_DIR?.trim()
  return relocated ? relocated : join(homeDirectory, '.claude')
}
