import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { FirstMateInstallResult, FirstMateRuntimeStatus } from '../shared/firstmate'

const execFileAsync = promisify(execFile)
const FIRSTMATE_REPOSITORY = 'https://github.com/kunchenguid/firstmate.git'

export interface FirstMateLaunch {
  cwd: string
  environment: NodeJS.ProcessEnv
}

export interface FirstMateRuntime {
  status(): FirstMateRuntimeStatus
  install(): Promise<FirstMateInstallResult>
  launch(): FirstMateLaunch | null
}

export interface FirstMateRuntimeOptions {
  rootPath: string
  platform: NodeJS.Platform
  resolveGit(): string | null
  clone?(git: string, repository: string, target: string): Promise<void>
}

function isDistro(path: string): boolean {
  return existsSync(join(path, 'AGENTS.md')) && existsSync(join(path, 'bin', 'fm-spawn.sh'))
}

function workerSupport(platform: NodeJS.Platform): Pick<FirstMateRuntimeStatus, 'workerSupport' | 'message'> {
  return platform === 'win32'
    ? {
        workerSupport: 'wsl_required',
        message: 'FirstMate workers require a Linux runtime. Configure WSL with tmux and the FirstMate toolchain.'
      }
    : { workerSupport: 'native' }
}

export function createFirstMateRuntime(options: FirstMateRuntimeOptions): FirstMateRuntime {
  const distroPath = join(options.rootPath, 'distro')
  const homePath = join(options.rootPath, 'home')
  let installing = false
  let lastError: string | undefined

  const status = (): FirstMateRuntimeStatus => {
    const support = workerSupport(options.platform)
    if (installing) return { state: 'installing', distroPath, homePath, ...support }
    if (isDistro(distroPath)) return { state: 'ready', distroPath, homePath, ...support }
    if (lastError) return { state: 'error', distroPath, homePath, ...support, message: lastError }
    return { state: 'missing', distroPath, homePath, ...support }
  }

  const prepareHome = (): void => {
    for (const directory of ['data', 'state', 'config', 'projects']) {
      mkdirSync(join(homePath, directory), { recursive: true })
    }
  }

  return {
    status,
    async install(): Promise<FirstMateInstallResult> {
      if (installing) return { ok: false, status: status() }
      if (isDistro(distroPath)) {
        prepareHome()
        return { ok: true, status: status() }
      }
      if (existsSync(distroPath)) {
        lastError = `The FirstMate distro path exists but is incomplete: ${distroPath}`
        return { ok: false, status: status() }
      }
      const git = options.resolveGit()
      if (!git) {
        lastError = 'Git is required to install FirstMate.'
        return { ok: false, status: status() }
      }

      installing = true
      lastError = undefined
      mkdirSync(options.rootPath, { recursive: true })
      const temporaryPath = join(options.rootPath, `distro-installing-${crypto.randomUUID()}`)
      try {
        if (options.clone) {
          await options.clone(git, FIRSTMATE_REPOSITORY, temporaryPath)
        } else {
          await execFileAsync(git, ['clone', '--depth', '1', FIRSTMATE_REPOSITORY, temporaryPath], {
            windowsHide: true
          })
        }
        if (!isDistro(temporaryPath)) throw new Error('The downloaded repository is not a valid FirstMate distro.')
        renameSync(temporaryPath, distroPath)
        prepareHome()
        installing = false
        return { ok: true, status: status() }
      } catch (error) {
        installing = false
        rmSync(temporaryPath, { recursive: true, force: true })
        lastError = error instanceof Error ? error.message : String(error)
        return { ok: false, status: status() }
      }
    },
    launch(): FirstMateLaunch | null {
      if (!isDistro(distroPath)) return null
      prepareHome()
      return {
        cwd: distroPath,
        environment: { ...process.env, FM_HOME: homePath }
      }
    }
  }
}
