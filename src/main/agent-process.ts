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

const hiddenWindowsPreload = [
  "import childProcess from 'node:child_process'",
  "import { existsSync } from 'node:fs'",
  "import { syncBuiltinESMExports } from 'node:module'",
  `const forceHiddenWindows = ${hiddenProcessOptions.toString()}`,
  `const resolveUnpackedExecutable = ${resolveUnpackedExecutable.toString()}`,
  'const originalSpawn = childProcess.spawn.bind(childProcess)',
  'const originalSpawnSync = childProcess.spawnSync.bind(childProcess)',
  'const originalExec = childProcess.exec.bind(childProcess)',
  'const originalExecSync = childProcess.execSync.bind(childProcess)',
  'const originalExecFile = childProcess.execFile.bind(childProcess)',
  'const originalExecFileSync = childProcess.execFileSync.bind(childProcess)',
  'const originalFork = childProcess.fork.bind(childProcess)',
  'childProcess.spawn = (command, args, options) => Array.isArray(args) ? originalSpawn(resolveUnpackedExecutable(command, existsSync), args, forceHiddenWindows(options)) : originalSpawn(resolveUnpackedExecutable(command, existsSync), forceHiddenWindows(args))',
  'childProcess.spawnSync = (command, args, options) => Array.isArray(args) ? originalSpawnSync(resolveUnpackedExecutable(command, existsSync), args, forceHiddenWindows(options)) : originalSpawnSync(resolveUnpackedExecutable(command, existsSync), forceHiddenWindows(args))',
  'childProcess.exec = (command, options, callback) => typeof options === "function" ? originalExec(command, forceHiddenWindows(undefined), options) : originalExec(command, forceHiddenWindows(options), callback)',
  'childProcess.execSync = (command, options) => originalExecSync(command, forceHiddenWindows(options))',
  'childProcess.execFile = (file, args, options, callback) => Array.isArray(args) ? (typeof options === "function" ? originalExecFile(resolveUnpackedExecutable(file, existsSync), args, forceHiddenWindows(undefined), options) : originalExecFile(resolveUnpackedExecutable(file, existsSync), args, forceHiddenWindows(options), callback)) : (typeof args === "function" ? originalExecFile(resolveUnpackedExecutable(file, existsSync), forceHiddenWindows(undefined), args) : args == null && typeof options !== "function" ? originalExecFile(resolveUnpackedExecutable(file, existsSync), [], forceHiddenWindows(options), callback) : originalExecFile(resolveUnpackedExecutable(file, existsSync), forceHiddenWindows(args), options))',
  'childProcess.execFileSync = (file, args, options) => Array.isArray(args) ? originalExecFileSync(resolveUnpackedExecutable(file, existsSync), args, forceHiddenWindows(options)) : args == null && options !== undefined ? originalExecFileSync(resolveUnpackedExecutable(file, existsSync), [], forceHiddenWindows(options)) : originalExecFileSync(resolveUnpackedExecutable(file, existsSync), forceHiddenWindows(args))',
  'childProcess.fork = (modulePath, args, options) => Array.isArray(args) ? originalFork(modulePath, args, forceHiddenWindows(options)) : originalFork(modulePath, forceHiddenWindows(args))',
  "for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) Object.defineProperty(childProcess[method], '__adeForceHiddenWindows', { value: true })",
  'syncBuiltinESMExports()'
].join(';')

const hiddenWindowsPreloadOption = `--import=data:text/javascript,${encodeURIComponent(hiddenWindowsPreload)}`

export function buildAgentProcessLaunch(
  executable: string,
  adapterPath: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  adapterArgs: string[] = []
): AgentProcessLaunch {
  const nodeOptions = [environment.NODE_OPTIONS?.trim(), hiddenWindowsPreloadOption].filter(Boolean).join(' ')
  return {
    executable,
    args: [adapterPath, ...adapterArgs],
    options: hiddenProcessOptions({
      cwd,
      env: { ...environment, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: nodeOptions }
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
