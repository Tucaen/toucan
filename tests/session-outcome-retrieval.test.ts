import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { WebContents } from 'electron'
import { createAcpSessionManager, withClaudeDelegation, withSessionInstruction } from '../src/main/acp-session-manager'
import type { AgentProcessLaunch } from '../src/main/agent-process'
import { createSessionOutcomeStore } from '../src/main/session-outcome-store'
import type { AgentEvent } from '../src/shared/agent'
import { foldAgentEvent, initialAgentTranscriptState, type AgentTranscriptState } from '../src/shared/agent-transcript'
import { withCodexSessionConfig } from '../src/shared/codex-config'
import {
  SESSION_OUTCOME_FAILURE_LIMIT,
  SESSION_OUTCOME_FILES_LIMIT,
  SESSION_OUTCOME_SCREENFUL,
  SESSION_OUTCOME_SIZE_BUDGET,
  extractSessionOutcome,
  renderSessionOutcome,
  sessionOutcomeIndexInstruction,
  type SessionOutcomeRecord
} from '../src/shared/session-outcome'
import { installScriptedAdapter } from './helpers/scripted-adapter'

// Issue #190: agent retrieval. A later session reads the index with the tools it already has - the
// outcomes directory is granted through the same `additionalDirectories` sandbox mechanism a
// brain-dump capture uses, and a short pointer on the session's own context says it exists. No new
// IPC, no new tool, and the read has to stay cheap enough to always be worth making.

const OWNER = { isDestroyed: () => false, send: () => {} } as unknown as WebContents
const OUTCOMES = 'C:\\Users\\Ada\\AppData\\Roaming\\toucan\\session-outcomes'
const AT = '2026-09-13T10:00:00.000Z'
const NOW = 1_700_000_000_000

function transcript(...events: AgentEvent[]): AgentTranscriptState {
  return events.reduce((state, event) => foldAgentEvent(state, event, NOW), initialAgentTranscriptState())
}

function user(messageId: string, text: string): AgentEvent {
  return { type: 'message', role: 'user', messageId, text }
}

function assistant(messageId: string, text: string): AgentEvent {
  return { type: 'message', role: 'assistant', messageId, text, presentation: 'final' }
}

