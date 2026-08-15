import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { AgentProvider } from '../shared/agent'
import type {
  FirstMateActionResult,
  FirstMateExternalProject,
  FirstMateInstallResult,
  FirstMateLifecycleStatus,
  FirstMateProjectRegistration,
  FirstMateProjectSelection,
  FirstMateRuntimeStatus
} from '../shared/firstmate'
import type { AgentProcessLaunch } from './agent-process'
import { firstMateTaskContextFromMetadata, type FirstMateTaskContext } from '../shared/firstmate-task-context'
import {
  createFirstMateExternalProjects,
  EXTERNAL_PROJECT_STORE_FILE,
  FLEET_REGISTRY_FILE,
  type FirstMateCheckoutFacts,
  type FirstMateExternalProjectFiles,
  type FirstMateExternalProjectHome,
  type FirstMateWslPathFacts
} from './firstmate-external-projects'
import {
  FIRSTMATE_LIFECYCLE_JOURNAL_FILE,
  firstMateLifecycleFromFiles,
  noMistakesContinuation,
  type FirstMateLifecycleFiles,
  type FirstMateLifecycleRecord
} from './firstmate-lifecycle'
import {
  FIRSTMATE_RUNTIME_HOST,
  FIRSTMATE_RUNTIME_RECORD_VERSION,
  serializeFirstMateRuntimeRecord,
  type FirstMateRuntimeRecord
} from '../shared/firstmate-runtime-record'
import {
  ADE_FIRSTMATE_RUNTIME_CONFIG,
  ADE_FIRSTMATE_VALIDATOR_AGENT,
  ADE_FIRSTMATE_VALIDATOR_MODEL,
  CLAUDE_CONFIG_DIR,
  CODEX_HOME,
  FM_BACKEND,
  FM_HOME,
  FM_SUPERVISOR_BACKEND,
  FM_SUPERVISOR_TARGET,
  NM_HOME,
  firstMateProcessEnvironment
} from './firstmate-environment'
import { firstMateWslPathFromWindows } from './firstmate-paths'
import { errorMessage } from '../shared/text'

const execFileAsync = promisify(execFile)
const FIRSTMATE_REPOSITORY = 'https://github.com/kunchenguid/firstmate.git'
const CODEX_ACP_VERSION = '1.1.14'
const CODEX_CLI_VERSION = '0.147.0'
const CLAUDE_ACP_VERSION = '0.66.0'
const CLAUDE_CLI_VERSION = '2.1.232'
const WSL_BASE = '.local/share/ade/firstmate'
const WSL_REQUIRED_FACTS = [
  'distro',
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
  'tool.quota-axi',
  'daemon.no-mistakes'
]
const WSL_PROVIDER_FACTS: Record<AgentProvider, string[]> = {
  codex: ['runner.codex', 'tool.codex', 'wrapper.codex'],
  claude: ['runner.claude', 'tool.claude', 'wrapper.claude']
}
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
const WSL_DECODE_WRITE_NODE = 'const fs=require("node:fs");'
  + 'fs.writeFileSync(process.argv[1],Buffer.from(process.argv[2],"base64url").toString("utf8"),{mode:0o600})'

