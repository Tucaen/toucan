import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AgentProvider } from '../shared/agent'
import type {
  FirstMateActionResult,
  FirstMateInstallResult,
  FirstMateLifecycleStatus,
  FirstMateRuntimeStatus
} from '../shared/firstmate'
import type { AgentProcessLaunch } from './agent-process'
import {
  firstMateLifecycleFromFiles,
  firstMateValidatorFromRuntimeConfig,
  noMistakesContinuation,
  readFirstMateLifecycle,
  readFirstMateLifecycleFiles,
  recordFirstMateLifecycle,
  type FirstMateLifecycleFiles,
  type FirstMateLifecycleRecord
} from './firstmate-lifecycle'

const execFileAsync = promisify(execFile)
const FIRSTMATE_REPOSITORY = 'https://github.com/kunchenguid/firstmate.git'
const CODEX_ACP_VERSION = '1.1.14'
const CODEX_CLI_VERSION = '0.147.0'
const CLAUDE_ACP_VERSION = '0.66.0'
const CLAUDE_CLI_VERSION = '2.1.232'
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
  'tool.claude',
  'tool.codex',
  'tool.treehouse',
  'tool.no-mistakes',
  'tool.gh-axi',
  'tool.chrome-devtools-axi',
  'tool.lavish-axi',
  'tool.tasks-axi',
  'tool.quota-axi',
  'wrapper.claude',
  'wrapper.codex',
  'daemon.no-mistakes'
]
const WSL_INSPECT_SCRIPT = `
set -u
base="$HOME/${WSL_BASE}"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
printf 'home=%s\n' "$HOME"
[ -f "$base/distro/AGENTS.md" ] && [ -f "$base/distro/bin/fm-spawn.sh" ] && printf 'distro=1\n' || true
[ -f "$base/runner/node_modules/@agentclientprotocol/codex-acp/dist/index.js" ] && printf 'runner.codex=1\n' || true
[ -f "$base/runner/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js" ] && printf 'runner.claude=1\n' || true
for tool in node git gh tmux jq claude codex treehouse no-mistakes gh-axi chrome-devtools-axi lavish-axi tasks-axi quota-axi; do
  command -v "$tool" >/dev/null 2>&1 && printf 'tool.%s=1\n' "$tool" || true
done
[ -x "$base/home/bin/claude" ] && printf 'wrapper.claude=1\n' || true
[ -x "$base/home/bin/codex" ] && printf 'wrapper.codex=1\n' || true
NM_HOME="$base/home/no-mistakes" no-mistakes daemon status >/dev/null 2>&1 && printf 'daemon.no-mistakes=1\n' || true
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
pipeline_agent="$3"
pipeline_config="$4"
pipeline_bin="$5"
pipeline_model="$6"
runtime_config="$7"
runtime_home="$8"
shift 8
mkdir -p "$(dirname "$managed_auth")"
if [ -f "$host_auth" ] && { [ ! -f "$managed_auth" ] || [ "$host_auth" -nt "$managed_auth" ]; }; then
  cp "$host_auth" "$managed_auth"
  chmod 600 "$managed_auth"
fi
mkdir -p "$(dirname "$pipeline_config")"
pipeline_config_tmp="$pipeline_config.ade.$$"
trap 'rm -f "$pipeline_config_tmp"' EXIT HUP INT TERM
printf 'agent: %s\nagent_path_override:\n  claude: "%s/claude"\n  codex: "%s/codex"\n' \
  "$pipeline_agent" "$pipeline_bin" "$pipeline_bin" > "$pipeline_config_tmp"
chmod 600 "$pipeline_config_tmp"
mv "$pipeline_config_tmp" "$pipeline_config"
trap - EXIT HUP INT TERM
case "$pipeline_agent" in
  codex)
    model_arg=
    [ "$pipeline_model" = default ] || model_arg="--model $pipeline_model"
    cat > "$pipeline_bin/codex" <<EOF
#!/bin/sh
export CODEX_HOME="$runtime_home/codex"
exec "$HOME/.local/bin/codex" $model_arg "\$@"
EOF
    ;;
  claude)
    model_arg=
    [ "$pipeline_model" = default ] || model_arg="--model $pipeline_model"
    cat > "$pipeline_bin/claude" <<EOF
#!/bin/sh
export CLAUDE_CONFIG_DIR="$runtime_home/claude"
export DISABLE_AUTOUPDATER=1
exec "$HOME/.local/bin/claude" $model_arg "\$@"
EOF
    ;;
esac
chmod 700 "$pipeline_bin/$pipeline_agent"
runtime_config_tmp="$runtime_config.ade.$$"
/usr/bin/node - "$runtime_config_tmp" "$pipeline_agent" "$pipeline_model" "$runtime_home" <<'NODE'
const fs = require('node:fs')
const [path, agent, model, home] = process.argv.slice(2)
const config = {
  version: 1,
  host: { kind: 'ade-app', supervisor: 'app-native', terminalTarget: false },
  validator: { agent, model, nmHome: home + '/no-mistakes', agentHome: home + '/' + agent }
}
fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\\n', { mode: 0o600 })
NODE
mv "$runtime_config_tmp" "$runtime_config"
if command -v tmux >/dev/null 2>&1 && tmux list-sessions >/dev/null 2>&1; then
  tmux set-environment -g FM_HOME "$runtime_home"
  tmux set-environment -g NM_HOME "$runtime_home/no-mistakes"
  tmux set-environment -g CODEX_HOME "$runtime_home/codex"
  tmux set-environment -g CLAUDE_CONFIG_DIR "$runtime_home/claude"
  tmux set-environment -g FM_SUPERVISOR_BACKEND ade
  tmux set-environment -g FM_SUPERVISOR_TARGET ade-firstmate-acp
  tmux set-environment -g ADE_FIRSTMATE_RUNTIME_CONFIG "$runtime_config"
  tmux set-environment -g ADE_FIRSTMATE_VALIDATOR_AGENT "$pipeline_agent"
  tmux set-environment -g ADE_FIRSTMATE_VALIDATOR_MODEL "$pipeline_model"
fi
exec /usr/bin/env "$@"
`