test('the pointer names the directory, every field a record carries, and how to filter by project', () => {
  const instruction = sessionOutcomeIndexInstruction(OUTCOMES)

  assert.ok(instruction.includes(OUTCOMES))
  // The pointer is a description of `renderSessionOutcome`'s output, so every line that function
  // writes has to be findable from it - a field renamed on one side only would send every future
  // session grepping for something that is no longer there.
  const record = extractSessionOutcome(
    transcript(
      user('u1', 'Check the pointer against a real record.'),
      assistant('a1', 'Checked.'),
      { type: 'turn_failed', turnId: 't1', message: 'Typecheck failed.' },
      { type: 'turn_complete', stopReason: 'end_turn' }
    ),
    { provider: 'claude', conversationId: 'c-1', projectPath: 'D:\\Development\\ADE', worktreeId: 'wt-1' },
    null,
    AT
  )
  assert.ok(record)
  for (const line of renderSessionOutcome(record).split('\n')) {
    const field = /^([a-z]+): /.exec(line)?.[1] ?? /^(## .+)$/.exec(line)?.[1]
    if (field) assert.ok(instruction.includes(field), `the pointer never mentions ${field}`)
  }
  // Filtering by project is the convention that keeps the read cheap, and the JSON quoting is the
  // detail that makes a Windows path grep-able at all.
  assert.match(instruction, /project:/)
  assert.match(instruction, /backslashes are doubled/)
  // It rides on every session's context whether or not the index is ever read, so it stays short.
  assert.ok(instruction.length < 900, `the pointer grew to ${instruction.length} characters`)
})

test('a Toucan instruction appends to a session system prompt instead of replacing one', () => {
  const delegating = {
    _meta: {
      claudeCode: { options: { agents: {} } },
      systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: 'Delegate routine work.' }
    }
  }

  const both = withSessionInstruction(delegating, 'Read the outcome index.')

  assert.equal(both._meta?.systemPrompt?.append, 'Delegate routine work.\n\nRead the outcome index.')
  // The one `_meta` a session gets carries both concerns: the Claude options survive untouched.
  assert.deepEqual(both._meta?.claudeCode, delegating._meta.claudeCode)
  // And a session with nothing else to say carries the instruction alone, with no empty options bag.
  const alone = withSessionInstruction({ additionalDirectories: [OUTCOMES] }, 'Read the outcome index.')
  assert.deepEqual(alone, {
    additionalDirectories: [OUTCOMES],
    _meta: { systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Read the outcome index.' } }
  })
})

test('the delegation policy and the index pointer survive each other, layered in either order', () => {
  const worker = { workerModelId: 'haiku' }
  const pointer = sessionOutcomeIndexInstruction(OUTCOMES)

  const delegationFirst = withSessionInstruction(withClaudeDelegation({}, worker), pointer)
  const pointerFirst = withClaudeDelegation(withSessionInstruction({}, pointer), worker)

  // Both carry both, and the worker definition survives either way. The order only decides which
  // instruction is read first - not whether the other one is there at all, which is what an
  // assigning carrier would have made it decide.
  for (const configuration of [delegationFirst, pointerFirst]) {
    assert.ok(configuration._meta?.claudeCode?.options.agents)
    assert.match(configuration._meta?.systemPrompt?.append ?? '', /Delegate routine work cheaply/)
    assert.ok(configuration._meta?.systemPrompt?.append.includes(pointer))
  }
})

test("Codex session config layers instructions without dropping the user's own or a sibling key", () => {
  const environment = withCodexSessionConfig(
    { CODEX_CONFIG: JSON.stringify({ developer_instructions: 'Mind the house style.', agents: { max_depth: 1 } }) },
    { developer_instructions: 'Read the outcome index.', agents: { default_subagent_model: 'gpt-5.6-luna' } }
  )

  assert.deepEqual(JSON.parse(environment.CODEX_CONFIG ?? ''), {
    developer_instructions: 'Mind the house style.\n\nRead the outcome index.',
    agents: { max_depth: 1, default_subagent_model: 'gpt-5.6-luna' }
  })
})

test('a new Claude session is granted the outcomes directory and told the index exists', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-outcome-retrieval-'))
  const recordPath = join(appPath, 'requests.json')
  installScriptedAdapter(appPath, 'claude-agent-acp', {
    prelude: "const fs = require('node:fs')",
    handleRequest: `
  if (request.method === 'session/new' || request.method === 'session/load') {
    fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(request.params) + '\\n')
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'fresh-session' } })
  }`
  })
  const manager = createAcpSessionManager({
    appPath,
    environment: { PATH: process.env.PATH },
    sessionOutcomesDirectory: OUTCOMES
  })
  try {
    const result = await manager.create({ id: 'reader', provider: 'claude', cwd: appPath }, OWNER)
    assert.equal(result.status, 'ready')

    const params = JSON.parse(readFileSync(recordPath, 'utf8').trim()) as {
      additionalDirectories?: string[]
      _meta?: { systemPrompt?: { append?: string } }
    }
    // The grant is the whole of "no permission prompt": the folder lives under userData, outside
    // every project `cwd`, so without it a provider sandbox turns each read into a request.
    assert.deepEqual(params.additionalDirectories, [OUTCOMES])
    assert.equal(params._meta?.systemPrompt?.append, sessionOutcomeIndexInstruction(OUTCOMES))
  } finally {
    manager.killAll()
  }
})

test('a Codex session carries the same pointer as developer instructions at adapter launch', async () => {
  const appPath = mkdtempSync(join(tmpdir(), 'toucan-outcome-retrieval-codex-'))
  const recordPath = join(appPath, 'requests.json')
  installScriptedAdapter(appPath, 'codex-acp', {
    prelude: "const fs = require('node:fs')",
    handleRequest: `
  if (request.method === 'session/new') {
    fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(request.params) + '\\n')
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'fresh-session' } })
  }`
  })
  const launches: AgentProcessLaunch[] = []
  const manager = createAcpSessionManager({
    appPath,
    environment: { PATH: process.env.PATH },
    sessionOutcomesDirectory: OUTCOMES,
    spawnAgent: (launch) => {
      launches.push(launch)
      return spawn(launch.executable, launch.args, { ...launch.options, stdio: ['pipe', 'pipe', 'pipe'] })
    }
  })
  try {
    const result = await manager.create({ id: 'reader', provider: 'codex', cwd: appPath }, OWNER)
    assert.equal(result.status, 'ready')

    // Codex's sandbox is the one that would actually refuse the read, so it gets both halves: the
    // directory on the session and the pointer on the adapter process's own configuration.
    const params = JSON.parse(readFileSync(recordPath, 'utf8').trim()) as { additionalDirectories?: string[] }
    assert.ok(params.additionalDirectories?.includes(OUTCOMES))
    const config = JSON.parse(launches[0]?.options.env?.CODEX_CONFIG ?? '') as { developer_instructions?: string }
    assert.equal(config.developer_instructions, sessionOutcomeIndexInstruction(OUTCOMES))
  } finally {
    manager.killAll()
  }
})

