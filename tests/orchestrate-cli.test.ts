import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'vitest'
import type { DiscardTarget } from '../src/main/orchestration-cleanup'
import { createOrchestrationStore } from '../src/main/orchestration-store'
import {
  createOrchestratorEndpoint,
  type OrchestratorGrant,
  type TicketSessionControl,
  type TicketSessionState
} from '../src/main/orchestrator-endpoint'
import type { UnrecordedAttempt } from '../src/shared/orchestration-cleanup'
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

async function harness({ liveSessions = false }: { liveSessions?: boolean } = {}) {
  const calls: TicketSpawnRequest[] = []
  const cleanupCalls: Array<string | undefined> = []
  const mergeCalls: Array<{ ticket: string; tested: string }> = []
  const unrecorded: UnrecordedAttempt[] = []
  const discards: DiscardTarget[] = []
  const stops: string[] = []
  const live = new Map<string, TicketSessionState>()
  const records = createOrchestrationStore({ directory: mkdtempSync(join(tmpdir(), 'toucan-orchestrate-cli-')) })
  const endpoint = createOrchestratorEndpoint({
    records,
    // Only the cases that need the duplicate guard or a discard run with live sessions: elsewhere an
    // absent control keeps `status`, `outcome` and `followup` on their no-session answers.
    ...(liveSessions
      ? {
          ticketSessions: {
            state: (nodeId: string) => live.get(nodeId),
            stop: (nodeId: string) => void stops.push(nodeId)
          } as unknown as TicketSessionControl
        }
      : {}),
    merge: {
      run: async (_record, ticket, tested) => {
        mergeCalls.push({ ticket: ticket.id, tested })
        return { ok: true, commit: tested, upstream: 'origin/main' }
      }
    },
    cleanup: {
      run: async (_record, ticketId) => {
        cleanupCalls.push(ticketId)
        return { removed: [{ ticket: ticketId ?? '34' }], retained: [] }
      },
      answeredRefusal: async () => undefined,
      unrecorded: async () => unrecorded,
      discard: async (_record, target) => {
        discards.push(target)
        return { ok: true, removedWorktree: true, deletedBranch: true, ahead: 2 }
      }
    },
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
  return {
    endpoint,
    grant,
    calls,
    cleanupCalls,
    mergeCalls,
    unrecorded,
    discards,
    stops,
    live,
    environment: grant.environment
  }
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

test('usage reaches the endpoint and rejects flags or positional arguments', async () => {
  const { endpoint, environment } = await harness()
  try {
    const result = await run(['usage'], environment)
    assert.equal(result.code, 1)
    assert.match(result.output.error ?? '', /provider usage/)
    assert.equal((await run(['usage', '--force'], environment)).code, 2)
    assert.equal((await run(['usage', 'now'], environment)).code, 2)
  } finally {
    await endpoint.close()
  }
})

test('cleanup runs globally or for one ticket and rejects invalid selectors', async () => {
  const { endpoint, environment, cleanupCalls } = await harness()
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
    const scoped = await run(['cleanup', '--ticket', '34'], environment)
    assert.equal(scoped.code, 0)
    assert.deepEqual(scoped.output.removed, [{ ticket: '34' }])
    assert.deepEqual(cleanupCalls, [undefined, '34'])
    const unknown = await run(['cleanup', '--ticket', 'missing'], environment)
    assert.equal(unknown.code, 1)
    assert.match(unknown.output.error ?? '', /no ticket/)
    assert.equal((await run(['cleanup', '--force'], environment)).code, 2)
    assert.equal((await run(['cleanup', '--ticket'], environment)).code, 2)
  } finally {
    await endpoint.close()
  }
})

test('merge sends --ticket and --tested and needs both', async () => {
  const { endpoint, environment, mergeCalls, cleanupCalls } = await harness()
  try {
    await run(
      [
        'plan',
        'set',
        '--json',
        JSON.stringify({ task: 'Merge', targetBranch: 'main', tickets: [{ id: '34', title: 'Merge' }] })
      ],
      environment
    )
    const merged = await run(['merge', '--ticket', '34', '--tested', 'abc1234'], environment)
    assert.equal(merged.code, 0)
    assert.equal(merged.output.commit, 'abc1234')
    assert.deepEqual(merged.output.cleanup, { removed: [{ ticket: '34' }], retained: [] })
    assert.deepEqual(mergeCalls, [{ ticket: '34', tested: 'abc1234' }])
    assert.deepEqual(cleanupCalls, ['34'])
    assert.equal((await run(['merge', '--ticket', '34'], environment)).code, 2)
    assert.equal((await run(['merge', '--tested', 'abc1234'], environment)).code, 2)
    assert.equal((await run(['merge', '--ticket', '34', '--tested', 'abc1234', 'extra'], environment)).code, 2)
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
    assert.match(refused.output.error ?? '', /must match its orchestrator/)

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

test('spawn --force is a switch that needs --reason', async () => {
  const { endpoint, environment, calls } = await harness()
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
    const spawn34 = ['spawn', '--ticket', '34', '--model', 'm', '--effort', 'high', '--force']
    const bare = await run(spawn34, environment)
    assert.equal(bare.code, 1)
    assert.match(bare.output.error ?? '', /--force needs --reason/)
    assert.equal(calls.length, 0)
    const forced = await run([...spawn34, '--reason', 'the user asked'], environment)
    assert.equal(forced.code, 0)
    assert.equal((forced.output.forced as { reason: string }).reason, 'the user asked')
    assert.equal(calls.length, 1)
    assert.equal((await run(['spawn', '--ticket', '34', '--force', '--force'], environment)).code, 2)
  } finally {
    await endpoint.close()
  }
})

const planOf = (...ids: string[]): string[] => [
  'plan',
  'set',
  '--json',
  JSON.stringify({ task: 't', targetBranch: 'main', tickets: ids.map((id) => ({ id, title: `Ticket ${id}` })) })
]

test('spawn refuses a duplicate of a live attempt and --replace stops it first (#2)', async () => {
  const { endpoint, environment, calls, stops, live } = await harness({ liveSessions: true })
  try {
    await run(planOf('34'), environment)
    const spawn34 = ['spawn', '--ticket', '34', '--model', 'm', '--effort', 'high']
    assert.equal((await run(spawn34, environment)).code, 0)
    live.set('ticket-node', { status: 'working', questions: [] })

    const duplicate = await run(spawn34, environment)
    assert.equal(duplicate.code, 1)
    assert.equal(duplicate.output.duplicate, true)
    assert.match(duplicate.output.error ?? '', /--replace/)
    assert.deepEqual([calls.length, stops.length], [1, 0])

    const replaced = await run([...spawn34, '--replace'], environment)
    assert.equal(replaced.code, 0)
    assert.deepEqual([calls.length, stops], [2, ['ticket-node']])
    assert.equal((await run([...spawn34, '--replace', '--replace'], environment)).code, 2)
  } finally {
    await endpoint.close()
  }
})

test('spawn --adopt links an unrecorded worktree and takes no other spawn flag (#4)', async () => {
  const { endpoint, environment, calls, unrecorded } = await harness({ liveSessions: true })
  try {
    await run(planOf('34'), environment)
    unrecorded.push({ ticket: '34', path: 'D:\\w34', branch: 'ticket/34', ahead: 1, liveSession: false })

    const mixed = await run(['spawn', '--ticket', '34', '--adopt', 'D:\\w34', '--model', 'm'], environment)
    assert.equal(mixed.code, 1)
    assert.match(mixed.output.error ?? '', /spawn --adopt takes only/)
    assert.equal((await run(['spawn', '--adopt', 'D:\\w34'], environment)).code, 1)
    assert.equal((await run(['spawn', '--ticket', '34', '--adopt'], environment)).code, 2)

    const adopted = await run(['spawn', '--ticket', '34', '--adopt', 'D:\\w34'], environment)
    assert.equal(adopted.code, 0)
    assert.deepEqual([adopted.output.adopted, adopted.output.attempt, calls.length], [true, 1, 0])
    assert.equal((adopted.output.session as { worktreePath: string }).worktreePath, 'D:\\w34')

    const status = await run(['status'], environment)
    assert.deepEqual(status.output.unrecorded, unrecorded)
  } finally {
    await endpoint.close()
  }
})

test('discard throws a recorded attempt away by number, an unrecorded one by branch (#4)', async () => {
  const { endpoint, environment, discards, unrecorded } = await harness({ liveSessions: true })
  try {
    await run(planOf('34'), environment)
    await run(['spawn', '--ticket', '34', '--model', 'm', '--effort', 'high'], environment)

    const missing = await run(['discard', '--ticket', '34', '--attempt', '2'], environment)
    assert.equal(missing.code, 1)
    assert.match(missing.output.error ?? '', /no attempt 2/)

    const discarded = await run(['discard', '--ticket', '34', '--attempt', '1'], environment)
    assert.equal(discarded.code, 0)
    assert.deepEqual(
      [discarded.output.attempt, discarded.output.branch, discarded.output.discardedCommits],
      [1, 'ticket/34', 2]
    )
    assert.deepEqual(
      discards.map((target) => [target.ticket, target.branch, target.worktreePath]),
      [['34', 'ticket/34', 'D:\\w']]
    )
    const again = await run(['discard', '--ticket', '34', '--attempt', '1'], environment)
    assert.equal(again.code, 1)
    assert.match(again.output.error ?? '', /already discarded/)

    const unknown = await run(['discard', '--branch', 'ticket/99-nothing'], environment)
    assert.equal(unknown.code, 1)
    assert.match(unknown.output.error ?? '', /not an unrecorded attempt/)
    unrecorded.push({ ticket: '35', branch: 'ticket/35-lost', ahead: 3, liveSession: false })
    const byBranch = await run(['discard', '--branch', 'ticket/35-lost'], environment)
    assert.equal(byBranch.code, 0)
    assert.equal(discards[discards.length - 1].branch, 'ticket/35-lost')
  } finally {
    await endpoint.close()
  }
})

test('discard needs --ticket with --attempt, or --branch alone', async () => {
  const { endpoint, environment, discards } = await harness()
  try {
    for (const args of [
      ['discard'],
      ['discard', '--ticket', '34'],
      ['discard', '--attempt', '1'],
      ['discard', '--branch', 'ticket/34', '--ticket', '34'],
      ['discard', '--branch', 'ticket/34', '--attempt', '1'],
      ['discard', '34', '--attempt', '1'],
      ['discard', '--ticket', '34', '--attempt', '1', '--attempt', '2'],
      ['discard', '--force']
    ]) {
      assert.equal((await run(args, environment)).code, 2, args.join(' '))
    }
    assert.equal(discards.length, 0)
  } finally {
    await endpoint.close()
  }
})

test('question add, resolve and list reach the endpoint; add reads the markdown verbatim from --file (#2)', async () => {
  const { endpoint, environment } = await harness()
  const markdown = 'Which one?\n\n![shot](file:///D:/Development/toucan/.toucan-scratch/a%20b.png)\n'
  const file = join(mkdtempSync(join(tmpdir(), 'toucan-orchestrate-cli-question-')), 'question.md')
  writeFileSync(file, markdown)
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
    const added = await run(['question', 'add', '--ticket', '34', '--file', file], environment)
    assert.deepEqual([added.code, added.lines], [0, 1])
    const question = added.output.question as { id: string; ticketId: string; markdown: string }
    assert.deepEqual([question.id, question.ticketId, question.markdown], ['Q1', '34', markdown])
    const text = await run(['question', 'add', '--text', 'General?'], environment)
    assert.equal((text.output.question as { id: string }).id, 'Q2')

    const resolved = await run(['question', 'resolve', '--id', 'Q1', '--note', 'the left one'], environment)
    assert.equal(resolved.code, 0)
    assert.equal((resolved.output.question as { resolution: string }).resolution, 'the left one')
    const open = await run(['question', 'list'], environment)
    assert.deepEqual(
      (open.output.questions as { id: string }[]).map((entry) => entry.id),
      ['Q2']
    )
    const all = await run(['question', 'list', '--all'], environment)
    assert.equal((all.output.questions as unknown[]).length, 2)

    const choices = await run(
      [
        'question',
        'add',
        '--ticket',
        '34',
        '--text',
        'Left or right?',
        '--options',
        '["Left",{"label":"Right"}]',
        '--multi'
      ],
      environment
    )
    assert.equal(choices.code, 0)
    const picked = choices.output.question as { options: unknown[]; multiSelect: boolean }
    assert.deepEqual([picked.options, picked.multiSelect], [[{ label: 'Left' }, { label: 'Right' }], true])
    const optionsFile = join(dirname(file), 'options.json')
    writeFileSync(optionsFile, JSON.stringify([{ label: 'Yes', description: 'go' }]))
    const fromFile = await run(['question', 'add', '--text', 'Go?', '--options-file', optionsFile], environment)
    assert.deepEqual((fromFile.output.question as { options: unknown[] }).options, [
      { label: 'Yes', description: 'go' }
    ])
    for (const args of [
      ['--text', 'a', '--options', '["A"]', '--options-file', optionsFile],
      ['--text', 'a', '--options', 'not json'],
      ['--text', 'a', '--options-file', join(tmpdir(), 'missing-options.json')],
      ['--text', 'a', '--multi']
    ]) {
      assert.equal((await run(['question', 'add', ...args], environment)).code, 2, args.join(' '))
    }
    // The endpoint's own validation answers a well-formed flag with bad content.
    assert.equal((await run(['question', 'add', '--text', 'a', '--options', '[]'], environment)).code, 1)

    assert.equal((await run(['question', 'add', '--text', 'a', '--file', file], environment)).code, 2)
    assert.equal((await run(['question', 'add'], environment)).code, 2)
    assert.equal((await run(['question', 'add', '--file', join(tmpdir(), 'missing-question.md')], environment)).code, 2)
    assert.equal((await run(['question', 'resolve'], environment)).code, 2)
    assert.equal((await run(['question', 'list', 'extra'], environment)).code, 2)
    assert.equal((await run(['question', 'ask'], environment)).code, 2)
    // --full is a switch: the harness has no ticket-session control, so Toucan refuses after it was sent.
    const full = await run(['outcome', '--ticket', '34', '--full'], environment)
    assert.equal(full.code, 1)
    assert.match(full.output.error ?? '', /no ticket session|outcome/)
  } finally {
    await endpoint.close()
  }
})