const WSL_LIFECYCLE_READ_SCRIPT = `
const fs = require('node:fs')
const path = require('node:path')
const home = process.argv[1]
const optional = (file) => { try { return fs.readFileSync(file, 'utf8') } catch { return undefined } }
const state = path.join(home, 'state')
let names = []
try { names = fs.readdirSync(state) } catch {}
const tasks = names.filter((name) => name.endsWith('.meta')).map((name) => {
  const id = name.slice(0, -5)
  return {
    id,
    meta: optional(path.join(state, id + '.meta')) || '',
    status: optional(path.join(state, id + '.status')) || ''
  }
})
process.stdout.write(JSON.stringify({
  runtimeConfig: optional(path.join(home, 'config', 'ade-runtime.json')),
  journal: optional(path.join(state, '.ade-lifecycle.json')),
  tasks
}))
`

const WSL_LIFECYCLE_RECORD_SCRIPT = `
const fs = require('node:fs')
const path = require('node:path')
const home = process.argv[1]
const taskId = process.argv[2]
const record = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'))
const state = path.join(home, 'state')
const target = path.join(state, '.ade-lifecycle.json')
fs.mkdirSync(state, { recursive: true })
let journal = { version: 1, tasks: {} }
try {
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
  if (parsed.version === 1 && parsed.tasks && typeof parsed.tasks === 'object') journal = parsed
} catch {}
journal.tasks[taskId] = record
const temporary = target + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp'
fs.writeFileSync(temporary, JSON.stringify(journal, null, 2) + '\\n', { mode: 0o600 })
fs.renameSync(temporary, target)
`

