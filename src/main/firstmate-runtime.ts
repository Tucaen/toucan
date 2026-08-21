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
  FirstMatePullRequestCheck,
  FirstMatePullRequestState,
  FirstMateQuotaStatus,
  FirstMateQuotaWindow,
  FirstMateRuntimeStatus,
  FirstMateValidationDelivery
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
  FIRSTMATE_DISPATCH_LEDGER_FILE,
  FIRSTMATE_LIFECYCLE_JOURNAL_FILE,
  firstMateLifecycleFromFiles,
  firstMateRecognisedDispatch,
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
  'gate',
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
export const WSL_INSPECT_SCRIPT = `
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
[ -x "$base/home/bin/claude" ] && grep -qF 'exec "'"$HOME"'/.local/bin/claude" "$@"' "$base/home/bin/claude" && printf 'wrapper.claude=1\n' || true
[ -x "$base/home/bin/codex" ] && grep -qF 'exec "'"$HOME"'/.local/bin/codex" "$@"' "$base/home/bin/codex" && printf 'wrapper.codex=1\n' || true
[ -x "$base/home/bin/ade-spawn-gate" ] && printf 'gate=1\n' || true
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

const WSL_SYNC_MANAGED_AUTH_FUNCTION = `
sync_managed_auth() {
  host_auth="$1"
  managed_auth="$2"
  mkdir -p "$(dirname "$managed_auth")"
  if [ -f "$host_auth" ] && { [ ! -f "$managed_auth" ] || [ "$host_auth" -nt "$managed_auth" ]; }; then
    cp "$host_auth" "$managed_auth"
    chmod 600 "$managed_auth"
  fi
}
`

const WSL_SYNC_MANAGED_AUTH_SCRIPT = `
set -eu
umask 077
${WSL_SYNC_MANAGED_AUTH_FUNCTION}
sync_managed_auth "$1" "$2"
`

const WSL_AGENT_SCRIPT = `
set -eu
umask 077
${WSL_SYNC_MANAGED_AUTH_FUNCTION}
host_auth="$1"
managed_auth="$2"
pipeline_agent="$3"
pipeline_model="$4"
runtime_config="$5"
runtime_home="$6"
runtime_record="$7"
shift 7
sync_managed_auth "$host_auth" "$managed_auth"
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
const { execFileSync } = require('node:child_process')
const home = process.argv[1]
const optional = (file) => { try { return fs.readFileSync(file, 'utf8') } catch { return undefined } }
const state = path.join(home, 'state')
const metaValue = (meta, key) => {
  for (const line of meta.split(/\\r?\\n/)) {
    if (line.startsWith(key + '=')) return line.slice(key.length + 1)
  }
  return undefined
}
// Read-only: 'git rev-parse' never writes to the checkout or the worktree. Absolute paths let ADE
// compare a worktree's repository identity against its pinned checkout wherever Git reports them.
// Canonicalize so a worktree and its checkout that reach one repository through different symlink
// chains (a symlinked home, /mnt duplication) still compare as the same identity rather than foreign.
const canonical = (p) => { try { return fs.realpathSync(p) } catch { return p } }
const revParse = (dir, arg) => canonical(execFileSync(
  'git', ['-C', dir, 'rev-parse', '--path-format=absolute', arg],
  { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }
).trim())
const probe = (dir, wants) => {
  try {
    const identity = { commonDir: revParse(dir, '--git-common-dir') }
    if (wants.gitDir) identity.gitDir = revParse(dir, '--git-dir')
    return identity
  } catch (error) {
    return { error: String((error && error.message) || error).split('\\n')[0] }
  }
}
let names = []
try { names = fs.readdirSync(state) } catch {}
const tasks = names.filter((name) => name.endsWith('.meta')).map((name) => {
  const id = name.slice(0, -5)
  const meta = optional(path.join(state, id + '.meta')) || ''
  const task = { id, meta, status: optional(path.join(state, id + '.status')) || '' }
  const worktree = metaValue(meta, 'worktree')
  const checkout = metaValue(meta, 'project')
  if (worktree && checkout) {
    task.provenance = { worktree: probe(worktree, { gitDir: true }), checkout: probe(checkout, {}) }
  }
  return task
})
process.stdout.write(JSON.stringify({
  runtimeConfig: optional(path.join(home, 'config', 'ade-runtime.json')),
  journal: optional(path.join(state, ${JSON.stringify(FIRSTMATE_LIFECYCLE_JOURNAL_FILE)})),
  dispatchLedger: optional(path.join(state, ${JSON.stringify(FIRSTMATE_DISPATCH_LEDGER_FILE)})),
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

const WSL_DISPATCH_LEDGER_SCRIPT = `
const fs = require('node:fs')
const path = require('node:path')
const home = process.argv[1]
const dispatchId = process.argv[2]
const entry = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString('utf8'))
const state = path.join(home, 'state')
const target = path.join(state, ${JSON.stringify(FIRSTMATE_DISPATCH_LEDGER_FILE)})
fs.mkdirSync(state, { recursive: true })
let ledger = { version: 1, dispatches: {} }
try {
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
  if (parsed.version === 1 && parsed.dispatches && typeof parsed.dispatches === 'object') ledger = parsed
} catch {}
const existing = ledger.dispatches[dispatchId] || {}
const priorDeliveries = typeof existing.deliveries === 'number' ? existing.deliveries : 0
ledger.dispatches[dispatchId] = {
  ...existing,
  ...entry,
  deliveries: priorDeliveries + (entry.status === 'dispatched' ? 1 : 0)
}
const temporary = target + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp'
fs.writeFileSync(temporary, JSON.stringify(ledger, null, 2) + '\\n', { mode: 0o600 })
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
export const WSL_WRAPPER_SCRIPT = `
cat > "$base/home/bin/codex" <<EOF
#!/bin/sh
export CODEX_HOME="$base/home/codex"
exec "$HOME/.local/bin/codex" "\\$@"
EOF
cat > "$base/home/bin/claude" <<EOF
#!/bin/sh
export CLAUDE_CONFIG_DIR="$base/home/claude"
export DISABLE_AUTOUPDATER=1
exec "$HOME/.local/bin/claude" "\\$@"
EOF
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
${WSL_WRAPPER_SCRIPT}
cat > "$base/home/bin/ade-spawn-gate" <<'GATE'
#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const home = process.env.FM_HOME
if (!home) { process.stderr.write('Spawn refused: FM_HOME is not set.\\n'); process.exit(1) }
const metadata = process.argv[2]
if (!metadata) { process.stderr.write('Usage: ade-spawn-gate <task-context-metadata>\\n'); process.exit(1) }
const prefix = 'ade_task_context='
if (!metadata.startsWith(prefix)) {
  process.stderr.write('Spawn refused: metadata is not a valid task context carrier.\\n')
  process.exit(1)
}
let context
try { context = JSON.parse(decodeURIComponent(metadata.slice(prefix.length))) }
catch { process.stderr.write('Spawn refused: task context carrier is malformed.\\n'); process.exit(1) }
if (!context || context.version !== 1 || !context.project || !context.validator) {
  process.stderr.write('Spawn refused: task context is structurally invalid.\\n')
  process.exit(1)
}
let store
try { store = JSON.parse(fs.readFileSync(path.join(home, 'data', 'ade-external-projects.json'), 'utf8')) }
catch { process.stderr.write('Spawn refused: ADE project store is unreadable.\\n'); process.exit(1) }
const project = store.projects && store.projects[context.project.adeProjectId]
if (!project) {
  process.stderr.write('Spawn refused: no registered project ' + JSON.stringify(context.project.adeProjectId) + '.\\n')
  process.exit(1)
}
let runtime
try { runtime = JSON.parse(fs.readFileSync(path.join(home, 'config', 'ade-runtime.json'), 'utf8')) }
catch { process.stderr.write('Spawn refused: ADE runtime record is unreadable.\\n'); process.exit(1) }
if (!runtime.validator) {
  process.stderr.write('Spawn refused: ADE runtime record has no validator.\\n')
  process.exit(1)
}
const checks = [
  ['Project id', context.project.adeProjectId, project.adeProjectId],
  ['Registry name', context.project.registryName, project.registryName],
  ['Canonical Windows path', context.project.windowsPath, project.windowsPath],
  ['Canonical WSL path', context.project.wslPath, project.wslPath],
  ['Delivery posture', context.project.mode, project.mode],
  ['Autonomy authorization', context.project.autonomy, project.autonomy]
]
for (const [label, got, want] of checks) {
  if (got !== want) {
    process.stderr.write('Spawn refused: ' + label + ' ' + JSON.stringify(got)
      + ' disagrees with authoritative record ' + JSON.stringify(want) + '.\\n')
    process.exit(1)
  }
}
if (context.validator.agent !== runtime.validator.agent) {
  process.stderr.write('Spawn refused: provider ' + JSON.stringify(context.validator.agent)
    + ' disagrees with authoritative record ' + JSON.stringify(runtime.validator.agent) + '.\\n')
  process.exit(1)
}
if (context.validator.model !== runtime.validator.model) {
  process.stderr.write('Spawn refused: model ' + JSON.stringify(context.validator.model)
    + ' disagrees with authoritative record ' + JSON.stringify(runtime.validator.model) + '.\\n')
  process.exit(1)
}
GATE
chmod 700 "$base/home/bin/codex" "$base/home/bin/claude" "$base/home/bin/ade-spawn-gate"
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
  repair(): Promise<FirstMateInstallResult>
  authenticateGitHub(): Promise<FirstMateActionResult>
  trustCodexProject(): Promise<FirstMateActionResult>
  lifecycle(): Promise<FirstMateLifecycleStatus>
  /** Opens a real terminal attached to a task's live tmux worker window, reusing the same binding lifecycle() reports. */
  openWorkerTerminal(taskId: string): Promise<FirstMateActionResult>
  configureValidator(provider: AgentProvider, modelId?: string): Promise<FirstMateActionResult>
  continueValidation(taskId: string, dispatchId: string): Promise<FirstMateValidationDelivery>
  recordLifecycle(taskId: string, record: FirstMateLifecycleRecord): Promise<void>
  /**
   * Asks a recognised PR's own forge whether it has merged or closed, reusing the same `gh` session
   * FirstMate's own GitHub auth already established - never a raw unauthenticated HTTP call, since a
   * private repo's unauthenticated 404 is indistinguishable from "does not exist". Fails open to
   * `{ ok: false }` on anything short of a confidently recognised state: `gh` missing, unauthenticated,
   * rate-limited, or any other error. Callers must never surface that as a blocking error.
   */
  checkPullRequestStatus(url: string): Promise<FirstMatePullRequestCheck>
  /** Registers one ADE checkout as a durable external project; never modifies that checkout. */
  registerProject(selection: FirstMateProjectSelection): Promise<FirstMateProjectRegistration>
  recordedProject(adeProjectId: string): Promise<FirstMateExternalProject | null>
  authorizeProjectInitialization(adeProjectId: string): Promise<FirstMateProjectRegistration>
  setAutonomyCeiling(adeProjectId: string, allowed: boolean): Promise<FirstMateProjectRegistration>
  retireProject(adeProjectId: string): Promise<FirstMateActionResult>
  launch(provider?: AgentProvider, modelId?: string): FirstMateLaunch | null
  /** Account-wide hourly/weekly usage-limit status for one provider, reported by the `quota-axi` tool. */
  quotaStatus(provider: AgentProvider): Promise<FirstMateQuotaStatus>
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
): Pick<FirstMateRuntime, 'registerProject' | 'recordedProject' | 'authorizeProjectInitialization' | 'setAutonomyCeiling' | 'retireProject'> {
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
    async setAutonomyCeiling(adeProjectId: string, allowed: boolean): Promise<FirstMateProjectRegistration> {
      try {
        return await projects.setAutonomyCeiling(adeProjectId, allowed)
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

interface QuotaAxiWindow {
  id?: string
  kind?: string
  percentRemaining?: number
  resetsAt?: string
}

interface QuotaAxiReport {
  providers?: Array<{
    provider?: string
    windows?: QuotaAxiWindow[]
    state?: { status?: string; error?: string }
  }>
}

/**
 * `quota-axi --json` always exits 0 and reports one entry per requested provider, even when that
 * provider is unauthenticated or unreachable - those cases just carry an empty `windows` array, so
 * "no five_hour/seven_day window" (not a thrown error) is the normal shape of an unavailable report.
 */
function parseQuotaStatus(provider: AgentProvider, stdout: string): FirstMateQuotaStatus {
  let report: QuotaAxiReport
  try {
    report = JSON.parse(stdout) as QuotaAxiReport
  } catch (error) {
    return { state: 'unavailable', provider, message: `quota-axi returned unreadable output: ${errorMessage(error)}` }
  }
  const providerReport = report.providers?.find((entry) => entry.provider === provider)
  const windows = providerReport?.windows ?? []
  const quotaWindow = (ids: string[], kind?: string): FirstMateQuotaWindow | undefined => {
    const found = windows.find((entry) => (
      (typeof entry.id === 'string' && ids.includes(entry.id))
        || (kind !== undefined && entry.kind === kind)
    ))
    return found && typeof found.percentRemaining === 'number' && typeof found.resetsAt === 'string'
      ? { percentRemaining: found.percentRemaining, resetsAt: found.resetsAt }
      : undefined
  }
  const session = quotaWindow(['five_hour'])
  const week = quotaWindow(['seven_day', 'weekly'], 'weekly')
  if (!session && !week) {
    return {
      state: 'unavailable',
      provider,
      message: providerReport?.state?.error
        ?? `quota-axi reported no usage windows for ${provider}.`
    }
  }
  return { state: 'ok', provider, session, week }
}

const GH_PULL_REQUEST_STATES: Record<string, FirstMatePullRequestState> = {
  OPEN: 'open',
  MERGED: 'merged',
  CLOSED: 'closed'
}

/**
 * `gh pr view --json state` on success always prints one object with a recognised `state`; anything
 * else (unreadable JSON, an unrecognised value) is treated the same as a failed check, since this
 * reconciliation only ever acts on a state it can name with confidence.
 */
function parseGhPullRequestState(stdout: string): FirstMatePullRequestCheck {
  try {
    const parsed = JSON.parse(stdout) as { state?: unknown }
    const state = typeof parsed.state === 'string' ? GH_PULL_REQUEST_STATES[parsed.state] : undefined
    return state ? { ok: true, state } : { ok: false }
  } catch {
    return { ok: false }
  }
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

/**
 * Both ids reach the worker as command arguments, so neither may carry anything else. A malformed id
 * is caught before any external send, so it is a pre-send rejection the caller may safely retire.
 */
function dispatchTargetError(taskId: string, dispatchId: string): FirstMateValidationDelivery | undefined {
  if (!SAFE_ARGUMENT.test(taskId)) {
    return { outcome: 'rejected-before-send', message: 'Invalid FirstMate task id.' }
  }
  if (!SAFE_ARGUMENT.test(dispatchId)) {
    return { outcome: 'rejected-before-send', message: 'Invalid FirstMate validation dispatch id.' }
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
  nmHome: string
  pipelineConfig: string
  wrapper: string
  continuation: string
}

function taskValidationDispatch(
  files: FirstMateLifecycleFiles,
  taskId: string,
  dispatchId: string,
  taskConfigPath: string,
  ledgerPath: string,
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
  const nmHome = `${homePath}/state/validators/${validatorScopeHash}/no-mistakes`
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
      nmHome,
      agentHome,
      agentPath
    ),
    agentPath,
    nmHome,
    pipelineConfig: `agent: ${agent}\nagent_path_override:\n  ${agent}: ${JSON.stringify(agentPath)}\n`,
    wrapper: `#!/bin/sh\n${providerHome}\nexec ${JSON.stringify(`$HOME/.local/bin/${agent}`)}${modelArgument} "$@"\n`,
    continuation: noMistakesContinuation(endpoint.harness, taskConfigPath, dispatchId, ledgerPath)
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
  let readyAuthPaths: Record<AgentProvider, { host?: string; managed: string }> | null = null
  let readyProviders = new Set<AgentProvider>()
  let selectedValidator: { agent: AgentProvider; model: string } = { agent: 'codex', model: 'default' }
  // This is an account-wide, minutes-scale limit rather than a fast-changing per-token signal, so a
  // short cache lets every open panel/node poll on its own timer without each tick invoking quota-axi.
  const QUOTA_CACHE_TTL_MS = 60_000
  const quotaCache = new Map<AgentProvider, { expiresAt: number; status: FirstMateQuotaStatus }>()
  const quotaInFlight = new Map<AgentProvider, Promise<FirstMateQuotaStatus>>()

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
        readyAuthPaths = null
        readyProviders.clear()
        const repairable = detected.get('distro') === '1'
        return {
          status: {
            state: lastError ? 'error' : repairable ? 'repair' : 'missing',
            distroPath: paths.distroPath,
            homePath: paths.homePath,
            backend: 'tmux',
            supervision: 'app-native',
            distribution,
            message: lastError
              ?? (repairable
                ? `ADE's managed FirstMate home needs repair. Existing projects, authentication, and task state are preserved.`
                : `ADE will provision FirstMate, native Claude and Codex agents, tmux, and the managed review toolchain in ${distribution}.`)
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
      readyAuthPaths = {
        codex: {
          host: sharedCodexHome ? `${sharedCodexHome}/auth.json` : undefined,
          managed: `${managedCodexHome}/auth.json`
        },
        claude: {
          host: sharedClaudeHome ? `${sharedClaudeHome}/.credentials.json` : undefined,
          managed: `${managedClaudeHome}/.credentials.json`
        }
      }
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
      readyAuthPaths = null
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

  const provision = async (steps: () => Promise<void>): Promise<FirstMateInstallResult> => {
    if (installing) return { ok: false, status: await inspect() }
    installing = true
    lastError = undefined
    try {
      await steps()
    } catch (error) {
      lastError = errorMessage(error)
    } finally {
      installing = false
    }
    const status = await inspect()
    return { ok: status.state === 'ready', status }
  }

  return {
    status: inspect,
    ...externalProjects,
    install: () => provision(async () => {
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
    }),
    repair: () => provision(async () => {
      await run(
        ['--distribution', distribution, '--exec', '/bin/bash', '-lc', WSL_PREPARE_SCRIPT],
        15 * 60_000
      )
    }),
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
    async checkPullRequestStatus(url: string): Promise<FirstMatePullRequestCheck> {
      const { status: current, paths } = await inspectHost()
      if (current.state !== 'ready' || !paths || current.githubAuth !== 'authenticated') return { ok: false }
      try {
        const result = await run(
          [
            '--distribution', distribution,
            '--exec', '/usr/bin/env',
            `PATH=${paths.userHome}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
            'gh', 'pr', 'view', url, '--json', 'state'
          ],
          15_000
        )
        return parseGhPullRequestState(result.stdout)
      } catch {
        return { ok: false }
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
    async openWorkerTerminal(taskId: string): Promise<FirstMateActionResult> {
      const { status: current } = await inspectHost()
      if (current.state !== 'ready') {
        return { ok: false, message: current.message ?? 'FirstMate is not ready.' }
      }
      let files: FirstMateLifecycleFiles
      try {
        files = await lifecycleFiles()
      } catch (error) {
        return { ok: false, message: `ADE could not read durable FirstMate events: ${errorMessage(error)}` }
      }
      const task = firstMateLifecycleFromFiles(files).tasks.find((candidate) => candidate.id === taskId)
      const target = task?.window
      if (!target) {
        return {
          ok: false,
          message: `Task ${taskId} has no recorded live worker window. It may have finished and been torn down, `
            + 'or never recorded one.'
        }
      }
      try {
        await run(
          ['--distribution', distribution, '--exec', '/usr/bin/tmux', 'has-session', '-t', target],
          10_000
        )
      } catch (error) {
        return {
          ok: false,
          message: `Task ${taskId}'s worker session (${target}) is not running: ${errorMessage(error)}`
        }
      }
      try {
        await openTerminal(`ADE FirstMate - ${taskId}`, executable, [
          '--distribution', distribution,
          '--exec', '/usr/bin/tmux', 'attach-session', '-t', target
        ])
        return { ok: true }
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
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
    async continueValidation(taskId: string, dispatchId: string): Promise<FirstMateValidationDelivery> {
      const rejected = dispatchTargetError(taskId, dispatchId)
      if (rejected) return rejected
      const recordLedger = (home: string, status: 'dispatched' | 'acknowledged'): Promise<unknown> => run(
        [
          '--distribution', distribution,
          '--exec', '/usr/bin/node', '-e', WSL_DISPATCH_LEDGER_SCRIPT,
          home,
          dispatchId,
          Buffer.from(JSON.stringify({ taskId, status, recordedAt: new Date().toISOString() })).toString('base64url')
        ],
        15_000
      )
      // Everything up to the external send is pre-send preparation: a failure here proves nothing
      // reached FirstMate, so the same stable identity stays safely retryable.
      let dispatch: TaskValidationDispatch
      let distroPath: string
      let homePath: string
      let continuationEnvironment: string[]
      try {
        const files = await lifecycleFiles()
        if (!readyPaths) {
          return { outcome: 'rejected-before-send', message: 'The pinned task endpoint metadata is unavailable.' }
        }
        // Durable recognition, read back from disk: an identity already proven delivered is never
        // sent a second time, even across a restart that lost every in-memory trace of it.
        if (firstMateRecognisedDispatch(files.dispatchLedger, dispatchId)?.status === 'acknowledged') {
          return { outcome: 'acknowledged' }
        }
        const taskConfigPath = `${readyPaths.homePath}/state/${taskId}.ade-runtime.json`
        const ledgerPath = `${readyPaths.homePath}/state/${FIRSTMATE_DISPATCH_LEDGER_FILE}`
        const built = taskValidationDispatch(
          files,
          taskId,
          dispatchId,
          taskConfigPath,
          ledgerPath,
          readyPaths.homePath
        )
        if (!built) {
          return { outcome: 'rejected-before-send', message: 'The pinned task endpoint metadata is unavailable.' }
        }
        dispatch = built
        distroPath = readyPaths.distroPath
        homePath = readyPaths.homePath
        // A task validation dispatch inherits an already-supervised session, so it omits the
        // supervisor announcement; the values are captured here so the send phase does not have to
        // re-narrow `readyPaths` after the pre-send try.
        continuationEnvironment = firstMateProcessEnvironment({
          homePath: readyPaths.homePath,
          runtimeConfigPath: dispatch.taskConfigPath,
          validatorAgent: dispatch.endpoint.context.validator.agent,
          validatorModel: dispatch.endpoint.context.validator.model,
          nmHome: dispatch.nmHome,
          announceSupervisor: false
        })
        // Durable evidence of this dispatch identity must exist before the send, so a repeated
        // delivery of the same identity is recognisable by the receiving boundary rather than lost.
        await recordLedger(readyPaths.homePath, 'dispatched')
        for (const [path, contents] of [
          [dispatch.taskConfigPath, dispatch.taskConfig],
          [dispatch.agentPath, dispatch.wrapper],
          [`${dispatch.nmHome}/config.yaml`, dispatch.pipelineConfig]
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
      } catch (error) {
        return { outcome: 'rejected-before-send', message: errorMessage(error) }
      }
      // The external send. A timeout or non-zero exit here may still have delivered the continuation,
      // so its outcome is indeterminate rather than a proven pre-send rejection.
      try {
        await run(
          [
            '--distribution', distribution,
            '--cd', distroPath,
            '--exec', '/usr/bin/env',
            ...continuationEnvironment,
            `${distroPath}/bin/fm-send.sh`,
            taskId,
            dispatch.continuation
          ],
          30_000
        )
      } catch (error) {
        return { outcome: 'indeterminate', message: errorMessage(error) }
      }
      // The send completed, so this identity is provably delivered. Upgrading the ledger to
      // `acknowledged` is best-effort durable bookkeeping: a failure here does not unsettle a proven
      // delivery, and the coordinator's own journal still records the acknowledgement.
      try {
        await recordLedger(homePath, 'acknowledged')
      } catch {
        // The delivery still succeeded; the durable acknowledgement is a convenience, not a gate.
      }
      return { outcome: 'acknowledged' }
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
    },
    async quotaStatus(provider: AgentProvider): Promise<FirstMateQuotaStatus> {
      const cached = quotaCache.get(provider)
      if (cached && cached.expiresAt > Date.now()) return cached.status
      const inFlight = quotaInFlight.get(provider)
      if (inFlight) return inFlight
      const request = (async (): Promise<FirstMateQuotaStatus> => {
        if (!readyPaths) await inspect()
        if (!readyPaths) return { state: 'unavailable', provider, message: 'FirstMate is not ready.' }
        try {
          const authPaths = readyAuthPaths?.[provider]
          if (authPaths?.host) {
            await run(
              [
                '--distribution', distribution,
                '--exec', '/bin/sh', '-lc', WSL_SYNC_MANAGED_AUTH_SCRIPT,
                'ade-firstmate-quota-auth', authPaths.host, authPaths.managed
              ],
              15_000
            )
          }
          const managedHomeEnvironment = provider === 'codex'
            ? `${CODEX_HOME}=${readyPaths.homePath}/codex`
            : `${CLAUDE_CONFIG_DIR}=${readyPaths.homePath}/claude`
          const result = await run(
            [
              '--distribution', distribution,
              '--exec', '/usr/bin/env',
              `PATH=${readyPaths.userHome}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
              managedHomeEnvironment,
              'quota-axi', '--provider', provider, '--json'
            ],
            15_000
          )
          return parseQuotaStatus(provider, result.stdout)
        } catch (error) {
          return { state: 'unavailable', provider, message: errorMessage(error) }
        }
      })()
      quotaInFlight.set(provider, request)
      try {
        const status = await request
        quotaCache.set(provider, { expiresAt: Date.now() + QUOTA_CACHE_TTL_MS, status })
        return status
      } finally {
        quotaInFlight.delete(provider)
      }
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
  const refuseDelivery = async (): Promise<FirstMateValidationDelivery> => (
    { outcome: 'rejected-before-send', message }
  )
  const refuseRegistration = async (): Promise<FirstMateProjectRegistration> => ({ ok: false, message })
  return {
    async status(): Promise<FirstMateRuntimeStatus> { return status() },
    async install(): Promise<FirstMateInstallResult> { return { ok: false, status: status() } },
    async repair(): Promise<FirstMateInstallResult> { return { ok: false, status: status() } },
    authenticateGitHub: refuse,
    trustCodexProject: refuse,
    async lifecycle(): Promise<FirstMateLifecycleStatus> {
      return { supervision: 'app-native', message, tasks: [] }
    },
    openWorkerTerminal: refuse,
    configureValidator: refuse,
    continueValidation: refuseDelivery,
    async recordLifecycle(): Promise<void> { throw new Error(message) },
    async checkPullRequestStatus(): Promise<FirstMatePullRequestCheck> { return { ok: false } },
    registerProject: refuseRegistration,
    async recordedProject(): Promise<FirstMateExternalProject | null> { return null },
    authorizeProjectInitialization: refuseRegistration,
    setAutonomyCeiling: refuseRegistration,
    retireProject: refuse,
    launch(): FirstMateLaunch | null { return null },
    async quotaStatus(provider: AgentProvider): Promise<FirstMateQuotaStatus> {
      return { state: 'unavailable', provider, message }
    }
  }
}

export function createFirstMateRuntime(options: FirstMateRuntimeOptions): FirstMateRuntime {
  return options.platform === 'win32'
    ? createWslFirstMateRuntime(options)
    : createUnsupportedFirstMateRuntime(options.platform)
}
