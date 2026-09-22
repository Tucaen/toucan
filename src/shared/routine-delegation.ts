/**
 * The "Delegate routine work cheaply" policy: one workspace preference, and the provider-native
 * configuration that carries it into a session. The main model keeps planning, diagnosis and
 * review; qualifying bounded searches, extraction, prescribed checks and recipe-driven mechanical
 * edits may be spawned onto an economical worker model. Plan:
 * `docs/plans/cheap-routine-delegation.md`.
 *
 * Codex is configured per Toucan session through the `CODEX_CONFIG` environment variable: the
 * codex-acp adapter (verified on 1.10.0, Codex 0.153.4) parses it once at process start and
 * merges it into every `thread/start`/`thread/resume` config, and Toucan launches one adapter
 * process per node - so this is session-scoped configuration that never touches the user's
 * `~/.codex/config.toml`. The keys are Codex TOML config fields, verified to parse on the
 * installed binary: `agents.default_subagent_model`, `agents.default_subagent_reasoning_effort`,
 * `agents.max_concurrent_threads_per_session`, `agents.max_depth` (runtime-enforced controls),
 * and `developer_instructions` (the delegation instruction, at developer priority so it can
 * actually authorize delegation - a plain user prompt cannot).
 *
 * Claude is configured per session through claude-agent-acp's `_meta.claudeCode.options` on
 * `session/new` and `session/load` (verified on 0.75.1, SDK 0.3.220, CLI 2.1.266): the adapter
 * spreads those into the SDK `query()` options, and the SDK hands `agents` to the CLI in its
 * control-protocol `initialize` request - so the named routine worker exists only for that
 * session and never lands in `~/.claude/agents` or `settings.json`. The parent's routing
 * instruction rides on `_meta.systemPrompt` as a `claude_code` preset append, which is a system
 * prompt and not a transcript message. CLI model precedence, read from the installed binary:
 * `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` overrides everything; otherwise an explicit per-spawn or
 * agent-definition `model` wins over `CLAUDE_CODE_SUBAGENT_MODEL`, which in turn wins over
 * inheriting the parent. Toucan pins the worker on the definition, so only the FORCE variable
 * can override it - and that case is withheld visibly rather than left to run on whatever the
 * environment dictates.
 *
 * Workers may also apply *mechanical edits*, but only from an explicit recipe the main model
 * supplies (issue #180): the exact transformation or pattern, the files the worker may change,
 * constraints, the expected result and the verification commands. Design decisions, review and
 * the listed exclusions (security-sensitive behavior, destructive data operations, architecture
 * changes, unfamiliar bug diagnosis) stay with main, concurrent writers own disjoint files, and a
 * failed verification returns to main rather than looping in the worker.
 *
 * Instruction-only limitations, documented deliberately: for Codex, the worker scope and the
 * brief format live in the developer instruction (the native worker-side channel belongs to the
 * still-disabled multi_agent_v2 feature). For Claude, the recursion bar is native (no Agent
 * tool), but the worker now carries Edit/Write for recipe-driven edits, so the recipe scope,
 * file ownership, "prescribed checks only" and "at most two workers" are prompt guidance there.
 */

import type { AgentProvider } from './agent-provider'
import { withCodexSessionConfig } from './codex-config'

export interface RoutineDelegationPreference {
  enabled: boolean
  /** Absent falls back to the Codex default worker; only ids from `CODEX_WORKER_MODELS` are valid. */
  codexWorkerModelId?: string
  /** Absent falls back to the Claude default worker; only ids from `CLAUDE_WORKER_MODELS` are valid. */
  claudeWorkerModelId?: string
}

/** What routine work is, in one phrase every surface describing a worker builds on. */
export const ROUTINE_WORK_SUMMARY = 'bounded searches, extraction, prescribed checks and recipe-driven mechanical edits'

export interface WorkerModel {
  id: string
  name: string
  description: string
  /** The reasoning effort the worker runs at, when the provider's worker supports one. */
  effortId?: string
}

/**
 * The Codex workers Toucan will offer, cheapest first. This list is explicit and hand-ordered
 * because model availability does not establish price ordering - a model being listed by the
 * account says nothing about what it costs. Extend it deliberately, with the price checked,
 * cheapest first. GPT-5.6 Luna: $0.2/M input, $1.2/M output (10x cheaper than GPT-5.6 Terra),
 * supports low effort.
 * @internal exported for tests
 */