const WSL_AGENT_SCRIPT = `
set -eu
umask 077
host_auth="$1"
managed_auth="$2"
pipeline_agent="$3"
pipeline_model="$4"
runtime_config="$5"
runtime_home="$6"
runtime_record="$7"
shift 7
mkdir -p "$(dirname "$managed_auth")"
if [ -f "$host_auth" ] && { [ ! -f "$managed_auth" ] || [ "$host_auth" -nt "$managed_auth" ]; }; then
  cp "$host_auth" "$managed_auth"
  chmod 600 "$managed_auth"
fi
runtime_config_tmp="$runtime_config.ade.$$"
/usr/bin/node -e '${WSL_DECODE_WRITE_NODE}' "$runtime_config_tmp" "$runtime_record"
mv "$runtime_config_tmp" "$runtime_config"
if command -v tmux >/dev/null 2>&1 && tmux list-sessions >/dev/null 2>&1; then
  tmux set-environment -g ${FM_HOME} "$runtime_home"
  tmux set-environment -g ${NM_HOME} "$runtime_home/no-mistakes"
  tmux set-environment -g ${CODEX_HOME} "$runtime_home/codex"
  tmux set-environment -g ${CLAUDE_CONFIG_DIR} "$runtime_home/claude"
  tmux set-environment -g ${FM_SUPERVISOR_BACKEND} ade
  tmux set-environment -g ${FM_SUPERVISOR_TARGET} ade-firstmate-acp
  tmux set-environment -g ${ADE_FIRSTMATE_RUNTIME_CONFIG} "$runtime_config"
  tmux set-environment -g ${ADE_FIRSTMATE_VALIDATOR_AGENT} "$pipeline_agent"
  tmux set-environment -g ${ADE_FIRSTMATE_VALIDATOR_MODEL} "$pipeline_model"
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
  journal: optional(path.join(state, ${JSON.stringify(FIRSTMATE_LIFECYCLE_JOURNAL_FILE)})),
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
const target = path.join(state, ${JSON.stringify(FIRSTMATE_LIFECYCLE_JOURNAL_FILE)})
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

const WSL_ATOMIC_WRITE_SCRIPT = `
const fs = require('node:fs')
const path = require('node:path')
const target = process.argv[1]
const text = Buffer.from(process.argv[2], 'base64url').toString('utf8')
fs.mkdirSync(path.dirname(target), { recursive: true })
const temporary = target + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp'
fs.writeFileSync(temporary, text, { mode: 0o600 })
fs.renameSync(temporary, target)
`

const WSL_EXTERNAL_PROJECT_READ_SCRIPT = `
const fs = require('node:fs')
const path = require('node:path')
const data = path.join(process.argv[1], 'data')
const optional = (file) => { try { return fs.readFileSync(file, 'utf8') } catch { return undefined } }
process.stdout.write(JSON.stringify({
  store: optional(path.join(data, ${JSON.stringify(EXTERNAL_PROJECT_STORE_FILE)})),
  registry: optional(path.join(data, ${JSON.stringify(FLEET_REGISTRY_FILE)}))
}))
`

const WSL_PROJECT_ACCESS_SCRIPT = `
const fs = require('node:fs')
const project = process.argv[1]
try {
  const stat = fs.statSync(project)
  if (!stat.isDirectory()) throw new Error('the path is not a directory')
  fs.accessSync(project, fs.constants.R_OK | fs.constants.X_OK)
  process.stdout.write(JSON.stringify({ accessible: true }))
} catch (error) {
  process.stdout.write(JSON.stringify({
    accessible: false,
    message: error instanceof Error ? error.message : String(error)
  }))
}
`

const WSL_EXTERNAL_PROJECT_WRITE_SCRIPT = `
const fs = require('node:fs')
const path = require('node:path')
const data = path.join(process.argv[1], 'data')
const text = Buffer.from(process.argv[2], 'base64url').toString('utf8')
fs.mkdirSync(data, { recursive: true })
const target = path.join(data, ${JSON.stringify(EXTERNAL_PROJECT_STORE_FILE)})
const temporary = target + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp'
fs.writeFileSync(temporary, text, { mode: 0o600 })
fs.renameSync(temporary, target)
`

const WSL_VALIDATOR_CONFIGURE_SCRIPT = `
set -eu
home="$1"
agent="$2"
model="$3"
runtime_record="$4"
mkdir -p "$home/config"
trap 'rm -f "$home/config/ade-runtime.json.ade.$$"' EXIT HUP INT TERM
runtime_tmp="$home/config/ade-runtime.json.ade.$$"
/usr/bin/node -e '${WSL_DECODE_WRITE_NODE}' "$runtime_tmp" "$runtime_record"
mv "$runtime_tmp" "$home/config/ade-runtime.json"
if command -v tmux >/dev/null 2>&1 && tmux list-sessions >/dev/null 2>&1; then
  tmux set-environment -g ${FM_HOME} "$home"
  tmux set-environment -g ${NM_HOME} "$home/no-mistakes"
  tmux set-environment -g ${CODEX_HOME} "$home/codex"
  tmux set-environment -g ${CLAUDE_CONFIG_DIR} "$home/claude"
  tmux set-environment -g ${FM_SUPERVISOR_BACKEND} ade
  tmux set-environment -g ${FM_SUPERVISOR_TARGET} ade-firstmate-acp
  tmux set-environment -g ${ADE_FIRSTMATE_RUNTIME_CONFIG} "$home/config/ade-runtime.json"
  tmux set-environment -g ${ADE_FIRSTMATE_VALIDATOR_AGENT} "$agent"
  tmux set-environment -g ${ADE_FIRSTMATE_VALIDATOR_MODEL} "$model"
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
}

