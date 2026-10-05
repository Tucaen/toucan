/**
 * The dangerous-command guard Toucan registers on every Claude and Codex session as a `PreToolUse`
 * hook.
 *
 * The script (`.agents/command-guard/guard.mjs`) and its contract are provider-neutral: hook JSON on
 * stdin, the command at `.tool_input.command`, exit 2 plus a reason on stderr to block. Only the
 * registrations below are provider-specific, and neither reads or writes the user's own config:
 * - Claude: the hook travels in the per-session settings the adapter hands the CLI.
 * - Codex: hooks in codex-acp's `CODEX_CONFIG` never run (verified on Codex 0.154.0 / codex-acp
 *   1.12.0, ticket 02), and a hook Codex has not been told to trust is skipped. So codex-acp's
 *   `CODEX_PATH` points at a launcher that starts the bundled Codex with the hook and its trust
 *   hash as `-c` overrides. Those load as Codex's session-flags layer of that one process.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { PROJECT_SKILLS_DIRECTORY } from '../shared/project-skills'
import { resolveUnpackedExecutable } from './agent-process'

/**
 * Every shell-like tool a Claude session can run a command through. Codex names every shell call
 * `Bash` in its hook payload, whatever the shell, so the same matcher covers it.
 * @internal exported for tests
 */
export const COMMAND_GUARD_MATCHER = 'Bash|PowerShell'

const GUARD_DIRECTORY = 'command-guard'

const HOOK_TIMEOUT_SECONDS = 10

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
          hooks: [
            { type: 'command', timeout: HOOK_TIMEOUT_SECONDS, ...commandGuardHookCommand(executable, files, platform) }
          ]
        }
      ]
    }
  }
}

/** The variables `codex-launcher.mjs` reads. It removes them before starting Codex. */
const CODEX_LAUNCHER_ENVIRONMENT = {
  runtime: 'TOUCAN_CODEX_RUNTIME',
  executable: 'TOUCAN_CODEX_EXECUTABLE',
  overrides: 'TOUCAN_CODEX_CONFIG_OVERRIDES'
} as const

/** A TOML basic string. JSON's escapes are all valid TOML; only DEL must be escaped on top. */
const tomlString = (value: string): string => JSON.stringify(value).replaceAll('\u007f', '\\u007f')

/** JSON with every object's keys sorted, as Codex's `version_for_toml` canonicalizes before hashing. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * The hash Codex trusts a user-level hook by: SHA-256 over the canonical JSON of the hook's
 * normalized identity (`hook_hash` in codex-rs `hooks/src/engine/discovery.rs`). Not a documented
 * format, so `tests/codex-command-guard.test.ts` pins it to hashes Codex itself reported.
 * @internal exported for tests
 */
export function codexHookTrustHash(matcher: string, command: string): string {
  const identity = {
    event_name: 'pre_tool_use',
    matcher,
    hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS, async: false }]
  }
  return `sha256:${createHash('sha256').update(canonicalJson(identity)).digest('hex')}`
}

/**
 * The `-c` overrides that register the guard on one Codex process and trust it. The hook state is
 * keyed by the synthetic path of the session-flags layer plus the hook's position; the guard is the
 * only hook that layer carries, so it is group 0, handler 0.
 * @internal exported for tests
 */
export function codexCommandGuardOverrides(
  executable: string,
  files: CommandGuardFiles,
  platform: NodeJS.Platform
): string[] {
  // Codex runs a hook in the session's own shell, which is PowerShell on Windows: the same command
  // line Claude's hook names that shell for.
  const { command } = commandGuardHookCommand(executable, files, platform)
  const layer = platform === 'win32' ? 'C:\\<session-flags>\\config.toml' : '/<session-flags>/config.toml'
  const key = `${layer}:pre_tool_use:0:0`
  return [
    `hooks.PreToolUse=[{matcher=${tomlString(COMMAND_GUARD_MATCHER)},hooks=[{type="command",command=${tomlString(command)},timeout=${HOOK_TIMEOUT_SECONDS}}]}]`,
    `hooks.state={${tomlString(key)}={trusted_hash=${tomlString(codexHookTrustHash(COMMAND_GUARD_MATCHER, command))}}}`
  ]
}

/** The Rust target each platform package of `@openai/codex` ships its binary under. */
const CODEX_TARGETS: Record<string, string> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl'
}

export interface BundledCodex {
  /** The native binary, never a `.cmd` or `codex.js` wrapper: the launcher runs it directly. */
  executable: string
  /** `@openai/codex`'s package root, which `codex.js` reports to the binary it starts. */
  packageRoot: string
}

/**
 * The Codex an adapter runs when nothing overrides it, found the way the adapter's own `codex.js`
 * finds it: `@openai/codex` resolved from the adapter, then its platform package resolved from
 * there. So a guarded session runs the same Codex version an unguarded one would. A packaged
 * binary is run from `app.asar.unpacked`, where electron-builder puts it. Null where no binary for
 * this machine is installed; then `codex.js` could not start one either.
 */
export function resolveBundledCodex(
  adapterPath: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  pathExists: (path: string) => boolean = existsSync
): BundledCodex | null {
  const target = CODEX_TARGETS[`${platform}-${arch}`]
  if (!target) return null
  try {
    const packageRoot = dirname(createRequire(adapterPath).resolve('@openai/codex/package.json'))
    const platformPackage = createRequire(join(packageRoot, 'package.json')).resolve(
      `@openai/codex-${platform}-${arch}/package.json`
    )
    const binary = join(dirname(platformPackage), 'vendor', target, 'bin', platform === 'win32' ? 'codex.exe' : 'codex')
    const executable = resolveUnpackedExecutable(binary, pathExists)
    return pathExists(executable) ? { executable, packageRoot } : null
  } catch {
    return null
  }
}

export interface CodexCommandGuardLaunch {
  /** Toucan's own binary: it runs both the launcher and the guard as Node. */
  runtime: string
  codex: BundledCodex
  files: CommandGuardFiles
  platform?: NodeJS.Platform
}

/**
 * The adapter environment that guards a Codex session: codex-acp starts `CODEX_PATH app-server`,
 * and the launcher shipped beside the guard script turns that into the bundled Codex with the
 * overrides above. `codex.js` is skipped that way, so its two variables are set here instead.
 */
export function codexCommandGuardEnvironment(launch: CodexCommandGuardLaunch): Record<string, string> {
  const platform = launch.platform ?? process.platform
  const launcher = platform === 'win32' ? 'codex-launcher.cmd' : 'codex-launcher.sh'
  return {
    CODEX_PATH: join(dirname(launch.files.script), launcher),
    CODEX_MANAGED_PACKAGE_ROOT: launch.codex.packageRoot,
    CODEX_MANAGED_BY_NPM: '1',
    [CODEX_LAUNCHER_ENVIRONMENT.runtime]: launch.runtime,
    [CODEX_LAUNCHER_ENVIRONMENT.executable]: launch.codex.executable,
    [CODEX_LAUNCHER_ENVIRONMENT.overrides]: JSON.stringify(
      codexCommandGuardOverrides(launch.runtime, launch.files, platform)
    )
  }
}