const WSL_VALIDATOR_CONFIGURE_SCRIPT = `
set -eu
home="$1"
agent="$2"
model="$3"
bin="$home/bin"
pipeline_config="$home/no-mistakes/config.yaml"
mkdir -p "$bin" "$(dirname "$pipeline_config")" "$home/config"
tmp="$pipeline_config.ade.$$"
trap 'rm -f "$tmp" "$home/config/ade-runtime.json.ade.$$"' EXIT HUP INT TERM
printf 'agent: %s\nagent_path_override:\n  claude: "%s/claude"\n  codex: "%s/codex"\n' \
  "$agent" "$bin" "$bin" > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$pipeline_config"
model_arg=
[ "$model" = default ] || model_arg="--model $model"
case "$agent" in
  codex)
    cat > "$bin/codex" <<EOF
#!/bin/sh
export CODEX_HOME="$home/codex"
exec "$HOME/.local/bin/codex" $model_arg "\$@"
EOF
    ;;
  claude)
    cat > "$bin/claude" <<EOF
#!/bin/sh
export CLAUDE_CONFIG_DIR="$home/claude"
export DISABLE_AUTOUPDATER=1
exec "$HOME/.local/bin/claude" $model_arg "\$@"
EOF
    ;;
esac
chmod 700 "$bin/$agent"
runtime_tmp="$home/config/ade-runtime.json.ade.$$"
/usr/bin/node - "$runtime_tmp" "$agent" "$model" "$home" <<'NODE'
const fs = require('node:fs')
const [path, agent, model, home] = process.argv.slice(2)
fs.writeFileSync(path, JSON.stringify({
  version: 1,
  host: { kind: 'ade-app', supervisor: 'app-native', terminalTarget: false },
  validator: { agent, model, nmHome: home + '/no-mistakes', agentHome: home + '/' + agent }
}, null, 2) + '\\n', { mode: 0o600 })
NODE
mv "$runtime_tmp" "$home/config/ade-runtime.json"
if command -v tmux >/dev/null 2>&1 && tmux list-sessions >/dev/null 2>&1; then
  tmux set-environment -g FM_HOME "$home"
  tmux set-environment -g NM_HOME "$home/no-mistakes"
  tmux set-environment -g CODEX_HOME "$home/codex"
  tmux set-environment -g CLAUDE_CONFIG_DIR "$home/claude"
  tmux set-environment -g FM_SUPERVISOR_BACKEND ade
  tmux set-environment -g FM_SUPERVISOR_TARGET ade-firstmate-acp
  tmux set-environment -g ADE_FIRSTMATE_RUNTIME_CONFIG "$home/config/ade-runtime.json"
  tmux set-environment -g ADE_FIRSTMATE_VALIDATOR_AGENT "$agent"
  tmux set-environment -g ADE_FIRSTMATE_VALIDATOR_MODEL "$model"
fi
trap - EXIT HUP INT TERM
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
mkdir -p "$HOME/.local/bin" "$base" "$base/home/bin" "$base/home/codex" "$base/home/claude" \
  "$base/home/data" "$base/home/state/acp-logs" "$base/home/config" "$base/home/projects" \
  "$base/home/no-mistakes" "$base/runner"
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
  @openai/codex@${CODEX_CLI_VERSION} \
  @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION} \
  @agentclientprotocol/codex-acp@${CODEX_ACP_VERSION} \
  @agentclientprotocol/claude-agent-acp@${CLAUDE_ACP_VERSION}
ln -sfn "$base/runner/node_modules/.bin/codex" "$HOME/.local/bin/codex"
ln -sfn "$base/runner/node_modules/.bin/claude" "$HOME/.local/bin/claude"
cat > "$base/home/bin/codex" <<EOF
#!/bin/sh
export CODEX_HOME="$base/home/codex"
exec "$HOME/.local/bin/codex" "\$@"
EOF
cat > "$base/home/bin/claude" <<EOF
#!/bin/sh
export CLAUDE_CONFIG_DIR="$base/home/claude"
export DISABLE_AUTOUPDATER=1
exec "$HOME/.local/bin/claude" "\$@"
EOF
chmod 700 "$base/home/bin/codex" "$base/home/bin/claude"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
export NPM_CONFIG_PREFIX="$HOME/.local"
export NM_HOME="$base/home/no-mistakes"
FM_HOME="$base/home" FM_BACKEND=tmux "$distro/bin/fm-bootstrap.sh" install \
  treehouse no-mistakes gh-axi chrome-devtools-axi lavish-axi tasks-axi quota-axi
no-mistakes daemon restart
`