export interface FirstMateRuntime {
  status(): Promise<FirstMateRuntimeStatus>
  install(): Promise<FirstMateInstallResult>
  authenticateGitHub(): Promise<FirstMateActionResult>
  trustCodexProject(): Promise<FirstMateActionResult>
  lifecycle(): Promise<FirstMateLifecycleStatus>
  configureValidator(provider: AgentProvider, modelId?: string): Promise<FirstMateActionResult>
  continueValidation(taskId: string, dispatchId: string): Promise<FirstMateActionResult>
  recordLifecycle(taskId: string, record: FirstMateLifecycleRecord): Promise<void>
  /** Registers one ADE checkout as a durable external project; never modifies that checkout. */
  registerProject(selection: FirstMateProjectSelection): Promise<FirstMateProjectRegistration>
  recordedProject(adeProjectId: string): Promise<FirstMateExternalProject | null>
  authorizeProjectInitialization(adeProjectId: string): Promise<FirstMateProjectRegistration>
  retireProject(adeProjectId: string): Promise<FirstMateActionResult>
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
  platform: NodeJS.Platform
  /** Windows Codex home shared by ADE's regular Codex nodes. */
  codexHome?: string
  /** Windows Claude home shared by ADE's regular Claude nodes. */
  claudeHome?: string
  resolveGit(): string | null
  /** Reads a selected checkout without changing it; defaults to Git's own read-only origin lookup. */
  inspectCheckout?(windowsPath: string): Promise<FirstMateCheckoutFacts>
  wsl?: FirstMateWslOptions
}

/**
 * Everything ADE learns about a selected project comes from reads: whether the directory is there and
 * what Git already records as its origin. Nothing here writes to, refreshes, or resets the checkout.
 */
async function inspectWindowsCheckout(git: string | null, windowsPath: string): Promise<FirstMateCheckoutFacts> {
  if (!existsSync(windowsPath)) return { status: 'missing' }
  if (!git) {
    return {
      status: 'git-unavailable',
      message: 'ADE cannot validate this checkout because Git is unavailable on Windows.'
    }
  }
  try {
    const checkout = await execFileAsync(git, ['-C', windowsPath, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true
    })
    if (String(checkout.stdout).trim() !== 'true') return { status: 'not-git' }
  } catch {
    return { status: 'not-git' }
  }
  try {
    const result = await execFileAsync(git, ['-C', windowsPath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true
    })
    const origin = String(result.stdout).trim()
    return origin ? { status: 'git-checkout', origin } : { status: 'git-checkout' }
  } catch {
    // A usable checkout without an origin is explicitly local-only.
    return { status: 'git-checkout' }
  }
}

/**
 * The external-project half of the WSL runtime, kept separate from provisioning and dispatch: it
 * reports an unreachable home as a failed action rather than a thrown request.
 */