export const CODEX_WORKER_MODELS: readonly WorkerModel[] = [
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    description: `Economical worker for ${ROUTINE_WORK_SUMMARY}`,
    effortId: 'low'
  }
]

/**
 * The Claude workers, cheapest first, by the CLI's picker alias so the id matches what the adapter
 * lists as available. Haiku 4.5 ($1/M input, $5/M output) is the cheapest model the installed CLI
 * offers this account; it advertises no effort levels, so the worker carries none.
 * @internal exported for tests
 */
export const CLAUDE_WORKER_MODELS: readonly WorkerModel[] = [
  {
    id: 'haiku',
    name: 'Haiku',
    description: `Economical worker for ${ROUTINE_WORK_SUMMARY}`
  }
]

export const WORKER_MODELS: Record<AgentProvider, readonly WorkerModel[]> = {
  codex: CODEX_WORKER_MODELS,
  claude: CLAUDE_WORKER_MODELS
}

const WORKER_PREFERENCE_KEY: Record<AgentProvider, 'codexWorkerModelId' | 'claudeWorkerModelId'> = {
  codex: 'codexWorkerModelId',
  claude: 'claudeWorkerModelId'
}

export function isRoutineDelegationPreference(value: unknown): value is RoutineDelegationPreference {
  if (!value || typeof value !== 'object') return false
  const preference = value as Partial<RoutineDelegationPreference>
  if (typeof preference.enabled !== 'boolean') return false
  return (
    (preference.codexWorkerModelId === undefined || typeof preference.codexWorkerModelId === 'string') &&
    (preference.claudeWorkerModelId === undefined || typeof preference.claudeWorkerModelId === 'string')
  )
}

/** The worker a preference names for a provider, falling back to that provider's default. */
export function workerFromPreference(provider: AgentProvider, preference: RoutineDelegationPreference): WorkerModel {
  const models = WORKER_MODELS[provider]
  return models.find((model) => model.id === preference[WORKER_PREFERENCE_KEY[provider]]) ?? models[0]
}

/**
 * The preference after choosing a worker for one provider (or `undefined` to turn delegation off).
 * The other provider's choice is preserved either way, so switching providers or re-enabling
 * finds what was picked before.
 */
export function withWorkerSelection(
  preference: RoutineDelegationPreference,
  provider: AgentProvider,
  workerModelId: string | undefined
): RoutineDelegationPreference {
  if (workerModelId === undefined) return { ...preference, enabled: false }
  return { ...preference, enabled: true, [WORKER_PREFERENCE_KEY[provider]]: workerModelId }
}

/** The delegation policy a session requests at launch, as carried on `AgentCreateRequest`. */
export interface RoutineDelegationRequest {
  workerModelId: string
  workerEffortId?: string
}

export function routineDelegationRequest(
  provider: AgentProvider,
  preference: RoutineDelegationPreference
): RoutineDelegationRequest | undefined {
  if (!preference.enabled) return undefined
  const worker = workerFromPreference(provider, preference)
  return { workerModelId: worker.id, ...(worker.effortId ? { workerEffortId: worker.effortId } : {}) }
}

/**
 * What a session actually launched with. `configured` means the session carries the policy - the
 * worker model is still only *requested* until a spawn's own activity names it, which is why every
 * surface words a configured policy as unverified rather than enforced. `unavailable` means the
 * configuration was withheld (or, for Claude, found unusable once the session listed its models)
 * instead of silently launching sessions whose spawns would fail or be substituted.
 */
export interface AgentRoutineDelegation extends RoutineDelegationRequest {
  status: 'configured' | 'unavailable'
  message?: string
}

/**
 * Withholds the worker when a model list exists and lacks it; no list means configure and stay
 * honest at the UI ("requested, unverified") rather than refuse. `subject` names whose list it was.
 */
