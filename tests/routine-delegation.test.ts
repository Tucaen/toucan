import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  CODEX_WORKER_MODELS,
  DEFAULT_CODEX_WORKER_MODEL_ID,
  appliedCodexDelegation,
  codexDelegationConfig,
  codexWorkerFromPreference,
  isRoutineDelegationPreference,
  routineDelegationRequest,
  withCodexDelegationEnvironment
} from '../src/shared/routine-delegation'

// Issue #178: "Delegate routine work cheaply" configures a Codex session's subagent defaults per
// Toucan session through CODEX_CONFIG, without touching the user's global provider configuration.

test('the preference validator accepts what the workspace may store and nothing looser', () => {
  assert.equal(isRoutineDelegationPreference({ enabled: true }), true)
  assert.equal(isRoutineDelegationPreference({ enabled: false, codexWorkerModelId: 'gpt-5.6-luna' }), true)
  assert.equal(isRoutineDelegationPreference({ enabled: 'yes' }), false)
  assert.equal(isRoutineDelegationPreference({ codexWorkerModelId: 'gpt-5.6-luna' }), false)
  assert.equal(isRoutineDelegationPreference({ enabled: true, codexWorkerModelId: 5 }), false)
  assert.equal(isRoutineDelegationPreference(null), false)
  assert.equal(isRoutineDelegationPreference([]), false)
})

test('an absent or unknown worker id falls back to the default worker', () => {
  assert.equal(codexWorkerFromPreference({ enabled: true }).id, DEFAULT_CODEX_WORKER_MODEL_ID)
  assert.equal(
    codexWorkerFromPreference({ enabled: true, codexWorkerModelId: 'made-up-model' }).id,
    DEFAULT_CODEX_WORKER_MODEL_ID
  )
})

test('a disabled preference yields no delegation request at all', () => {
  assert.equal(routineDelegationRequest({ enabled: false }), undefined)
  const request = routineDelegationRequest({ enabled: true })
  assert.ok(request)
  assert.equal(request.workerModelId, DEFAULT_CODEX_WORKER_MODEL_ID)
  assert.equal(request.workerEffortId, CODEX_WORKER_MODELS[0].effortId)
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