function createExternalProjectRuntime(
  options: FirstMateRuntimeOptions,
  home: FirstMateExternalProjectHome,
  inspectWslPath: (wslPath: string) => Promise<FirstMateWslPathFacts>
): Pick<FirstMateRuntime, 'registerProject' | 'recordedProject' | 'authorizeProjectInitialization' | 'retireProject'> {
  const projects = createFirstMateExternalProjects({
    home,
    inspectCheckout: options.inspectCheckout
      ?? ((windowsPath) => inspectWindowsCheckout(options.resolveGit(), windowsPath)),
    inspectWslPath
  })
  return {
    async registerProject(selection: FirstMateProjectSelection): Promise<FirstMateProjectRegistration> {
      try {
        return await projects.register(selection)
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
      }
    },
    async recordedProject(adeProjectId: string): Promise<FirstMateExternalProject | null> {
      try {
        return await projects.recorded(adeProjectId)
      } catch {
        return null
      }
    },
    async authorizeProjectInitialization(adeProjectId: string): Promise<FirstMateProjectRegistration> {
      try {
        return await projects.authorizeInitialization(adeProjectId)
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
      }
    },
    async retireProject(adeProjectId: string): Promise<FirstMateActionResult> {
      try {
        return await projects.retire(adeProjectId)
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
      }
    }
  }
}

