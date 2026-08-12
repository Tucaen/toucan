import type { SpawnOptionsWithoutStdio } from 'node:child_process'

export interface AgentProcessLaunch {
  executable: string
  args: string[]
  options: SpawnOptionsWithoutStdio
}

export function forceHiddenWindows<T extends Record<string, unknown> | undefined>(options: T): Record<string, unknown> {
  return { ...(options ?? {}), windowsHide: true }
}

const hiddenWindowsBootstrap = [
  "const childProcess = require('node:child_process')",
  `const forceHiddenWindows = ${forceHiddenWindows.toString()}`,
  'const originalSpawn = childProcess.spawn.bind(childProcess)',
  'const originalSpawnSync = childProcess.spawnSync.bind(childProcess)',
  'childProcess.spawn = (command, args, options) => originalSpawn(command, args, forceHiddenWindows(options))',
  'childProcess.spawnSync = (command, args, options) => originalSpawnSync(command, args, forceHiddenWindows(options))',
  "require('node:module').syncBuiltinESMExports()",
  "void import(require('node:url').pathToFileURL(process.argv[1]).href).catch((error) => { console.error(error); process.exitCode = 1 })"
].join(';')

export function buildAgentProcessLaunch(
  executable: string,
  adapterPath: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  adapterArgs: string[] = []
): AgentProcessLaunch {
  return {
    executable,
    args: ['-e', hiddenWindowsBootstrap, adapterPath, ...adapterArgs],
    options: {
      cwd,
      env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true
    }
  }
}