export interface FirstMateLaunch {
  cwd: string
  environment: NodeJS.ProcessEnv
  agentProcess?: AgentProcessLaunch
  authProcess?(args: string[]): AgentProcessLaunch
  prepare?(): Promise<void>
}

export interface FirstMateRuntime {
  status(): Promise<FirstMateRuntimeStatus>
  install(): Promise<FirstMateInstallResult>
  authenticateGitHub(): Promise<FirstMateActionResult>
  trustCodexProject(): Promise<FirstMateActionResult>
  lifecycle(): Promise<FirstMateLifecycleStatus>
  configureValidator(provider: AgentProvider, modelId?: string): Promise<FirstMateActionResult>
  continueValidation(taskId: string): Promise<FirstMateActionResult>
  recordLifecycle(taskId: string, record: FirstMateLifecycleRecord): Promise<void>
  launch(provider?: AgentProvider, modelId?: string): FirstMateLaunch | null
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
  environment?: NodeJS.ProcessEnv
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

function validatorModel(modelId?: string): string {
  return modelId && /^[a-zA-Z0-9._:+\/-]+$/.test(modelId) ? modelId : 'default'
}

function taskHarness(files: FirstMateLifecycleFiles, taskId: string): string | undefined {
  const meta = files.tasks.find((task) => task.id === taskId)?.meta
  if (!meta) return undefined
  for (const line of meta.split(/\r?\n/)) {
    if (line.startsWith('harness=')) return line.slice('harness='.length)
  }
  return undefined
}

function appHostedEnvironment(
  environment: NodeJS.ProcessEnv,
  homePath: string,
  provider: AgentProvider,
  model: string
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    ...environment,
    FM_HOME: homePath,
    FM_BACKEND: 'tmux',
    NM_HOME: `${homePath}/no-mistakes`,
    CODEX_HOME: `${homePath}/codex`,
    CLAUDE_CONFIG_DIR: `${homePath}/claude`,
    FM_SUPERVISOR_BACKEND: 'ade',
    FM_SUPERVISOR_TARGET: 'ade-firstmate-acp',
    ADE_FIRSTMATE_RUNTIME_CONFIG: `${homePath}/config/ade-runtime.json`,
    ADE_FIRSTMATE_VALIDATOR_AGENT: provider,
    ADE_FIRSTMATE_VALIDATOR_MODEL: model
  }
  delete result.TMUX
  delete result.TMUX_PANE
  delete result.HERDR_ENV
  delete result.HERDR_PANE_ID
  delete result.HERDR_SESSION
  return result
}

