import type { SpawnOptionsWithoutStdio } from 'node:child_process'

export interface AgentProcessLaunch {
  executable: string
  args: string[]
  options: SpawnOptionsWithoutStdio
}

export function forceHiddenWindows<T extends Record<string, unknown> | undefined>(options: T): Record<string, unknown> {
  return { ...(options ?? {}), windowsHide: true }
}

export function resolveUnpackedExecutable(command: string, pathExists: (path: string) => boolean): string {
  const unpacked = command.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
  return unpacked !== command && pathExists(unpacked) ? unpacked : command
}

const hiddenWindowsPreload = [
  "import childProcess from 'node:child_process'",
  "import { existsSync } from 'node:fs'",
  "import { syncBuiltinESMExports } from 'node:module'",
  `const forceHiddenWindows = ${forceHiddenWindows.toString()}`,
  `const resolveUnpackedExecutable = ${resolveUnpackedExecutable.toString()}`,
  'const originalSpawn = childProcess.spawn.bind(childProcess)',
  'const originalSpawnSync = childProcess.spawnSync.bind(childProcess)',
  'childProcess.spawn = (command, args, options) => originalSpawn(resolveUnpackedExecutable(command, existsSync), args, forceHiddenWindows(options))',
  'childProcess.spawnSync = (command, args, options) => originalSpawnSync(resolveUnpackedExecutable(command, existsSync), args, forceHiddenWindows(options))',
  "Object.defineProperty(childProcess.spawn, '__adeForceHiddenWindows', { value: true })",
  "Object.defineProperty(childProcess.spawnSync, '__adeForceHiddenWindows', { value: true })",
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
    options: {
      cwd,
      env: { ...environment, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: nodeOptions },
      windowsHide: true
    }
  }
}
