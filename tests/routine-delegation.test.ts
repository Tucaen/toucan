import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  CLAUDE_ROUTINE_WORKER_NAME,
  CLAUDE_WORKER_MODELS,
  CODEX_WORKER_MODELS,
  appliedClaudeDelegation,
  appliedCodexDelegation,
  claudeDelegationSessionMeta,
  codexDelegationConfig,
  isRoutineDelegationPreference,
  routineDelegationRequest,
  withCodexDelegationEnvironment,
  withWorkerSelection,
  workerFromPreference
} from '../src/shared/routine-delegation'

// Issue #178: "Delegate routine work cheaply" configures a Codex session's subagent defaults per
// Toucan session through CODEX_CONFIG, without touching the user's global provider configuration.
// Issue #179: the same preference carries a named routine worker into Claude sessions through the
// adapter's session-scoped SDK options, again without touching user-wide settings.

test('the preference validator accepts what the workspace may store and nothing looser', () => {
  assert.equal(isRoutineDelegationPreference({ enabled: true }), true)
  assert.equal(isRoutineDelegationPreference({ enabled: false, codexWorkerModelId: 'gpt-5.6-luna' }), true)
  assert.equal(isRoutineDelegationPreference({ enabled: true, claudeWorkerModelId: 'haiku' }), true)
  assert.equal(isRoutineDelegationPreference({ enabled: 'yes' }), false)
  assert.equal(isRoutineDelegationPreference({ codexWorkerModelId: 'gpt-5.6-luna' }), false)
  assert.equal(isRoutineDelegationPreference({ enabled: true, codexWorkerModelId: 5 }), false)
  assert.equal(isRoutineDelegationPreference({ enabled: true, claudeWorkerModelId: 5 }), false)
  assert.equal(isRoutineDelegationPreference(null), false)
  assert.equal(isRoutineDelegationPreference([]), false)
})

test('each provider resolves its own worker, falling back to its own default', () => {
  assert.equal(workerFromPreference('codex', { enabled: true }).id, CODEX_WORKER_MODELS[0].id)
  assert.equal(workerFromPreference('claude', { enabled: true }).id, CLAUDE_WORKER_MODELS[0].id)
  assert.equal(
    workerFromPreference('codex', { enabled: true, codexWorkerModelId: 'made-up-model' }).id,
    CODEX_WORKER_MODELS[0].id
  )
  // A Codex choice never leaks into the Claude worker, and vice versa.
  assert.equal(
    workerFromPreference('claude', { enabled: true, codexWorkerModelId: 'gpt-5.6-luna' }).id,
    CLAUDE_WORKER_MODELS[0].id
  )
})

test("selecting a worker for one provider preserves the other provider's choice (issue #179)", () => {
  const both = withWorkerSelection({ enabled: true, codexWorkerModelId: 'gpt-5.6-luna' }, 'claude', 'haiku')
  assert.deepEqual(both, { enabled: true, codexWorkerModelId: 'gpt-5.6-luna', claudeWorkerModelId: 'haiku' })
  // Turning delegation off keeps both choices so re-enabling restores them.
  const off = withWorkerSelection(both, 'codex', undefined)
  assert.deepEqual(off, { enabled: false, codexWorkerModelId: 'gpt-5.6-luna', claudeWorkerModelId: 'haiku' })
})

test("a disabled preference yields no delegation request; an enabled one names the provider's worker", () => {
  assert.equal(routineDelegationRequest('codex', { enabled: false }), undefined)
  assert.equal(routineDelegationRequest('claude', { enabled: false }), undefined)
  const codex = routineDelegationRequest('codex', { enabled: true })
  assert.deepEqual(codex, { workerModelId: CODEX_WORKER_MODELS[0].id, workerEffortId: CODEX_WORKER_MODELS[0].effortId })
  // Haiku advertises no effort levels, so the Claude request carries none rather than inventing one.
  const claude = routineDelegationRequest('claude', { enabled: true, claudeWorkerModelId: 'haiku' })
  assert.deepEqual(claude, { workerModelId: 'haiku' })
})

test('a worker missing from the account model list withholds configuration and says why', () => {
  const request = { workerModelId: 'gpt-5.6-luna', workerEffortId: 'low' }
  const applied = appliedCodexDelegation(request, ['gpt-6-astra', 'gpt-5.5'])
  assert.equal(applied.status, 'unavailable')
  assert.match(applied.message ?? '', /gpt-5\.6-luna/)
  // No cache to consult means configure and stay honest at the UI ("unverified"), not refuse.
  assert.equal(appliedCodexDelegation(request, undefined).status, 'configured')
  assert.equal(appliedCodexDelegation(request, ['gpt-5.6-luna']).status, 'configured')
})