function withheldUnlessListed(
  request: RoutineDelegationRequest,
  availableModelIds: readonly string[] | undefined,
  subject: string
): AgentRoutineDelegation {
  if (availableModelIds && !availableModelIds.includes(request.workerModelId)) {
    return {
      ...request,
      status: 'unavailable',
      message: `${subject} does not list ${request.workerModelId}, so routine work stays on the main model.`
    }
  }
  return { ...request, status: 'configured' }
}

export function appliedCodexDelegation(
  request: RoutineDelegationRequest,
  availableModelIds: readonly string[] | undefined
): AgentRoutineDelegation {
  return withheldUnlessListed(request, availableModelIds, 'This Codex account')
}

/**
 * Whether the Claude worker can be pinned here. `availableModelIds` is what the adapter listed for
 * a Claude session (or what the last one listed, before a new launch); the CLI substitutes a model
 * missing from its allowlist with "the newest allowed model in its family" and only logs a warning,
 * which is exactly the silent expensive fallback this policy refuses. The FORCE variable makes the
 * CLI ignore every agent-definition model, so the worker would run on whatever it dictates.
 */
export function appliedClaudeDelegation(
  request: RoutineDelegationRequest,
  availableModelIds: readonly string[] | undefined,
  environment: Record<string, string | undefined>
): AgentRoutineDelegation {
  if (environment.CLAUDE_CODE_SUBAGENT_MODEL_FORCE) {
    return {
      ...request,
      status: 'unavailable',
      message:
        'CLAUDE_CODE_SUBAGENT_MODEL_FORCE is set, which would override the worker model, so routine work stays on the main model.'
    }
  }
  return withheldUnlessListed(request, availableModelIds, 'This Claude session')
}

/**
 * The delegation instruction the main model receives, at developer/system priority. It authorizes
 * delegation (the user enabled it), scopes what may be delegated, prescribes the fresh compact
 * brief, and bars retry loops and silent fallback - the classification lives in the main model's
 * own reasoning, never in a separate model call. Only the spawn paragraph is provider-specific.
 */
function routineDelegationInstruction(spawn: string): string {
  return [
    'The user enabled "Delegate routine work cheaply" for this Toucan session.',
    '',
    spawn,
    '',
    'Routine work has explicit instructions, bounded scope and a checkable result: substantial file or call-site searches, extraction from specified sources, running prescribed checks and summarizing their output, and mechanical edits you have fully prescribed. Keep for yourself: ambiguous research, architecture, root-cause diagnosis, security or data-loss decisions, high-impact choices, and final review. Run trivial single-command tasks (one grep, one formatter, one command) directly - delegation overhead would dominate.',
    '',
    'Give each worker a fresh, self-contained brief - never fork or inherit conversation history: state the objective, the relevant paths, constraints, the expected output format, how the result will be checked, and stop conditions.',
    '',
    'A mechanical edit may be delegated only after you have already made every decision: the brief must spell out the exact transformation or pattern to apply, the files the worker may change, the constraints that apply, the expected result, and the verification commands to run - and it must require the worker to preserve existing modifications in the files it touches, applying the prescribed transformation and nothing else. A small diff is not evidence a task is routine - what matters is whether any design decision remains, and edits touching security-sensitive behavior, destructive data operations, or architecture changes, and fixes for bugs you have not yet diagnosed, are never delegated. Workers edit this same checkout: while a worker owns its assigned files, neither you nor another worker may edit them, and overlapping assignments must run one after the other unless an explicit existing worktree isolates them - never assume a worker has a private checkout.',
    '',
    "Review each worker's reported changes and evidence yourself before treating a task as complete. If a worker fails its verification, lacks input, hits an unexpected dependency, or needs a design decision, it must return concise evidence to you and stop: no autonomous retry loops, and never silently reassign the task to a more expensive worker. A cancelled or failed worker leaves its partial changes in place for you to inspect. Run at most two routine workers at a time, and workers must not delegate further."
  ].join('\n')
}

export function codexDelegationInstruction(worker: RoutineDelegationRequest): string {
  const effort = worker.workerEffortId ? `, ${worker.workerEffortId} reasoning` : ''
  return routineDelegationInstruction(
    `Delegate qualifying routine work with spawn_agent. Omit the model parameter: the configured default (${worker.workerModelId}${effort}) is the economical worker the user chose. Never pick a more expensive model for routine work.`
  )
}