function linuxPaths(home: string): {
  userHome: string
  distroPath: string
  homePath: string
  runnerPaths: Record<AgentProvider, string>
} {
  const base = `${home}/${WSL_BASE}`
  return {
    userHome: home,
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

function validatorModel(modelId?: string): string {
  return modelId && /^[a-zA-Z0-9._:+\/-]+$/.test(modelId) ? modelId : 'default'
}

interface FirstMateTaskEndpoint {
  harness: string
  worktree: string
  context: FirstMateTaskContext
}

function taskEndpoint(files: FirstMateLifecycleFiles, taskId: string): FirstMateTaskEndpoint | undefined {
  const meta = files.tasks.find((task) => task.id === taskId)?.meta
  if (!meta) return undefined
  const context = firstMateTaskContextFromMetadata(meta)
  if (!context) return undefined
  let harness: string | undefined
  let worktree: string | undefined
  for (const line of meta.split(/\r?\n/)) {
    if (line.startsWith('harness=')) harness = line.slice('harness='.length)
    if (line.startsWith('worktree=')) worktree = line.slice('worktree='.length)
  }
  return harness && worktree ? { harness, worktree, context } : undefined
}

const SAFE_ARGUMENT = /^[a-zA-Z0-9._-]+$/

/** Both ids reach the worker as command arguments, so neither may carry anything else. */
function dispatchTargetError(taskId: string, dispatchId: string): FirstMateActionResult | undefined {
  if (!SAFE_ARGUMENT.test(taskId)) return { ok: false, message: 'Invalid FirstMate task id.' }
  if (!SAFE_ARGUMENT.test(dispatchId)) {
    return { ok: false, message: 'Invalid FirstMate validation dispatch id.' }
  }
  return undefined
}

/** The global runtime record ADE serializes for a launch or a validator change to write in WSL. */
function globalRuntimeRecord(homePath: string, agent: AgentProvider, model: string): FirstMateRuntimeRecord {
  return {
    version: FIRSTMATE_RUNTIME_RECORD_VERSION,
    host: FIRSTMATE_RUNTIME_HOST,
    validator: {
      agent,
      model,
      nmHome: `${homePath}/no-mistakes`,
      agentHome: `${homePath}/${agent}`
    }
  }
}

/** The global record as one base64url argument, so an inline WSL program only decodes and writes it. */
function globalRuntimeRecordArg(homePath: string, agent: AgentProvider, model: string): string {
  return Buffer.from(serializeFirstMateRuntimeRecord(globalRuntimeRecord(homePath, agent, model))).toString('base64url')
}

function taskRuntimeConfig(
  context: FirstMateTaskContext,
  worktree: string,
  nmHome: string,
  agentHome: string,
  agentPath: string
): string {
  return serializeFirstMateRuntimeRecord({
    version: FIRSTMATE_RUNTIME_RECORD_VERSION,
    host: FIRSTMATE_RUNTIME_HOST,
    project: { ...context.project, worktree },
    validator: {
      agent: context.validator.agent,
      model: context.validator.model,
      nmHome,
      agentHome,
      agentPath
    }
  })
}

interface TaskValidationDispatch {
  endpoint: FirstMateTaskEndpoint
  taskConfigPath: string
  taskConfig: string
  agentPath: string
  pipelineConfig: string
  wrapper: string
  continuation: string
}

function taskValidationDispatch(
  files: FirstMateLifecycleFiles,
  taskId: string,
  dispatchId: string,
  taskConfigPath: string,
  homePath: string
): TaskValidationDispatch | undefined {
  const endpoint = taskEndpoint(files, taskId)
  if (!endpoint) return undefined
  const { agent, model } = endpoint.context.validator
  const validatorScopeHash = createHash('sha256')
    .update(`${taskId}\0${agent}\0${model}`)
    .digest('hex')
    .slice(0, 20)
  const agentPath = `${homePath}/state/validators/${validatorScopeHash}/${agent}`
  const agentHome = `${homePath}/${agent}`
  const modelArgument = model === 'default' ? '' : ` --model ${model}`
  const providerHome = agent === 'codex'
    ? `export CODEX_HOME=${JSON.stringify(agentHome)}`
    : `export CLAUDE_CONFIG_DIR=${JSON.stringify(agentHome)}\nexport DISABLE_AUTOUPDATER=1`
  return {
    endpoint,
    taskConfigPath,
    taskConfig: taskRuntimeConfig(
      endpoint.context,
      endpoint.worktree,
      `${homePath}/no-mistakes`,
      agentHome,
      agentPath
    ),
    agentPath,
    pipelineConfig: `agent: ${agent}\nagent_path_override:\n  ${agent}: ${JSON.stringify(agentPath)}\n`,
    wrapper: `#!/bin/sh\n${providerHome}\nexec ${JSON.stringify(`$HOME/.local/bin/${agent}`)}${modelArgument} "$@"\n`,
    continuation: noMistakesContinuation(endpoint.harness, taskConfigPath, dispatchId)
  }
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
  let readyProviders = new Set<AgentProvider>()
  let selectedValidator: { agent: AgentProvider; model: string } = { agent: 'codex', model: 'default' }

  /**
   * One inspection, reported as the status plus the host paths it resolved. Actions take both from
   * the same result rather than from the shared ready state, so a concurrent poll that fails between
   * an action's inspection and its use of the host can never turn that action into a false refusal.
   */
  const inspectHost = async (): Promise<{
    status: FirstMateRuntimeStatus
    paths: ReturnType<typeof linuxPaths> | null
  }> => {
    if (installing) {
      return {
        status: {
          state: 'installing',
          distroPath: placeholder.distroPath,
          homePath: placeholder.homePath,
          backend: 'tmux',
          supervision: 'app-native',
          distribution,
          message: `Provisioning FirstMate in ${distribution}. This can take several minutes.`
        },
        paths: null
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
      const sharedCodexHome = options.codexHome ? firstMateWslPathFromWindows(options.codexHome) : undefined
      const sharedClaudeHome = options.claudeHome ? firstMateWslPathFromWindows(options.claudeHome) : undefined
      const managedCodexHome = `${paths.homePath}/codex`
      const managedClaudeHome = `${paths.homePath}/claude`
      const missing = WSL_REQUIRED_FACTS.filter((name) => detected.get(name) !== '1')
      readyProviders = new Set(
        (['codex', 'claude'] as const).filter((provider) => (
          WSL_PROVIDER_FACTS[provider].every((name) => detected.get(name) === '1')
        ))
      )
      if (missing.length > 0 || readyProviders.size === 0) {
        readyLaunches = null
        readyLaunchFactory = null
        readyPaths = null
        readyProviders.clear()
        return {
          status: {
            state: lastError ? 'error' : 'missing',
            distroPath: paths.distroPath,
            homePath: paths.homePath,
            backend: 'tmux',
            supervision: 'app-native',
            distribution,
            message: lastError ?? `ADE will provision FirstMate, native Claude and Codex agents, tmux, and the managed review toolchain in ${distribution}.`
          },
          paths: null
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
        const runtimeConfigPath = `${paths.homePath}/config/ade-runtime.json`
        const commonEnvironment = [
          `${FM_BACKEND}=tmux`,
          ...firstMateProcessEnvironment({
            homePath: paths.homePath,
            runtimeConfigPath,
            validatorAgent: pipelineAgent,
            validatorModel: pipelineModel
          }),
          `PATH=${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`
        ]
        const runtimeRecord = globalRuntimeRecordArg(paths.homePath, pipelineAgent, pipelineModel)
        return {
          executable,
          args: [
            '--distribution', distribution,
            '--cd', paths.distroPath,
            '--exec', '/bin/sh', '-lc', WSL_AGENT_SCRIPT, 'ade-firstmate-agent',
            hostAuth,
            managedAuth,
            pipelineAgent,
            pipelineModel,
            runtimeConfigPath,
            paths.homePath,
            runtimeRecord,
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
        status: {
          state: 'ready',
          distroPath: paths.distroPath,
          homePath: paths.homePath,
          backend: 'tmux',
          supervision: 'app-native',
          distribution,
          githubAuth: detected.get('githubAuth') === 'authenticated' ? 'authenticated' : 'required',
          codexProjectTrust: detected.get('codexTrust') === 'trusted' ? 'trusted' : 'required'
        },
        paths
      }
    } catch (error) {
      readyLaunches = null
      readyLaunchFactory = null
      readyPaths = null
      readyProviders.clear()
      const message = errorMessage(error)
      return {
        status: {
          state: 'error',
          distroPath: placeholder.distroPath,
          homePath: placeholder.homePath,
          backend: 'tmux',
          supervision: 'app-native',
          distribution,
          message: lastError ?? `Ubuntu WSL is unavailable: ${message}`
        },
        paths: null
      }
    }
  }

  const inspect = async (): Promise<FirstMateRuntimeStatus> => (await inspectHost()).status

  const homePath = async (): Promise<string> => {
    if (!readyPaths) await inspect()
    if (!readyPaths) throw new Error('FirstMate is not ready.')
    return readyPaths.homePath
  }
  const externalProjects = createExternalProjectRuntime(
    options,
    {
      async read(): Promise<FirstMateExternalProjectFiles> {
        const result = await run(
          [
            '--distribution', distribution,
            '--exec', '/usr/bin/node', '-e', WSL_EXTERNAL_PROJECT_READ_SCRIPT, await homePath()
          ],
          15_000
        )
        return JSON.parse(result.stdout) as FirstMateExternalProjectFiles
      },
      async writeStore(text: string): Promise<void> {
        await run(
          [
            '--distribution', distribution,
            '--exec', '/usr/bin/node', '-e', WSL_EXTERNAL_PROJECT_WRITE_SCRIPT, await homePath(),
            Buffer.from(text).toString('base64url')
          ],
          15_000
        )
      }
    },
    async (wslPath) => {
      const mount = /^\/mnt\/([^/]+)/.exec(wslPath)?.[1]?.toLocaleUpperCase()
      const repair = mount
        ? `Restore the ${mount}: drive mount in ${distribution} WSL and reselect the project.`
        : `Restore access to the converted path in ${distribution} WSL and reselect the project.`
      try {
        const result = await run(
          [
            '--distribution', distribution,
            '--exec', '/usr/bin/node', '-e', WSL_PROJECT_ACCESS_SCRIPT, wslPath
          ],
          15_000
        )
        const access = JSON.parse(result.stdout) as { accessible?: unknown; message?: unknown }
        if (access.accessible === true) return { status: 'accessible' }
        const cause = typeof access.message === 'string' && access.message ? ` ${access.message}` : ''
        return { status: 'unavailable', message: `${wslPath} is unavailable inside FirstMate. ${repair}${cause}` }
      } catch (error) {
        return {
          status: 'unavailable',
          message: `ADE could not validate ${wslPath} inside FirstMate. ${repair} ${errorMessage(error)}`
        }
      }
    }
  )

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
    ...externalProjects,
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
        lastError = errorMessage(error)
      } finally {
        installing = false
      }
      const status = await inspect()
      return { ok: status.state === 'ready', status }
    },
    async authenticateGitHub(): Promise<FirstMateActionResult> {
      const { status: current, paths } = await inspectHost()
      if (current.state !== 'ready' || !paths) {
        return { ok: false, message: current.message ?? 'FirstMate is not ready.' }
      }
      try {
        await openTerminal('ADE FirstMate - GitHub sign in', executable, [
          '--distribution', distribution,
          '--exec', '/usr/bin/env',
          `PATH=${paths.userHome}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
          'gh', 'auth', 'login', '--web', '--git-protocol', 'https'
        ])
        return { ok: true }
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
      }
    },
    async trustCodexProject(): Promise<FirstMateActionResult> {
      const { status: current, paths } = await inspectHost()
      if (current.state !== 'ready' || !paths) {
        return { ok: false, message: current.message ?? 'FirstMate is not ready.' }
      }
      if (current.codexProjectTrust === 'trusted') return { ok: true }
      try {
        await run(
          [
            '--distribution', distribution,
            '--exec', '/bin/sh', '-c', WSL_TRUST_CODEX_PROJECT_SCRIPT,
            'ade-firstmate-trust',
            `${paths.homePath}/codex/config.toml`,
            paths.distroPath
          ],
          15_000
        )
        const updated = await inspect()
        return updated.codexProjectTrust === 'trusted'
          ? { ok: true }
          : { ok: false, message: 'Codex project trust was not enabled.' }
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
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
          message: `ADE could not read durable FirstMate events: ${errorMessage(error)}`,
          tasks: []
        }
      }
    },
    async configureValidator(provider: AgentProvider, modelId?: string): Promise<FirstMateActionResult> {
      if (!readyPaths) await inspect()
      if (!readyPaths) return { ok: false, message: 'FirstMate is not ready.' }
      if (!readyProviders.has(provider)) {
        return { ok: false, message: `The ${provider} provider is not installed in the FirstMate runtime.` }
      }
      selectedValidator = { agent: provider, model: validatorModel(modelId) }
      try {
        await run(
          [
            '--distribution', distribution,
            '--exec', '/bin/sh', '-c', WSL_VALIDATOR_CONFIGURE_SCRIPT,
            'ade-firstmate-validator',
            readyPaths.homePath,
            selectedValidator.agent,
            selectedValidator.model,
            globalRuntimeRecordArg(readyPaths.homePath, selectedValidator.agent, selectedValidator.model)
          ],
          15_000
        )
        if (readyLaunchFactory) {
          readyLaunches = readyLaunchFactory(selectedValidator.agent, selectedValidator.model)
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
      }
    },
    async continueValidation(taskId: string, dispatchId: string): Promise<FirstMateActionResult> {
      const rejected = dispatchTargetError(taskId, dispatchId)
      if (rejected) return rejected
      try {
        const files = await lifecycleFiles()
        if (!readyPaths) return { ok: false, message: 'The pinned task endpoint metadata is unavailable.' }
        const taskConfigPath = `${readyPaths.homePath}/state/${taskId}.ade-runtime.json`
        const dispatch = taskValidationDispatch(
          files,
          taskId,
          dispatchId,
          taskConfigPath,
          readyPaths.homePath
        )
        if (!dispatch) return { ok: false, message: 'The pinned task endpoint metadata is unavailable.' }
        for (const [path, contents] of [
          [dispatch.taskConfigPath, dispatch.taskConfig],
          [dispatch.agentPath, dispatch.wrapper],
          [`${readyPaths.homePath}/no-mistakes/config.yaml`, dispatch.pipelineConfig]
        ]) {
          await run(
            [
              '--distribution', distribution,
              '--exec', '/usr/bin/node', '-e', WSL_ATOMIC_WRITE_SCRIPT,
              path,
              Buffer.from(contents).toString('base64url')
            ],
            15_000
          )
        }
        await run([
          '--distribution', distribution,
          '--exec', '/bin/chmod', '700', dispatch.agentPath
        ], 15_000)
        await run(
          [
            '--distribution', distribution,
            '--cd', readyPaths.distroPath,
            '--exec', '/usr/bin/env',
            ...firstMateProcessEnvironment({
              homePath: readyPaths.homePath,
              runtimeConfigPath: dispatch.taskConfigPath,
              validatorAgent: dispatch.endpoint.context.validator.agent,
              validatorModel: dispatch.endpoint.context.validator.model,
              announceSupervisor: false
            }),
            `${readyPaths.distroPath}/bin/fm-send.sh`,
            taskId,
            dispatch.continuation
          ],
          30_000
        )
        return { ok: true }
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
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
      if (!readyProviders.has(provider)) return null
      if (readyLaunchFactory) readyLaunches = readyLaunchFactory(provider, selectedValidator.model)
      return readyLaunches?.[provider] ?? null
    }
  }
}

/**
 * The whole FirstMate integration on a platform ADE does not host it on. Every entry point refuses
 * with the same reason instead of provisioning, launching, or recording anything, so a platform with
 * no supported host can never accumulate half-built state. Hosting FirstMate somewhere else is a new
 * feature that adds its own runtime and its own runtime state, never a fallback reached from here.
 */
function createUnsupportedFirstMateRuntime(platform: NodeJS.Platform): FirstMateRuntime {
  const message = `ADE integrates FirstMate through Windows' WSL host, which ${platform} does not provide. `
    + 'FirstMate is unavailable on this platform.'
  const status = (): FirstMateRuntimeStatus => ({
    state: 'unsupported',
    backend: 'tmux',
    supervision: 'app-native',
    message
  })
  const refuse = async (): Promise<FirstMateActionResult> => ({ ok: false, message })
  const refuseRegistration = async (): Promise<FirstMateProjectRegistration> => ({ ok: false, message })
  return {
    async status(): Promise<FirstMateRuntimeStatus> { return status() },
    async install(): Promise<FirstMateInstallResult> { return { ok: false, status: status() } },
    authenticateGitHub: refuse,
    trustCodexProject: refuse,
    async lifecycle(): Promise<FirstMateLifecycleStatus> {
      return { supervision: 'app-native', message, tasks: [] }
    },
    configureValidator: refuse,
    continueValidation: refuse,
    async recordLifecycle(): Promise<void> { throw new Error(message) },
    registerProject: refuseRegistration,
    async recordedProject(): Promise<FirstMateExternalProject | null> { return null },
    authorizeProjectInitialization: refuseRegistration,
    retireProject: refuse,
    launch(): FirstMateLaunch | null { return null }
  }
}

export function createFirstMateRuntime(options: FirstMateRuntimeOptions): FirstMateRuntime {
  return options.platform === 'win32'
    ? createWslFirstMateRuntime(options)
    : createUnsupportedFirstMateRuntime(options.platform)
}
