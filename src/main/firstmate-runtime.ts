import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AgentProvider } from '../shared/agent'
import type { FirstMateActionResult, FirstMateInstallResult, FirstMateRuntimeStatus } from '../shared/firstmate'
import type { AgentProcessLaunch } from './agent-process'

const execFileAsync = promisify(execFile)
const FIRSTMATE_REPOSITORY = 'https://github.com/kunchenguid/firstmate.git'
const CODEX_ACP_VERSION = '1.1.14'
const CLAUDE_ACP_VERSION = '0.66.0'
const WSL_BASE = '.local/share/ade/firstmate'
const WSL_REQUIRED_FACTS = [
  'distro',
  'runner.codex',
  'runner.claude',
  'tool.node',
  'tool.git',
  'tool.gh',
  'tool.tmux',
  'tool.jq',
  'tool.treehouse',
  'tool.no-mistakes',
  'tool.gh-axi',
  'tool.chrome-devtools-axi',
  'tool.lavish-axi',
  'tool.tasks-axi',
  'tool.quota-axi'
]
const WSL_INSPECT_SCRIPT = `
set -u
base="$HOME/${WSL_BASE}"
export PATH="$HOME/.local/bin:$PATH"
printf 'home=%s\n' "$HOME"
[ -f "$base/distro/AGENTS.md" ] && [ -f "$base/distro/bin/fm-spawn.sh" ] && printf 'distro=1\n' || true
[ -f "$base/runner/node_modules/@agentclientprotocol/codex-acp/dist/index.js" ] && printf 'runner.codex=1\n' || true
[ -f "$base/runner/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js" ] && printf 'runner.claude=1\n' || true
for tool in node git gh tmux jq treehouse no-mistakes gh-axi chrome-devtools-axi lavish-axi tasks-axi quota-axi; do
  command -v "$tool" >/dev/null 2>&1 && printf 'tool.%s=1\n' "$tool" || true
done
gh auth status >/dev/null 2>&1 && printf 'githubAuth=authenticated\n' || printf 'githubAuth=required\n'
config="$base/home/codex/config.toml"
project="$base/distro"
header="[projects.'$project']"
if [ -f "$config" ] && awk -v header="$header" '
  $0 == header { in_section = 1; next }
  in_section && /^\\[/ { in_section = 0 }
  in_section && /^[[:space:]]*trust_level[[:space:]]*=[[:space:]]*"trusted"[[:space:]]*$/ { trusted = 1 }
  END { exit trusted ? 0 : 1 }
' "$config"; then
  printf 'codexTrust=trusted\n'
else
  printf 'codexTrust=required\n'
fi
`
const WSL_AGENT_SCRIPT = `
set -eu
umask 077
host_auth="$1"
managed_auth="$2"
shift 2
mkdir -p "$(dirname "$managed_auth")"
if [ -f "$host_auth" ] && { [ ! -f "$managed_auth" ] || [ "$host_auth" -nt "$managed_auth" ]; }; then
  cp "$host_auth" "$managed_auth"
  chmod 600 "$managed_auth"
fi
exec /usr/bin/env "$@"
`
const WSL_TRUST_CODEX_PROJECT_SCRIPT = `
set -eu
umask 077
config="$1"
project="$2"
header="[projects.'$project']"
mkdir -p "$(dirname "$config")"
if [ -f "$config" ] && grep -Fqx "$header" "$config"; then
  if awk -v header="$header" '
    $0 == header { in_section = 1; next }
    in_section && /^\\[/ { in_section = 0 }
    in_section && /^[[:space:]]*trust_level[[:space:]]*=[[:space:]]*"trusted"[[:space:]]*$/ { trusted = 1 }
    END { exit trusted ? 0 : 1 }
  ' "$config"; then
    exit 0
  fi
  printf 'Refusing to overwrite an existing non-trusted section for %s\n' "$project" >&2
  exit 13
fi
if [ -s "$config" ]; then
  printf '\n' >> "$config"
fi
printf '[projects.'"'"'%s'"'"']\ntrust_level = "trusted"\n' "$project" >> "$config"
chmod 600 "$config"
`
const WSL_PREPARE_SCRIPT = `
set -eu
base="$HOME/${WSL_BASE}"
distro="$base/distro"
temporary="$base/distro-installing"
mkdir -p "$HOME/.local/bin" "$base" "$base/home/data" "$base/home/state/acp-logs" "$base/home/config" "$base/home/projects" "$base/runner"
cd "$base"
if [ -e "$distro" ] && { [ ! -f "$distro/AGENTS.md" ] || [ ! -f "$distro/bin/fm-spawn.sh" ]; }; then
  printf 'The managed FirstMate distro exists but is incomplete: %s\n' "$distro" >&2
  exit 12
fi
if [ ! -e "$distro" ]; then
  rm -rf "$temporary"
  git clone --depth 1 ${FIRSTMATE_REPOSITORY} "$temporary"
  mv "$temporary" "$distro"
fi
printf 'tmux\n' > "$base/home/config/backend"
npm install --prefix "$base/runner" --omit=dev \
  @agentclientprotocol/codex-acp@${CODEX_ACP_VERSION} \
  @agentclientprotocol/claude-agent-acp@${CLAUDE_ACP_VERSION}
export PATH="$HOME/.local/bin:$PATH"
export NPM_CONFIG_PREFIX="$HOME/.local"
FM_HOME="$base/home" FM_BACKEND=tmux "$distro/bin/fm-bootstrap.sh" install \
  treehouse no-mistakes gh-axi chrome-devtools-axi lavish-axi tasks-axi quota-axi
`