test('the Claude worker is withheld when the session does not list it or the environment forces every subagent model', () => {
  const request = { workerModelId: 'haiku' }
  assert.equal(appliedClaudeDelegation(request, undefined, {}).status, 'configured')
  assert.equal(appliedClaudeDelegation(request, ['default', 'sonnet', 'haiku'], {}).status, 'configured')
  const missing = appliedClaudeDelegation(request, ['default', 'opus[1m]', 'sonnet'], {})
  assert.equal(missing.status, 'unavailable')
  assert.match(missing.message ?? '', /does not list haiku/)
  // CLAUDE_CODE_SUBAGENT_MODEL_FORCE makes the CLI ignore every agent-definition model, so the
  // worker would silently run on whatever the environment dictates: withhold instead.
  const forced = appliedClaudeDelegation(request, ['haiku'], { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' })
  assert.equal(forced.status, 'unavailable')
  assert.match(forced.message ?? '', /CLAUDE_CODE_SUBAGENT_MODEL_FORCE/)
  // The plain override variable does not outrank a named agent's model, so it is no reason to withhold.
  assert.equal(appliedClaudeDelegation(request, ['haiku'], { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' }).status, 'configured')
})

test('the Codex config carries native limits and a developer-priority instruction', () => {
  const config = codexDelegationConfig({ workerModelId: 'gpt-5.6-luna', workerEffortId: 'low' })
  const agents = config.agents as Record<string, unknown>
  assert.equal(agents.default_subagent_model, 'gpt-5.6-luna')
  assert.equal(agents.default_subagent_reasoning_effort, 'low')
  assert.equal(agents.max_concurrent_threads_per_session, 2)
  assert.equal(agents.max_depth, 1)
  const instruction = config.developer_instructions as string
  // The instruction is the application boundary: what may be delegated, what stays with main,
  // the fresh compact brief, and the failure rules.
  assert.match(instruction, /spawn_agent/)
  assert.match(instruction, /Omit the model parameter/)
  assert.match(instruction, /fresh, self-contained brief/)
  assert.match(instruction, /stop conditions/)
  assert.match(instruction, /do not assign code edits/)
  assert.match(instruction, /no autonomous retry loops/)
  assert.match(instruction, /never silently reassign the task to a more expensive worker/)
  assert.match(instruction, /at most two routine workers/)
})

test('the Claude session meta names one routine worker and appends the routing instruction', () => {
  const meta = claudeDelegationSessionMeta({ workerModelId: 'haiku' })
  const agents = meta.claudeCode.options.agents
  const worker = agents[CLAUDE_ROUTINE_WORKER_NAME]
  assert.ok(worker)
  assert.deepEqual(Object.keys(agents), [CLAUDE_ROUTINE_WORKER_NAME])
  // The pin rides on the named definition (the module header explains why no environment variable).
  assert.equal(worker.model, 'haiku')
  // Native recursion bar: the worker has no Agent tool; native edit bar: no Edit/Write tools.
  assert.ok(!worker.tools.includes('Agent') && !worker.tools.includes('Task'))
  assert.ok(!worker.tools.includes('Edit') && !worker.tools.includes('Write'))
  assert.match(worker.prompt, /never edit files/i)
  assert.match(worker.prompt, /stop/i)
  // The parent's instruction is a system-prompt append, so no worker text lands in the transcript.
  assert.equal(meta.systemPrompt.type, 'preset')
  assert.equal(meta.systemPrompt.preset, 'claude_code')
  const instruction = meta.systemPrompt.append
  assert.match(instruction, new RegExp(`subagent_type "${CLAUDE_ROUTINE_WORKER_NAME}"`))
  assert.match(instruction, /Omit the model parameter/)
  assert.match(instruction, /fresh, self-contained brief/)
  assert.match(instruction, /do not assign code edits/)
  assert.match(instruction, /at most two routine workers/)
  assert.match(instruction, /never silently reassign the task to a more expensive worker/)
})

test('CODEX_CONFIG is layered, never clobbered: unrelated keys and user instructions survive', () => {
  const worker = { workerModelId: 'gpt-5.6-luna', workerEffortId: 'low' }
  const environment = withCodexDelegationEnvironment(
    {
      PATH: 'C:/somewhere',
      CODEX_CONFIG: JSON.stringify({
        developer_instructions: 'House rule: answer in haiku.',
        agents: { job_max_runtime_seconds: 600 },
        model_verbosity: 'low'
      })
    },
    worker
  )
  const merged = JSON.parse(environment.CODEX_CONFIG as string) as Record<string, unknown>
  assert.equal(merged.model_verbosity, 'low')
  const agents = merged.agents as Record<string, unknown>
  assert.equal(agents.job_max_runtime_seconds, 600)
  assert.equal(agents.default_subagent_model, 'gpt-5.6-luna')
  const instructions = merged.developer_instructions as string
  assert.ok(instructions.startsWith('House rule: answer in haiku.'))
  assert.match(instructions, /Delegate routine work cheaply/)
  assert.equal(environment.PATH, 'C:/somewhere')
})

test('an absent or unparseable CODEX_CONFIG still yields a valid delegation config', () => {
  const worker = { workerModelId: 'gpt-5.6-luna', workerEffortId: 'low' }
  for (const initial of [undefined, '{not json']) {
    const environment = withCodexDelegationEnvironment(initial === undefined ? {} : { CODEX_CONFIG: initial }, worker)
    const merged = JSON.parse(environment.CODEX_CONFIG as string) as Record<string, unknown>
    assert.equal((merged.agents as Record<string, unknown>).default_subagent_model, 'gpt-5.6-luna')
  }
})