/** A record of the size this repo's own conversations produce: a real ask, a real answer, a handful of files. */
function typicalRecord(index: number): SessionOutcomeRecord {
  const record = extractSessionOutcome(
    transcript(
      user(
        'u1',
        'Implement the agent-retrieval half of the session outcome index: sandbox the outcomes folder into new sessions and carry a short pointer on the session context.'
      ),
      assistant(
        'a1',
        'Granted the outcomes directory through additionalDirectories for both providers and appended the pointer to the Claude system prompt and the Codex developer instructions. Typecheck and the full suite pass.'
      ),
      { type: 'turn_failed', turnId: 'turn-3', message: 'Typecheck failed: 2 errors in session-outcome.ts.' },
      { type: 'turn_complete', stopReason: 'end_turn' }
    ),
    {
      provider: 'claude',
      conversationId: `019a2f3c-00${index}`,
      projectPath: 'D:\\Development\\ADE',
      filesTouched: Array.from({ length: 8 }, (_, file) => `src/main/session-outcome-indexer-${file}.ts`)
    },
    null,
    AT
  )
  assert.ok(record)
  return record
}

/** A record filled to every cap at once - the bound, not the expectation. */
function saturatedRecord(index: number): SessionOutcomeRecord {
  const record = extractSessionOutcome(
    transcript(
      user('u1', `Do this: ${'context '.repeat(400)}`),
      ...Array.from({ length: SESSION_OUTCOME_FAILURE_LIMIT }, (_, failure): AgentEvent => ({
        type: 'turn_failed',
        turnId: `turn-${'x'.repeat(30)}-${failure}`,
        message: 'stack frame '.repeat(80)
      })),
      assistant('a1', `Done: ${'detail '.repeat(400)}`),
      { type: 'turn_complete', stopReason: 'end_turn' }
    ),
    {
      provider: 'claude',
      conversationId: `019a2f3c-01${index}`,
      projectPath: 'D:\\Development\\ADE',
      worktreeId: 'wt-11',
      filesTouched: Array.from(
        { length: SESSION_OUTCOME_FILES_LIMIT * 4 },
        (_, file) => `src/${'deeply-nested/'.repeat(20)}file-${file}.ts`
      )
    },
    null,
    AT
  )
  assert.ok(record)
  return record
}

function screenful(build: (index: number) => SessionOutcomeRecord): number {
  return Array.from(
    { length: SESSION_OUTCOME_SCREENFUL },
    (_, index) => renderSessionOutcome(build(index)).length
  ).reduce((total, size) => total + size, 0)
}

test('a screenful of records costs little enough that consulting the index is always worth it', () => {
  // The measurement this ticket owns, in the unit that decides whether an agent should bother:
  // what it costs to read the records for one project. At roughly four characters per token a
  // typical screenful is about 5k tokens - cheaper than a single wrong re-exploration - and even
  // the pathological case, every record saturating every cap at once, stays under the ceiling of
  // twenty times the per-record budget. The caps were tightened against these numbers (#190).
  const typical = screenful(typicalRecord)
  const saturated = screenful(saturatedRecord)

  assert.ok(typical < 24_000, `a typical screenful grew to ${typical} bytes`)
  assert.ok(saturated < SESSION_OUTCOME_SCREENFUL * SESSION_OUTCOME_SIZE_BUDGET)
  assert.ok(saturated < 72_000, `a saturated screenful grew to ${saturated} bytes`)
  // The two-stage read the pointer teaches: naming the relevant files costs only their frontmatter.
  const frontmatterOnly = Array.from(
    { length: SESSION_OUTCOME_SCREENFUL },
    (_, index) => renderSessionOutcome(typicalRecord(index)).split('---')[1]
  ).reduce((total, block) => total + (block?.length ?? 0), 0)
  assert.ok(frontmatterOnly < 6_000, `a screenful of frontmatter grew to ${frontmatterOnly} bytes`)
})

test('an index a session has scribbled in survives: bad records are skipped and the next upsert wins', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'toucan-outcome-index-'))
  const store = createSessionOutcomeStore({ directory })
  const record = typicalRecord(0)

  // Everything a session with write access to the folder could leave behind: a record mangled into
  // nonsense, one whose frontmatter parses but lies about a field, and a file that is not a record
  // at all. None of them is readable, and none of them is Toucan's problem - `read` answers `null`
  // exactly as it does for a record that was never written, and the next capture rewrites it.
  writeFileSync(join(directory, `${record.key}.md`), 'not a record at all', 'utf8')
  assert.equal(await store.read(record.key), null)
  writeFileSync(
    join(directory, `${record.key}.md`),
    renderSessionOutcome(record).replace(/^turns: \d+$/m, 'turns: several'),
    'utf8'
  )
  assert.equal(await store.read(record.key), null)
  assert.equal(store.readSync(record.key), null)
  writeFileSync(join(directory, 'notes-the-agent-left.md'), '# unrelated', 'utf8')

  await store.write(record)

  assert.deepEqual(await store.read(record.key), record)
})