export interface FirstMateLaunch {
  cwd: string
  environment: NodeJS.ProcessEnv
  agentProcess?: AgentProcessLaunch
  authProcess?(args: string[]): AgentProcessLaunch
}

export interface FirstMateRuntime {
  status(): Promise<FirstMateRuntimeStatus>
  install(): Promise<FirstMateInstallResult>
  authenticateGitHub(): Promise<FirstMateActionResult>
  trustCodexProject(): Promise<FirstMateActionResult>
  launch(provider?: AgentProvider): FirstMateLaunch | null
}

export interface FirstMateCommandResult {
  stdout: string
  stderr: string
}

export interface FirstMateWslOptions {
  distribution?: string
  executable?: string
  run?(args: string[], timeoutMs: number): Promise<FirstMateCommandResult>
  openTerminal?(title: string, executable: string, args: string[]): Promise<void>
}

export interface FirstMateRuntimeOptions {
  rootPath: string
  platform: NodeJS.Platform
  /** Native Codex home shared by ADE's regular Codex nodes. */
  codexHome?: string
  /** Native Claude home shared by ADE's regular Claude nodes. */
  claudeHome?: string
  resolveGit(): string | null
  clone?(git: string, repository: string, target: string): Promise<void>
  wsl?: FirstMateWslOptions
}

function isDistro(path: string): boolean {
  return existsSync(join(path, 'AGENTS.md')) && existsSync(join(path, 'bin', 'fm-spawn.sh'))
}

function linuxPaths(home: string): {
  distroPath: string
  homePath: string
  runnerPaths: Record<AgentProvider, string>
} {
  const base = `${home}/${WSL_BASE}`
  return {
    distroPath: `${base}/distro`,
    homePath: `${base}/home`,
    runnerPaths: {
      codex: `${base}/runner/node_modules/@agentclientprotocol/codex-acp/dist/index.js`,
      claude: `${base}/runner/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js`
    }
  }
}

function facts(output: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator > 0) result.set(line.slice(0, separator), line.slice(separator + 1))
  }
  return result
}

function windowsPathToWsl(path: string): string | undefined {
  const normalized = path.replace(/\\/g, '/')
  const match = /^([a-zA-Z]):\/(.+)$/.exec(normalized)
  return match ? `/mnt/${match[1].toLocaleLowerCase()}/${match[2]}` : undefined
}

