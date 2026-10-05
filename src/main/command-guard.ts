/**
 * The dangerous-command guard Toucan registers on every Claude session as a `PreToolUse` hook.
 *
 * The script (`.agents/command-guard/guard.mjs`) and its contract are provider-neutral: hook JSON on
 * stdin, the command at `.tool_input.command`, exit 2 plus a reason on stderr to block. Only the
 * registration below is Claude-specific. The hook travels in the per-session settings the adapter
 * hands the CLI, so nothing under the user's `~/.claude` is read or written.
 */
import { join } from 'node:path'
import { PROJECT_SKILLS_DIRECTORY } from '../shared/project-skills'

/**
 * Every shell-like tool a Claude session can run a command through.
 * @internal exported for tests
 */
export const COMMAND_GUARD_MATCHER = 'Bash|PowerShell'

const GUARD_DIRECTORY = 'command-guard'

export interface CommandGuardFiles {
  script: string
  patterns: string
}

export function commandGuardFiles(root: string): CommandGuardFiles {
  const directory = join(root, PROJECT_SKILLS_DIRECTORY, GUARD_DIRECTORY)
  return { script: join(directory, 'guard.mjs'), patterns: join(directory, 'dangerous-patterns.txt') }
}

interface CommandHook {
  type: 'command'
  command: string
  shell: 'bash' | 'powershell'
  timeout: number
}

export interface CommandGuardSettings {
  hooks: { PreToolUse: Array<{ matcher: string; hooks: CommandHook[] }> }
}

const posixQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const powershellQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`

/**
 * The hook command line. `executable` is Toucan's own binary, which only behaves as Node with
 * `ELECTRON_RUN_AS_NODE`, so the variable is set inside the command rather than in the session
 * environment, where every tool the agent runs would inherit it (AGENTS.md, #226). Windows uses
 * PowerShell, which every Windows machine has, so no bash is needed there.
 * @internal exported for tests
 */
export function commandGuardHookCommand(
  executable: string,
  files: CommandGuardFiles,
  platform: NodeJS.Platform
): Pick<CommandHook, 'command' | 'shell'> {
  if (platform === 'win32') {
    const run = [executable, files.script, files.patterns].map(powershellQuote)
    return {
      shell: 'powershell',
      command: `$env:ELECTRON_RUN_AS_NODE = '1'; & ${run.join(' ')}; exit $LASTEXITCODE`
    }
  }
  return {
    shell: 'bash',
    command: `ELECTRON_RUN_AS_NODE=1 ${[executable, files.script, files.patterns].map(posixQuote).join(' ')}`
  }
}

export function commandGuardSettings(
  executable: string,
  files: CommandGuardFiles,
  platform: NodeJS.Platform = process.platform
): CommandGuardSettings {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: COMMAND_GUARD_MATCHER,
          hooks: [{ type: 'command', timeout: 10, ...commandGuardHookCommand(executable, files, platform) }]
        }
      ]
    }
  }
}