function runtimeConfig(provider: AgentProvider, model: string, homePath: string): string {
  return `${JSON.stringify({
    version: 1,
    host: { kind: 'ade-app', supervisor: 'app-native', terminalTarget: false },
    validator: {
      agent: provider,
      model,
      nmHome: join(homePath, 'no-mistakes'),
      agentHome: join(homePath, provider)
    }
  }, null, 2)}\n`
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
  let readyLaunchFactory: ((agent: AgentProvider, model: string) => Record<AgentProvider, FirstMateLaunch>) | null = null
  let readyPaths: ReturnType<typeof linuxPaths> | null = null
  let selectedValidator: { agent: AgentProvider; model: string } = { agent: 'codex', model: 'default' }

  const inspect = async (): Promise<FirstMateRuntimeStatus> => {
    if (installing) {
      return {
        state: 'installing',
        distroPath: placeholder.distroPath,
        homePath: placeholder.homePath,
        host: 'wsl',
        backend: 'tmux',
        supervision: 'app-native',
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
        readyLaunchFactory = null
        readyPaths = null
        return {
          state: lastError ? 'error' : 'missing',
          distroPath: paths.distroPath,
          homePath: paths.homePath,
          host: 'wsl',
          backend: 'tmux',
          supervision: 'app-native',
          distribution,
          message: lastError ?? `ADE will provision FirstMate, native Claude and Codex agents, tmux, and the managed review toolchain in ${distribution}.`
        }
      }
      const managedLaunch = (
        runnerPath: string,
        hostAuth: string,
        managedAuth: string,
        pipelineAgent: AgentProvider,
        pipelineModel: string,
        environment: string[],
        adapterArgs: string[] = []
      ): AgentProcessLaunch => {
        const commonEnvironment = [
          `FM_HOME=${paths.homePath}`,
          'FM_BACKEND=tmux',
          `NM_HOME=${paths.homePath}/no-mistakes`,
          `CODEX_HOME=${paths.homePath}/codex`,
          `CLAUDE_CONFIG_DIR=${paths.homePath}/claude`,
          'FM_SUPERVISOR_BACKEND=ade',
          'FM_SUPERVISOR_TARGET=ade-firstmate-acp',
          `ADE_FIRSTMATE_RUNTIME_CONFIG=${paths.homePath}/config/ade-runtime.json`,
          `ADE_FIRSTMATE_VALIDATOR_AGENT=${pipelineAgent}`,
          `ADE_FIRSTMATE_VALIDATOR_MODEL=${pipelineModel}`,
          `PATH=${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`
        ]
        return {
          executable,
          args: [
            '--distribution', distribution,
            '--cd', paths.distroPath,
            '--exec', '/bin/sh', '-lc', WSL_AGENT_SCRIPT, 'ade-firstmate-agent',
            hostAuth,
            managedAuth,
            pipelineAgent,
            `${paths.homePath}/no-mistakes/config.yaml`,
            `${paths.homePath}/bin`,
            pipelineModel,
            `${paths.homePath}/config/ade-runtime.json`,
            paths.homePath,
            ...commonEnvironment,
            ...environment,
            '/usr/bin/node', runnerPath,
            ...adapterArgs
          ],
          options: { env: process.env, windowsHide: true }
        }
      }
      const launchFor = (
        pipelineAgent: AgentProvider,
        pipelineModel: string
      ): Record<AgentProvider, FirstMateLaunch> => {
        const codexLaunch: FirstMateLaunch = {
          cwd: paths.distroPath,
          environment: process.env,
          agentProcess: managedLaunch(
            paths.runnerPaths.codex,
            sharedCodexHome ? `${sharedCodexHome}/auth.json` : '',
            `${managedCodexHome}/auth.json`,
            pipelineAgent,
            pipelineModel,
            [
              `CODEX_HOME=${managedCodexHome}`,
              `APP_SERVER_LOGS=${paths.homePath}/state/acp-logs`
            ]
          ),
          authProcess: (args) => managedLaunch(
            paths.runnerPaths.codex,
            sharedCodexHome ? `${sharedCodexHome}/auth.json` : '',
            `${managedCodexHome}/auth.json`,
            pipelineAgent,
            pipelineModel,
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
            pipelineAgent,
            pipelineModel,
            [`CLAUDE_CONFIG_DIR=${managedClaudeHome}`]
          ),
          authProcess: (args) => managedLaunch(
            paths.runnerPaths.claude,
            sharedClaudeHome ? `${sharedClaudeHome}/.credentials.json` : '',
            `${managedClaudeHome}/.credentials.json`,
            pipelineAgent,
            pipelineModel,
            [`CLAUDE_CONFIG_DIR=${managedClaudeHome}`],
            args
          )
        }
        return { codex: codexLaunch, claude: claudeLaunch }
      }
      readyLaunches = launchFor(selectedValidator.agent, selectedValidator.model)
      readyLaunchFactory = launchFor
      readyPaths = paths
      lastError = undefined
      return {
        state: 'ready',
        distroPath: paths.distroPath,
        homePath: paths.homePath,
        host: 'wsl',
        backend: 'tmux',
        supervision: 'app-native',
        distribution,
        githubAuth: detected.get('githubAuth') === 'authenticated' ? 'authenticated' : 'required',
        codexProjectTrust: detected.get('codexTrust') === 'trusted' ? 'trusted' : 'required'
      }
    } catch (error) {
      readyLaunches = null
      readyLaunchFactory = null
      readyPaths = null
      const message = error instanceof Error ? error.message : String(error)
      return {
        state: 'error',
        distroPath: placeholder.distroPath,
        homePath: placeholder.homePath,
        host: 'wsl',
        backend: 'tmux',
        supervision: 'app-native',
        distribution,
        message: lastError ?? `Ubuntu WSL is unavailable: ${message}`
      }
    }
  }

  const lifecycleFiles = async (): Promise<FirstMateLifecycleFiles> => {
    if (!readyPaths) await inspect()
    if (!readyPaths) return { tasks: [] }
    const result = await run(
      [
        '--distribution', distribution,
        '--exec', '/usr/bin/node', '-e', WSL_LIFECYCLE_READ_SCRIPT, readyPaths.homePath
      ],
      15_000
    )
    const parsed = JSON.parse(result.stdout) as FirstMateLifecycleFiles
    return Array.isArray(parsed.tasks) ? parsed : { tasks: [] }
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
    async lifecycle(): Promise<FirstMateLifecycleStatus> {
      try {
        const lifecycle = firstMateLifecycleFromFiles(await lifecycleFiles())
        if (lifecycle.validator) {
          selectedValidator = {
            agent: lifecycle.validator.agent,
            model: lifecycle.validator.model
          }
        }
        return lifecycle
      } catch (error) {
        return {
          supervision: 'app-native',
          message: `ADE could not read durable FirstMate events: ${error instanceof Error ? error.message : String(error)}`,
          tasks: []
        }
      }
    },
    async configureValidator(provider: AgentProvider, modelId?: string): Promise<FirstMateActionResult> {
      if (!readyPaths) await inspect()
      if (!readyPaths) return { ok: false, message: 'FirstMate is not ready.' }
      selectedValidator = { agent: provider, model: validatorModel(modelId) }
      try {
        await run(
          [
            '--distribution', distribution,
            '--exec', '/bin/sh', '-c', WSL_VALIDATOR_CONFIGURE_SCRIPT,
            'ade-firstmate-validator',
            readyPaths.homePath,
            selectedValidator.agent,
            selectedValidator.model
          ],
          15_000
        )
        if (readyLaunchFactory) {
          readyLaunches = readyLaunchFactory(selectedValidator.agent, selectedValidator.model)
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
    async continueValidation(taskId: string): Promise<FirstMateActionResult> {
      if (!/^[a-zA-Z0-9._-]+$/.test(taskId)) return { ok: false, message: 'Invalid FirstMate task id.' }
      try {
        const files = await lifecycleFiles()
        const harness = taskHarness(files, taskId)
        if (!harness || !readyPaths) return { ok: false, message: 'The task endpoint metadata is unavailable.' }
        const configuredValidator = firstMateValidatorFromRuntimeConfig(files.runtimeConfig) ?? selectedValidator
        selectedValidator = {
          agent: configuredValidator.agent,
          model: configuredValidator.model
        }
        await run(
          [
            '--distribution', distribution,
            '--cd', readyPaths.distroPath,
            '--exec', '/usr/bin/env',
            `FM_HOME=${readyPaths.homePath}`,
            `NM_HOME=${readyPaths.homePath}/no-mistakes`,
            `CODEX_HOME=${readyPaths.homePath}/codex`,
            `CLAUDE_CONFIG_DIR=${readyPaths.homePath}/claude`,
            `ADE_FIRSTMATE_RUNTIME_CONFIG=${readyPaths.homePath}/config/ade-runtime.json`,
            `ADE_FIRSTMATE_VALIDATOR_AGENT=${selectedValidator.agent}`,
            `ADE_FIRSTMATE_VALIDATOR_MODEL=${selectedValidator.model}`,
            `${readyPaths.distroPath}/bin/fm-send.sh`,
            taskId,
            noMistakesContinuation(harness, `${readyPaths.homePath}/config/ade-runtime.json`)
          ],
          30_000
        )
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
    async recordLifecycle(taskId: string, record: FirstMateLifecycleRecord): Promise<void> {
      if (!/^[a-zA-Z0-9._-]+$/.test(taskId)) throw new Error('Invalid FirstMate task id.')
      if (!readyPaths) await inspect()
      if (!readyPaths) throw new Error('FirstMate is not ready.')
      await run(
        [
          '--distribution', distribution,
          '--exec', '/usr/bin/node', '-e', WSL_LIFECYCLE_RECORD_SCRIPT,
          readyPaths.homePath,
          taskId,
          Buffer.from(JSON.stringify(record)).toString('base64url')
        ],
        15_000
      )
    },
    launch(provider = 'codex', modelId?: string): FirstMateLaunch | null {
      selectedValidator = { agent: provider, model: validatorModel(modelId) }
      if (readyLaunchFactory) readyLaunches = readyLaunchFactory(provider, selectedValidator.model)
      return readyLaunches?.[provider] ?? null
    }
  }
}

function createNativeFirstMateRuntime(options: FirstMateRuntimeOptions): FirstMateRuntime {
  const distroPath = join(options.rootPath, 'distro')
  const homePath = join(options.rootPath, 'home')
  let installing = false
  let lastError: string | undefined
  let selectedValidator: { agent: AgentProvider; model: string } = { agent: 'codex', model: 'default' }
  const environment = options.environment ?? process.env

  const status = (): FirstMateRuntimeStatus => {
    const common = {
      distroPath,
      homePath,
      host: 'native' as const,
      backend: 'tmux' as const,
      supervision: 'app-native' as const
    }
    if (installing) return { state: 'installing', ...common }
    if (isDistro(distroPath)) return { state: 'ready', ...common }
    if (lastError) return { state: 'error', ...common, message: lastError }
    return { state: 'missing', ...common }
  }

  const prepareHome = (): void => {
    for (const directory of ['bin', 'data', 'state', 'config', 'projects', 'no-mistakes', 'codex', 'claude']) {
      mkdirSync(join(homePath, directory), { recursive: true })
    }
  }

  const atomicWrite = (path: string, contents: string, mode: number): void => {
    const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
    writeFileSync(temporary, contents, { mode })
    renameSync(temporary, path)
  }

  const persistValidatorConfiguration = (provider: AgentProvider, model: string): void => {
    atomicWrite(
      join(homePath, 'config', 'ade-runtime.json'),
      runtimeConfig(provider, model, homePath),
      0o600
    )
    const binPath = join(homePath, 'bin')
    atomicWrite(
      join(homePath, 'no-mistakes', 'config.yaml'),
      `agent: ${provider}\nagent_path_override:\n  claude: ${JSON.stringify(join(binPath, 'claude'))}\n  codex: ${JSON.stringify(join(binPath, 'codex'))}\n`,
      0o600
    )
    const modelArgument = model === 'default' ? '' : ` --model ${model}`
    const providerHome = provider === 'codex'
      ? `export CODEX_HOME=${JSON.stringify(join(homePath, 'codex'))}`
      : `export CLAUDE_CONFIG_DIR=${JSON.stringify(join(homePath, 'claude'))}\nexport DISABLE_AUTOUPDATER=1`
    atomicWrite(
      join(binPath, provider),
      `#!/bin/sh\n${providerHome}\nexec ${provider}${modelArgument} "$@"\n`,
      0o700
    )
  }

  const configureTmuxEnvironment = async (provider: AgentProvider, model: string): Promise<void> => {
    const variables = [
      ['FM_HOME', homePath],
      ['NM_HOME', join(homePath, 'no-mistakes')],
      ['CODEX_HOME', join(homePath, 'codex')],
      ['CLAUDE_CONFIG_DIR', join(homePath, 'claude')],
      ['FM_SUPERVISOR_BACKEND', 'ade'],
      ['FM_SUPERVISOR_TARGET', 'ade-firstmate-acp'],
      ['ADE_FIRSTMATE_RUNTIME_CONFIG', join(homePath, 'config', 'ade-runtime.json')],
      ['ADE_FIRSTMATE_VALIDATOR_AGENT', provider],
      ['ADE_FIRSTMATE_VALIDATOR_MODEL', model]
    ]
    await Promise.all(variables.map(async ([name, value]) => {
      try {
        await execFileAsync('tmux', ['set-environment', '-g', name, value], { timeout: 2_000 })
      } catch {
        // No existing server is fine; a server created by this ACP process inherits environment.
      }
    }))
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
    async lifecycle(): Promise<FirstMateLifecycleStatus> {
      return readFirstMateLifecycle(homePath)
    },
    async configureValidator(provider: AgentProvider, modelId?: string): Promise<FirstMateActionResult> {
      prepareHome()
      selectedValidator = { agent: provider, model: validatorModel(modelId) }
      persistValidatorConfiguration(provider, selectedValidator.model)
      await configureTmuxEnvironment(provider, selectedValidator.model)
      return { ok: true }
    },
    async continueValidation(taskId: string): Promise<FirstMateActionResult> {
      if (!/^[a-zA-Z0-9._-]+$/.test(taskId)) return { ok: false, message: 'Invalid FirstMate task id.' }
      try {
        const files = await readFirstMateLifecycleFiles(homePath)
        const harness = taskHarness(files, taskId)
        if (!harness) return { ok: false, message: 'The task endpoint metadata is unavailable.' }
        const configuredValidator = firstMateValidatorFromRuntimeConfig(files.runtimeConfig) ?? selectedValidator
        selectedValidator = {
          agent: configuredValidator.agent,
          model: configuredValidator.model
        }
        await execFileAsync(join(distroPath, 'bin', 'fm-send.sh'), [
          taskId,
          noMistakesContinuation(harness, join(homePath, 'config', 'ade-runtime.json'))
        ], {
          cwd: distroPath,
          env: appHostedEnvironment(environment, homePath, selectedValidator.agent, selectedValidator.model),
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
    async recordLifecycle(taskId: string, record: FirstMateLifecycleRecord): Promise<void> {
      if (!/^[a-zA-Z0-9._-]+$/.test(taskId)) throw new Error('Invalid FirstMate task id.')
      await recordFirstMateLifecycle(homePath, taskId, record)
    },
    launch(provider: AgentProvider = 'codex', modelId?: string): FirstMateLaunch | null {
      if (!isDistro(distroPath)) return null
      prepareHome()
      selectedValidator = { agent: provider, model: validatorModel(modelId) }
      const model = selectedValidator.model
      persistValidatorConfiguration(provider, model)
      const launchEnvironment = appHostedEnvironment(environment, homePath, provider, selectedValidator.model)
      return {
        cwd: distroPath,
        environment: launchEnvironment,
        async prepare(): Promise<void> {
          await configureTmuxEnvironment(provider, model)
        }
      }
    }
  }
}

export function createFirstMateRuntime(options: FirstMateRuntimeOptions): FirstMateRuntime {
  return options.platform === 'win32'
    ? createWslFirstMateRuntime(options)
    : createNativeFirstMateRuntime(options)
}