/**
 * The config-override object handed to Codex, TOML field names verbatim. `max_depth: 1` is the
 * native recursion bar and `max_concurrent_threads_per_session: 2` the native concurrency cap;
 * both are asserted here rather than left to the instruction.
 * @internal exported for tests
 */
export function codexDelegationConfig(worker: RoutineDelegationRequest): Record<string, unknown> {
  return {
    agents: {
      default_subagent_model: worker.workerModelId,
      ...(worker.workerEffortId ? { default_subagent_reasoning_effort: worker.workerEffortId } : {}),
      max_concurrent_threads_per_session: 2,
      max_depth: 1
    },
    developer_instructions: codexDelegationInstruction(worker)
  }
}

/**
 * The named subagent a delegating Claude session carries; the main model spawns it by this name.
 * @internal exported for tests
 */
export const CLAUDE_ROUTINE_WORKER_NAME = 'routine-worker'

/** The SDK's `AgentDefinition` fields Toucan sets, typed here so the meta needs no SDK import. */
export interface ClaudeRoutineWorkerDefinition {
  description: string
  prompt: string
  tools: string[]
  model: string
}

/** The `_meta` a delegating Claude session sends with `session/new`/`session/load`. */
export interface ClaudeDelegationSessionMeta {
  claudeCode: { options: { agents: Record<string, ClaudeRoutineWorkerDefinition> } }
  systemPrompt: { type: 'preset'; preset: 'claude_code'; append: string }
}

export function claudeDelegationInstruction(worker: RoutineDelegationRequest): string {
  return routineDelegationInstruction(
    `Delegate qualifying routine work with the Agent tool using subagent_type "${CLAUDE_ROUTINE_WORKER_NAME}". Omit the model parameter: that agent is pinned to ${worker.workerModelId}, the economical worker the user chose. Never pick a more expensive model or a different subagent for routine work.`
  )
}

/**
 * The worker's own compact instructions, at its system-prompt priority. The native part of the
 * boundary is the missing Agent tool, so it cannot delegate further. Edit/Write are granted for
 * recipe-driven mechanical edits (issue #180); the recipe scope - named files only, prescribed
 * transformation only, preserve everything else - is prompt-enforced, which is why the prompt
 * spells it out.
 */
export function claudeDelegationSessionMeta(worker: RoutineDelegationRequest): ClaudeDelegationSessionMeta {
  return {
    claudeCode: {
      options: {
        agents: {
          [CLAUDE_ROUTINE_WORKER_NAME]: {
            description:
              'Economical routine worker for bounded searches, extraction, prescribed checks and mechanical edits from an explicit recipe. Not for design, diagnosis, review or unprescribed changes.',
            prompt: [
              'You are a routine worker given one bounded brief. Do exactly what the brief asks, nothing beyond it.',
              'You may read files and run the checks the brief prescribes. Edit only when the brief supplies an explicit recipe: the exact transformation to apply, the files you may change, and the verification commands. Never change a file the brief does not name, and preserve existing modifications in the files you touch - apply only the prescribed transformation.',
              'If the brief is ambiguous, an input is missing, a prescribed verification fails or cannot be run, or you discover an unexpected dependency or design question, stop and report concise evidence instead of retrying, improvising or expanding scope. Never substitute a different check for a prescribed verification: a verification you could not run is reported as blocked, never as passed.',
              'Never start other agents. Report a compact summary: the files you changed and how, the checks you ran with their results, and anything unresolved - with file paths, line numbers, and the exact command output an assertion rests on.'
            ].join('\n'),
            tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
            model: worker.workerModelId
          }
        }
      }
    },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: claudeDelegationInstruction(worker) }
  }
}

/**
 * Layers the delegation policy into an environment's `CODEX_CONFIG`, by the rules `codex-config.ts`
 * owns: a user-set value keeps its unrelated keys, and where both set `developer_instructions` the
 * user's text is kept ahead of the delegation instruction rather than dropped.
 */
export function withCodexDelegationEnvironment(
  environment: Record<string, string | undefined>,
  worker: RoutineDelegationRequest
): Record<string, string | undefined> {
  return withCodexSessionConfig(environment, codexDelegationConfig(worker))
}
