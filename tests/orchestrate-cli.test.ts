import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createOrchestrationStore } from '../src/main/orchestration-store'
import { createOrchestratorEndpoint, type OrchestratorGrant } from '../src/main/orchestrator-endpoint'
import type { TicketSpawnRequest } from '../src/main/ticket-spawner'
import { PROJECT_SKILLS_DIRECTORY } from '../src/shared/project-skills'
import { ORCHESTRATE_CLI_PATH, ORCHESTRATOR_TOKEN_ENV, ORCHESTRATOR_URL_ENV } from '../src/shared/orchestration'

// The orchestrator's CLI (#33, #34): a thin client that finds the endpoint and token in its
// environment, prints one JSON line per call, and fails clearly when either is missing - which is
// what a ticket session, which carries no token, gets when it tries to spawn.

const cli = join(process.cwd(), PROJECT_SKILLS_DIRECTORY, ...ORCHESTRATE_CLI_PATH)

interface Run {
  code: number
  output: { ok: boolean; error?: string; [key: string]: unknown }
  lines: number
}

function run(args: string[], environment: Record<string, string | undefined>): Promise<Run> {
  const env = { ...process.env, ...environment }
  for (const key of [ORCHESTRATOR_URL_ENV, ORCHESTRATOR_TOKEN_ENV]) if (environment[key] === undefined) delete env[key]
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { env }, (error, stdout) => {
      const lines = stdout.trim().split(/\r?\n/)
      resolve({
        code: error ? Number((error as { code?: number }).code ?? 1) : 0,
        output: JSON.parse(lines[lines.length - 1]) as Run['output'],
        lines: lines.length
      })
    })
  })
}

async function harness() {
  const calls: TicketSpawnRequest[] = []
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-orchestrate-cli-')) })
  const endpoint = createOrchestratorEndpoint({
    records,
    cleanup: { run: async () => ({ removed: [{ ticket: '34' }], retained: [] }) },
    spawner: {
      async spawn(request) {
        calls.push(request)
        return {
          ok: true,
          session: {
            nodeId: 'ticket-node',
            conversationId: 'ticket-conversation',
            worktreePath: 'D:\\w',
            branch: 'ticket/34'
          },
          model: request.model,
          effort: request.effort,
          warnings: []
        }
      }
    }
  })
  const grant = (await endpoint.grant('orchestrator-1', {
    provider: 'claude',
    projectPath: 'D:\\project'
  })) as OrchestratorGrant
  grant.setConversation('conversation-1')
  return { endpoint, grant, calls, environment: grant.environment }
}

test('without an orchestrator environment the CLI refuses clearly and calls nothing', async () => {
  const missing = await run(['plan', 'show'], {})
  assert.equal(missing.code, 2)
  assert.equal(missing.lines, 1)
  assert.equal(missing.output.ok, false)
  assert.match(missing.output.error ?? '', /TOUCAN_ORCHESTRATOR_URL/)
  assert.match(missing.output.error ?? '', /orchestrator/)

  const noToken = await run(['spawn', '--ticket', '34', '--model', 'm', '--effort', 'e'], {
    [ORCHESTRATOR_URL_ENV]: 'http://127.0.0.1:9/orchestrate'
  })
  assert.equal(noToken.code, 2)
  assert.match(noToken.output.error ?? '', /TOUCAN_ORCHESTRATOR_TOKEN/)
})

test('report reaches the endpoint and takes no arguments (#40)', async () => {
  const { endpoint, environment } = await harness()
  try {
    const result = await run(['report'], environment)
    assert.deepEqual([result.code, result.lines, result.output.ok], [0, 1, true])
    assert.deepEqual([result.output.jev, result.output.proposals, result.output.orchestrations], [[], [], 0])
    assert.equal((await run(['report', '--apply'], environment)).code, 2)
  } finally {
    await endpoint.close()
  }
})

test('cleanup runs through the scoped endpoint and rejects extra arguments', async () => {
  const { endpoint, environment } = await harness()
  try {
    const missing = await run(['cleanup'], environment)
    assert.equal(missing.code, 1)
    assert.match(missing.output.error ?? '', /plan/)
    await run(
      [
        'plan',
        'set',
        '--json',
        JSON.stringify({ task: 'Done', targetBranch: 'main', tickets: [{ id: '34', title: 'Done' }] })
      ],
      environment
    )
    const result = await run(['cleanup'], environment)
    assert.equal(result.code, 0)
    assert.deepEqual(result.output.removed, [{ ticket: '34' }])
    assert.equal((await run(['cleanup', '--force'], environment)).code, 2)
  } finally {
    await endpoint.close()
  }
})

