/**
 * Launches ACP adapters on Toucan's own Electron binary running as Node.
 *
 * The hidden-window policy travels as a `--import` preload in `NODE_OPTIONS` next to
 * `ELECTRON_RUN_AS_NODE=1`. Both variables are only meaningful to processes on the adapter
 * runtime, so the preload removes them from its own `process.env` once it has patched
 * `node:child_process`, and re-attaches them solely for children whose command names
 * `process.execPath` (spawn/execFile of that path, an exec string quoting it, and `fork`).
 * Provider CLIs, their tool shells, and anything the agent runs in the user's checkout therefore
 * inherit the environment Toucan was given. AGENTS.md records why (#226).
 */
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { hiddenProcessOptions } from './background-process'

export interface AgentProcessLaunch {
  executable: string
  args: string[]
  options: SpawnOptionsWithoutStdio
}

export function resolveUnpackedExecutable(command: string, pathExists: (path: string) => boolean): string {
  const unpacked = command.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
  return unpacked !== command && pathExists(unpacked) ? unpacked : command
}

/** Environment for a process on the adapter runtime: run Electron as Node with the preload attached. */
export function agentRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
  preloadOption: string | undefined
): NodeJS.ProcessEnv {
  const nodeOptions = [environment.NODE_OPTIONS?.trim(), preloadOption].filter(Boolean).join(' ')
  const runtime: NodeJS.ProcessEnv = { ...environment, ELECTRON_RUN_AS_NODE: '1' }
  if (nodeOptions) runtime.NODE_OPTIONS = nodeOptions
  return runtime
}

/**
 * Removes the launch variables from `environment` in place and returns the preload option that
 * was found, so the caller can re-attach it for children on the same runtime.
 */
export function detachAgentRuntimeEnvironment(environment: NodeJS.ProcessEnv): string | undefined {
  const tokens = (environment.NODE_OPTIONS ?? '').split(' ')
  // The marker literal recurs in the preload's defineProperty line: this function is embedded via
  // toString(), so it cannot close over a shared constant.
  const preloadOption = tokens.find(
    (token) => token.startsWith('--import=data:text/javascript,') && token.includes('__adeForceHiddenWindows')
  )
  const remaining = tokens
    .filter((token) => token !== preloadOption)
    .join(' ')
    .trim()
  if (remaining) environment.NODE_OPTIONS = remaining
  else delete environment.NODE_OPTIONS
  delete environment.ELECTRON_RUN_AS_NODE
  return preloadOption
}

const hiddenWindowsPreload = [
  "import childProcess from 'node:child_process'",
  "import { existsSync } from 'node:fs'",
  "import { syncBuiltinESMExports } from 'node:module'",
  `const forceHiddenWindows = ${hiddenProcessOptions.toString()}`,
  `const resolveUnpackedExecutable = ${resolveUnpackedExecutable.toString()}`,
  `const agentRuntimeEnvironment = ${agentRuntimeEnvironment.toString()}`,
  `const detachAgentRuntimeEnvironment = ${detachAgentRuntimeEnvironment.toString()}`,
  'const preloadOption = detachAgentRuntimeEnvironment(process.env)',
  'const namesOwnRuntime = (command) => typeof command === "string" && command.includes(process.execPath)',
  'const launchOptionsFor = (command, options) => forceHiddenWindows(namesOwnRuntime(command) ? { ...options, env: agentRuntimeEnvironment(options?.env ?? process.env, preloadOption) } : options)',
  'const resolveCommand = (command) => resolveUnpackedExecutable(command, existsSync)',
  'const originalSpawn = childProcess.spawn.bind(childProcess)',
  'const originalSpawnSync = childProcess.spawnSync.bind(childProcess)',
  'const originalExec = childProcess.exec.bind(childProcess)',
  'const originalExecSync = childProcess.execSync.bind(childProcess)',
  'const originalExecFile = childProcess.execFile.bind(childProcess)',
  'const originalExecFileSync = childProcess.execFileSync.bind(childProcess)',
  'const originalFork = childProcess.fork.bind(childProcess)',
  'childProcess.spawn = (command, args, options) => Array.isArray(args) ? originalSpawn(resolveCommand(command), args, launchOptionsFor(command, options)) : originalSpawn(resolveCommand(command), launchOptionsFor(command, args))',
  'childProcess.spawnSync = (command, args, options) => Array.isArray(args) ? originalSpawnSync(resolveCommand(command), args, launchOptionsFor(command, options)) : originalSpawnSync(resolveCommand(command), launchOptionsFor(command, args))',
  'childProcess.exec = (command, options, callback) => typeof options === "function" ? originalExec(command, launchOptionsFor(command, undefined), options) : originalExec(command, launchOptionsFor(command, options), callback)',
  'childProcess.execSync = (command, options) => originalExecSync(command, launchOptionsFor(command, options))',
  'childProcess.execFile = (file, args, options, callback) => Array.isArray(args) ? (typeof options === "function" ? originalExecFile(resolveCommand(file), args, launchOptionsFor(file, undefined), options) : originalExecFile(resolveCommand(file), args, launchOptionsFor(file, options), callback)) : (typeof args === "function" ? originalExecFile(resolveCommand(file), launchOptionsFor(file, undefined), args) : args == null && typeof options !== "function" ? originalExecFile(resolveCommand(file), [], launchOptionsFor(file, options), callback) : originalExecFile(resolveCommand(file), launchOptionsFor(file, args), options))',
  'childProcess.execFileSync = (file, args, options) => Array.isArray(args) ? originalExecFileSync(resolveCommand(file), args, launchOptionsFor(file, options)) : args == null && options !== undefined ? originalExecFileSync(resolveCommand(file), [], launchOptionsFor(file, options)) : originalExecFileSync(resolveCommand(file), launchOptionsFor(file, args))',
  'childProcess.fork = (modulePath, args, options) => Array.isArray(args) ? originalFork(modulePath, args, launchOptionsFor(options?.execPath ?? process.execPath, options)) : originalFork(modulePath, launchOptionsFor(args?.execPath ?? process.execPath, args))',
  "for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) Object.defineProperty(childProcess[method], '__adeForceHiddenWindows', { value: true })",
  'syncBuiltinESMExports()'
].join(';')

/**
 * `NODE_OPTIONS` that make a Node child apply the hidden-window policy to everything *it* spawns.
 * Exported because an ACP adapter is not the only untrusted thing Toucan runs on Node: a project's
 * Prettier configuration is a checkout's own code too, and it may spawn as freely as an adapter's
 * provider CLI does.
 */
export const hiddenWindowsPreloadOption = `--import=data:text/javascript,${encodeURIComponent(hiddenWindowsPreload)}`

export function buildAgentProcessLaunch(
  executable: string,
  adapterPath: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  adapterArgs: string[] = []
): AgentProcessLaunch {
  return {
    executable,
    args: [adapterPath, ...adapterArgs],
    options: hiddenProcessOptions({
      cwd,
      env: agentRuntimeEnvironment(environment, hiddenWindowsPreloadOption)
    })
  }
}

export function spawnAgentProcess(launch: AgentProcessLaunch): ChildProcessWithoutNullStreams {
  return spawn(
    launch.executable,
    launch.args,
    hiddenProcessOptions({ ...launch.options, stdio: ['pipe', 'pipe', 'pipe'] })
  )
}
