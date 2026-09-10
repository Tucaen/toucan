/**
 * The "Delegate routine work cheaply" policy: one workspace preference, and the provider-native
 * configuration that carries it into a Codex session. The main model keeps planning, diagnosis
 * and review; qualifying bounded searches, extraction and prescribed checks may be spawned onto
 * an economical worker model.
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
 * Instruction-only limitation, documented deliberately: the read-only worker scope and the brief
 * format live in the developer instruction, because the native worker-side channel
 * (`features.multi_agent_v2.subagent_developer_instructions`) belongs to the still-disabled
 * multi_agent_v2 feature. The concurrency cap and recursion bar are native config; the "reads and
 * prescribed checks only" boundary is prompt guidance until Codex exposes a runtime control.
 */

export interface RoutineDelegationPreference {
  enabled: boolean
  /** Absent falls back to the default worker; only ids from `CODEX_WORKER_MODELS` are valid. */
  codexWorkerModelId?: string
}

export interface CodexWorkerModel {
  id: string
  name: string
  description: string
  /** The reasoning effort the worker runs at; every candidate must name one it supports. */
  effortId: string
}

/**
 * The workers Toucan will offer, cheapest first. This list is explicit and hand-ordered because
 * model availability does not establish price ordering - a model being listed by the account says
 * nothing about what it costs. Extend it deliberately, with the price checked, cheapest first.
 * GPT-5.6 Luna: $0.2/M input, $1.2/M output (10x cheaper than GPT-5.6 Terra), supports low effort.
 */
export const CODEX_WORKER_MODELS: readonly CodexWorkerModel[] = [
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    description: 'Economical worker for bounded searches, extraction and prescribed checks',
    effortId: 'low'
  }
]

export const DEFAULT_CODEX_WORKER_MODEL_ID = CODEX_WORKER_MODELS[0].id

export function isRoutineDelegationPreference(value: unknown): value is RoutineDelegationPreference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const preference = value as Partial<RoutineDelegationPreference>
  if (typeof preference.enabled !== 'boolean') return false
  return preference.codexWorkerModelId === undefined || typeof preference.codexWorkerModelId === 'string'
}

/** The worker a preference names, falling back to the default when the id is absent or unknown. */
export function codexWorkerFromPreference(preference: RoutineDelegationPreference): CodexWorkerModel {
  return CODEX_WORKER_MODELS.find((model) => model.id === preference.codexWorkerModelId) ?? CODEX_WORKER_MODELS[0]
}

/** The delegation policy a session requests at launch, as carried on `AgentCreateRequest`. */
export interface RoutineDelegationRequest {
  workerModelId: string
  workerEffortId: string
}

export function routineDelegationRequest(
  preference: RoutineDelegationPreference
): RoutineDelegationRequest | undefined {
  if (!preference.enabled) return undefined
  const worker = codexWorkerFromPreference(preference)
  return { workerModelId: worker.id, workerEffortId: worker.effortId }
}

/**
 * What a session actually launched with. `configured` means the adapter environment carries the
 * policy - the worker model is still only *requested* until a spawn's own activity names it, which
 * is why every surface words a configured policy as unverified rather than enforced. `unavailable`
 * means the account's model cache exists and does not list the worker, so the configuration was
 * withheld instead of silently launching sessions whose spawns would fail model resolution.
 */
export interface AgentRoutineDelegation extends RoutineDelegationRequest {
  status: 'configured' | 'unavailable'
  message?: string
}

export function appliedCodexDelegation(
  request: RoutineDelegationRequest,
  availableModelIds: readonly string[] | undefined
): AgentRoutineDelegation {
  if (availableModelIds && !availableModelIds.includes(request.workerModelId)) {
    return {
      ...request,
      status: 'unavailable',
      message: `This Codex account does not list ${request.workerModelId}, so routine work stays on the main model.`
    }
  }
  return { ...request, status: 'configured' }
}

/**
 * The delegation instruction, at developer priority. It authorizes delegation (the user enabled
 * it), scopes what may be delegated, prescribes the fresh compact brief, and bars retry loops and
 * silent fallback - the classification lives in the main model's own reasoning, never in a
 * separate model call.
 */
export function codexDelegationInstruction(worker: RoutineDelegationRequest): string {
  return [
    'The user enabled "Delegate routine work cheaply" for this Toucan session.',
    '',
    `Delegate qualifying routine work with spawn_agent. Omit the model parameter: the configured default (${worker.workerModelId}, ${worker.workerEffortId} reasoning) is the economical worker the user chose. Never pick a more expensive model for routine work.`,
    '',
    'Routine work has explicit instructions, bounded scope and a checkable result: substantial file or call-site searches, extraction from specified sources, running prescribed checks and summarizing their output. Keep for yourself: ambiguous research, architecture, root-cause diagnosis, security or data-loss decisions, high-impact choices, and final review. Run trivial single-command tasks (one grep, one formatter, one command) directly - delegation overhead would dominate.',
    '',
    'Give each worker a fresh, self-contained brief - never fork or inherit conversation history: state the objective, the relevant paths, constraints, the expected output format, how the result will be checked, and stop conditions. Workers only read and run prescribed checks in this workspace; do not assign code edits.',
    '',
    'Run at most two routine workers at a time, and workers must not delegate further. If a worker fails its check, lacks input, or needs a design decision, it must return concise evidence to you and stop: no autonomous retry loops, and never silently reassign the task to a more expensive worker.'
  ].join('\n')
}

/**
 * The config-override object handed to Codex, TOML field names verbatim. `max_depth: 1` is the
 * native recursion bar and `max_concurrent_threads_per_session: 2` the native concurrency cap;
 * both are asserted here rather than left to the instruction.
 */
export function codexDelegationConfig(worker: RoutineDelegationRequest): Record<string, unknown> {
  return {
    agents: {
      default_subagent_model: worker.workerModelId,
      default_subagent_reasoning_effort: worker.workerEffortId,
      max_concurrent_threads_per_session: 2,
      max_depth: 1
    },
    developer_instructions: codexDelegationInstruction(worker)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function mergeConfig(base: Record<string, unknown>, addition: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base }
  for (const [key, value] of Object.entries(addition)) {
    const existing = merged[key]
    merged[key] = isRecord(existing) && isRecord(value) ? mergeConfig(existing, value) : value
  }
  return merged
}

/**
 * Layers the delegation policy into an environment's `CODEX_CONFIG`. A user-set value keeps its
 * unrelated keys; where both set `developer_instructions`, the user's text is kept ahead of the
 * delegation instruction rather than dropped. An unparseable existing value is replaced - the
 * adapter's own `JSON.parse` would have refused it anyway.
 */
export function withCodexDelegationEnvironment(
  environment: Record<string, string | undefined>,
  worker: RoutineDelegationRequest
): Record<string, string | undefined> {
  let existing: Record<string, unknown> = {}
  if (environment.CODEX_CONFIG) {
    try {
      const parsed: unknown = JSON.parse(environment.CODEX_CONFIG)
      if (isRecord(parsed)) existing = parsed
    } catch {
      // Replaced below: codex-acp would crash on it before any session opened.
    }
  }
  const addition = codexDelegationConfig(worker)
  const merged = mergeConfig(existing, addition)
  if (typeof existing.developer_instructions === 'string' && existing.developer_instructions.trim()) {
    merged.developer_instructions = `${existing.developer_instructions}\n\n${addition.developer_instructions as string}`
  }
  return { ...environment, CODEX_CONFIG: JSON.stringify(merged) }
}