function createWslFirstMateRuntime(options: FirstMateRuntimeOptions): FirstMateRuntime {
  const distribution = options.wsl?.distribution ?? 'Ubuntu'
  const executable = options.wsl?.executable ?? 'wsl.exe'
  const run = options.wsl?.run ?? (async (args: string[], timeoutMs: number): Promise<FirstMateCommandResult> => {
    const result = await execFileAsync(executable, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    })
    return { stdout: String(result.stdout), stderr: String(result.stderr) }
  })
  const openTerminal = options.wsl?.openTerminal ?? (async (
    title: string,
    command: string,
    args: string[]
  ): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('wt.exe', ['new-tab', '--title', title, command, ...args], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      })
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
      child.once('error', reject)
    })
  })
  const placeholder = linuxPaths('~')
  let installing = false
  let lastError: string | undefined
  let readyLaunches: Record<AgentProvider, FirstMateLaunch> | null = null

  const inspect = async (): Promise<FirstMateRuntimeStatus> => {
    if (installing) {
      return {
        state: 'installing',
        distroPath: placeholder.distroPath,
        homePath: placeholder.homePath,
        host: 'wsl',
        backend: 'tmux',
        distribution,
        message: `Provisioning FirstMate in ${distribution}. This can take several minutes.`
      }
    }
    try {
      const result = await run(
        ['--distribution', distribution, '--exec', '/bin/sh', '-lc', WSL_INSPECT_SCRIPT],
        15_000
      )
      const detected = facts(result.stdout)
      const home = detected.get('home')
      if (!home?.startsWith('/')) throw new Error(`Could not resolve the ${distribution} user home.`)
      const paths = linuxPaths(home)
      const sharedCodexHome = options.codexHome ? windowsPathToWsl(options.codexHome) : undefined
      const sharedClaudeHome = options.claudeHome ? windowsPathToWsl(options.claudeHome) : undefined
      const managedCodexHome = `${paths.homePath}/codex`
      const managedClaudeHome = `${paths.homePath}/claude`
      const missing = WSL_REQUIRED_FACTS.filter((name) => detected.get(name) !== '1')
      if (missing.length > 0) {
        readyLaunches = null
        return {
          state: lastError ? 'error' : 'missing',
          distroPath: paths.distroPath,
          homePath: paths.homePath,
          host: 'wsl',
          backend: 'tmux',
          distribution,
          message: lastError ?? `ADE will provision FirstMate, Codex and Claude ACP, tmux, and 14 supporting tools in ${distribution}.`
        }
      }
      const commonEnvironment = [
        `FM_HOME=${paths.homePath}`,
        'FM_BACKEND=tmux',
        `PATH=${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`
      ]
      const managedLaunch = (
        runnerPath: string,
        hostAuth: string,
        managedAuth: string,
        environment: string[],
        adapterArgs: string[] = []
      ): AgentProcessLaunch => ({
        executable,
        args: [
          '--distribution', distribution,
          '--cd', paths.distroPath,
          '--exec', '/bin/sh', '-lc', WSL_AGENT_SCRIPT, 'ade-firstmate-agent',
          hostAuth,
          managedAuth,
          ...commonEnvironment,
          ...environment,
          '/usr/bin/node', runnerPath,
          ...adapterArgs
        ],
        options: { env: process.env, windowsHide: true }
      })
      const codexLaunch: FirstMateLaunch = {
        cwd: paths.distroPath,
        environment: process.env,
        agentProcess: managedLaunch(
          paths.runnerPaths.codex,
          sharedCodexHome ? `${sharedCodexHome}/auth.json` : '',
          `${managedCodexHome}/auth.json`,
          [
            `CODEX_HOME=${managedCodexHome}`,
            `APP_SERVER_LOGS=${paths.homePath}/state/acp-logs`
          ]
        ),
        authProcess: (args) => managedLaunch(
          paths.runnerPaths.codex,
          sharedCodexHome ? `${sharedCodexHome}/auth.json` : '',
          `${managedCodexHome}/auth.json`,
          [`CODEX_HOME=${managedCodexHome}`],
          args
        )
      }
      const claudeLaunch: FirstMateLaunch = {
        cwd: paths.distroPath,
        environment: process.env,
        agentProcess: managedLaunch(
          paths.runnerPaths.claude,
          sharedClaudeHome ? `${sharedClaudeHome}/.credentials.json` : '',
          `${managedClaudeHome}/.credentials.json`,
          [`CLAUDE_CONFIG_DIR=${managedClaudeHome}`]
        ),
        authProcess: (args) => managedLaunch(
          paths.runnerPaths.claude,
          sharedClaudeHome ? `${sharedClaudeHome}/.credentials.json` : '',
          `${managedClaudeHome}/.credentials.json`,
          [`CLAUDE_CONFIG_DIR=${managedClaudeHome}`],
          args
        )
      }
      readyLaunches = { codex: codexLaunch, claude: claudeLaunch }
      lastError = undefined
      return {
        state: 'ready',
        distroPath: paths.distroPath,
        homePath: paths.homePath,
        host: 'wsl',
        backend: 'tmux',
        distribution,
        githubAuth: detected.get('githubAuth') === 'authenticated' ? 'authenticated' : 'required',
        codexProjectTrust: detected.get('codexTrust') === 'trusted' ? 'trusted' : 'required'
      }
    } catch (error) {
      readyLaunches = null
      const message = error instanceof Error ? error.message : String(error)
      return {
        state: 'error',
        distroPath: placeholder.distroPath,
        homePath: placeholder.homePath,
        host: 'wsl',
        backend: 'tmux',
        distribution,
        message: lastError ?? `Ubuntu WSL is unavailable: ${message}`
      }
    }
  }

  return {
    status: inspect,
    async install(): Promise<FirstMateInstallResult> {
      if (installing) return { ok: false, status: await inspect() }
      installing = true
      lastError = undefined
      try {
        await run(
          [
            '--distribution', distribution,
            '--user', 'root',
            '--exec', '/usr/bin/env',
            'DEBIAN_FRONTEND=noninteractive',
            '/usr/bin/apt-get', 'update'
          ],
          10 * 60_000
        )
        await run(
          [
            '--distribution', distribution,
            '--user', 'root',
            '--exec', '/usr/bin/env',
            'DEBIAN_FRONTEND=noninteractive',
            '/usr/bin/apt-get', 'install', '-y',
            'ca-certificates', 'curl', 'git', 'gh', 'jq', 'nodejs', 'npm', 'tmux'
          ],
          10 * 60_000
        )
        await run(
          ['--distribution', distribution, '--exec', '/bin/bash', '-lc', WSL_PREPARE_SCRIPT],
          15 * 60_000
        )
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      } finally {
        installing = false
      }
      const status = await inspect()
      return { ok: status.state === 'ready', status }
    },
    async authenticateGitHub(): Promise<FirstMateActionResult> {
      const current = await inspect()
      if (current.state !== 'ready') {
        return { ok: false, message: current.message ?? 'FirstMate is not ready.' }
      }
      const home = current.homePath.slice(0, -`/${WSL_BASE}/home`.length)
      try {
        await openTerminal('ADE FirstMate - GitHub sign in', executable, [
          '--distribution', distribution,
          '--exec', '/usr/bin/env',
          `PATH=${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
          'gh', 'auth', 'login', '--web', '--git-protocol', 'https'
        ])
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
    async trustCodexProject(): Promise<FirstMateActionResult> {
      const current = await inspect()
      if (current.state !== 'ready') {
        return { ok: false, message: current.message ?? 'FirstMate is not ready.' }
      }
      if (current.codexProjectTrust === 'trusted') return { ok: true }
      try {
        await run(
          [
            '--distribution', distribution,
            '--exec', '/bin/sh', '-c', WSL_TRUST_CODEX_PROJECT_SCRIPT,
            'ade-firstmate-trust',
            `${current.homePath}/codex/config.toml`,
            current.distroPath
          ],
          15_000
        )
        const updated = await inspect()
        return updated.codexProjectTrust === 'trusted'
          ? { ok: true }
          : { ok: false, message: 'Codex project trust was not enabled.' }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
    launch(provider = 'codex'): FirstMateLaunch | null {
      return readyLaunches?.[provider] ?? null
    }
  }
}

function createNativeFirstMateRuntime(options: FirstMateRuntimeOptions): FirstMateRuntime {
  const distroPath = join(options.rootPath, 'distro')
  const homePath = join(options.rootPath, 'home')
  let installing = false
  let lastError: string | undefined

  const status = (): FirstMateRuntimeStatus => {
    const common = { distroPath, homePath, host: 'native' as const, backend: 'tmux' as const }
    if (installing) return { state: 'installing', ...common }
    if (isDistro(distroPath)) return { state: 'ready', ...common }
    if (lastError) return { state: 'error', ...common, message: lastError }
    return { state: 'missing', ...common }
  }

  const prepareHome = (): void => {
    for (const directory of ['data', 'state', 'config', 'projects']) {
      mkdirSync(join(homePath, directory), { recursive: true })
    }
  }

  return {
    async status(): Promise<FirstMateRuntimeStatus> { return status() },
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
    async authenticateGitHub(): Promise<FirstMateActionResult> {
      return { ok: false, message: 'GitHub sign-in is managed only by the Windows WSL runtime.' }
    },
    async trustCodexProject(): Promise<FirstMateActionResult> {
      return { ok: false, message: 'Codex project trust is managed only by the Windows WSL runtime.' }
    },
    launch(_provider: AgentProvider = 'codex'): FirstMateLaunch | null {
      if (!isDistro(distroPath)) return null
      prepareHome()
      return {
        cwd: distroPath,
        environment: { ...process.env, FM_HOME: homePath, FM_BACKEND: 'tmux' }
      }
    }
  }
}

export function createFirstMateRuntime(options: FirstMateRuntimeOptions): FirstMateRuntime {
  return options.platform === 'win32'
    ? createWslFirstMateRuntime(options)
    : createNativeFirstMateRuntime(options)
}