test('plan set, plan show, ticket update and spawn each print one JSON line', async () => {
  const { endpoint, environment, calls } = await harness()
  try {
    const planFile = join(mkdtempSync(join(tmpdir(), 'toucan-orchestrate-plan-')), 'plan.json')
    writeFileSync(
      planFile,
      JSON.stringify({ task: 'Ship it', targetBranch: 'main', tickets: [{ id: '34', title: 'Spawn', body: 'Do it' }] })
    )
    const set = await run(['plan', 'set', '--file', planFile], environment)
    assert.deepEqual([set.code, set.lines, set.output.ok], [0, 1, true])

    const updated = await run(['ticket', 'update', '34', '--json', '{"attempts":1}'], environment)
    assert.equal(updated.code, 0)
    assert.equal((updated.output.ticket as { attempts: number }).attempts, 1)

    const spawned = await run(
      ['spawn', '--ticket', '34', '--model', 'claude-opus-5-5', '--effort', 'high'],
      environment
    )
    assert.deepEqual([spawned.code, spawned.lines, spawned.output.ok], [0, 1, true])
    assert.equal(spawned.output.model, 'claude-opus-5-5')
    assert.equal(calls[0]?.ticket.id, '34')

    const shown = await run(['plan', 'show'], environment)
    const record = shown.output.record as { tickets: { session?: { nodeId: string } }[]; spawnCount: number }
    assert.equal(record.tickets[0].session?.nodeId, 'ticket-node')
    assert.equal(record.spawnCount, 1)
  } finally {
    await endpoint.close()
  }
})

test('a refusal from Toucan is printed as it came and exits non-zero', async () => {
  const { endpoint, environment } = await harness()
  try {
    const refused = await run(
      ['spawn', '--ticket', '34', '--model', 'm', '--effort', 'e', '--provider', 'codex'],
      environment
    )
    assert.equal(refused.code, 1)
    assert.equal(refused.output.ok, false)
    assert.match(refused.output.error ?? '', /Claude/)

    const wrongToken = await run(['plan', 'show'], { ...environment, [ORCHESTRATOR_TOKEN_ENV]: 'guess' })
    assert.equal(wrongToken.code, 1)
    assert.match(wrongToken.output.error ?? '', /token/)

    const unknown = await run(['merge'], environment)
    assert.equal(unknown.code, 2)
    assert.match(unknown.output.error ?? '', /usage/i)
  } finally {
    await endpoint.close()
  }
})

test('status, outcome and followup reach the endpoint with their flags', async () => {
  const { endpoint, environment } = await harness()
  try {
    await run(
      [
        'plan',
        'set',
        '--json',
        JSON.stringify({ task: 't', targetBranch: 'main', tickets: [{ id: '34', title: 'Spawn' }] })
      ],
      environment
    )
    await run(['spawn', '--ticket', '34', '--model', 'm', '--effort', 'high'], environment)

    const status = await run(['status'], environment)
    assert.deepEqual([status.code, status.lines, status.output.ok], [0, 1, true])
    assert.equal((status.output.tickets as { state: string }[])[0].state, 'not running')

    // The harness has no ticket-session control, so both are refused by Toucan - after the CLI sent them.
    const outcome = await run(['outcome', '--ticket', '34'], environment)
    assert.equal(outcome.code, 1)
    assert.match(outcome.output.error ?? '', /outcome/)
    const followup = await run(['followup', '--ticket', '34', '--text', 'Also cover the empty case'], environment)
    assert.equal(followup.code, 1)
    assert.match(followup.output.error ?? '', /ticket sessions/)

    assert.equal((await run(['followup', '--ticket', '34'], environment)).code, 2)
    assert.equal((await run(['outcome'], environment)).code, 2)
    assert.equal((await run(['status', 'extra'], environment)).code, 2)
  } finally {
    await endpoint.close()
  }
})

test('route, escalate and spawn --tier reach the endpoint with their flags (#36)', async () => {
  const { endpoint, environment } = await harness()
  try {
    await run(
      [
        'plan',
        'set',
        '--json',
        JSON.stringify({ task: 't', targetBranch: 'main', tickets: [{ id: '34', title: 'Spawn' }] })
      ],
      environment
    )
    // The harness wires no routing, so Toucan refuses each - after the CLI sent it.
    const route = await run(['route'], environment)
    assert.equal(route.code, 1)
    assert.match(route.output.error ?? '', /cannot route/)
    const own = await run(['route', '--ticket', '34', '--tier', 'medium'], environment)
    assert.match(own.output.error ?? '', /cannot route/)
    const escalate = await run(['escalate', '--ticket', '34'], environment)
    assert.match(escalate.output.error ?? '', /cannot route/)
    const byTier = await run(['spawn', '--ticket', '34', '--tier', 'high'], environment)
    assert.match(byTier.output.error ?? '', /cannot route by tier/)

    assert.equal((await run(['route', 'extra'], environment)).code, 2)
    assert.equal((await run(['escalate'], environment)).code, 2)
  } finally {
    await endpoint.close()
  }
})
