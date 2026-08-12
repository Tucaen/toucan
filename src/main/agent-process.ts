import type { SpawnOptionsWithoutStdio } from 'node:child_process'

export interface AgentProcessLaunch {
  executable: string
  args: string[]
  options: SpawnOptionsWithoutStdio
}

export function forceHiddenWindows<T extends Record<string, unknown> | undefined>(options: T): Record<string, unknown> {
  return { ...(options ?? {}), windowsHide: true }
}

const hiddenWindowsPreload = [
  "import childProcess from 'node:child_process'",
  "import { syncBuiltinESMExports } from 'node:module'",
  `const forceHiddenWindows = ${forceHiddenWindows.toString()}`,
  'const originalSpawn = childProcess.spawn.bind(childProcess)',
  'const originalSpawnSync = childProcess.spawnSync.bind(childProcess)',
  'childProcess.spawn = (command, args, options) => originalSpawn(command, args, forceHiddenWindows(options))',
  'childProcess.spawnSync = (command, args, options) => originalSpawnSync(command, args, forceHiddenWindows(options))',
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
