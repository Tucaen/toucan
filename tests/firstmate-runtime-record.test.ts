import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  FIRSTMATE_RUNTIME_HOST,
  parseFirstMateRuntimeRecord,
  serializeFirstMateRuntimeRecord,
  type FirstMateRuntimeRecord
} from '../src/shared/firstmate-runtime-record'

const globalRecord: FirstMateRuntimeRecord = {
  version: 1,
  host: FIRSTMATE_RUNTIME_HOST,
  validator: {
    agent: 'codex',
    model: 'gpt-5.6-sol',
    nmHome: '/home/tucaen/.local/share/ade/firstmate/home/no-mistakes',
    agentHome: '/home/tucaen/.local/share/ade/firstmate/home/codex'
  }
}

const taskRecord: FirstMateRuntimeRecord = {
  version: 1,
  host: FIRSTMATE_RUNTIME_HOST,
  project: {
    adeProjectId: 'alpha',
    registryName: 'api-alpha',
    windowsPath: 'D:\\Development\\alpha\\api',
    wslPath: '/mnt/d/Development/alpha/api',
    mode: 'no-mistakes',
    autonomy: false,
    worktree: '/home/tucaen/.treehouse/alpha/resize'
  },
  validator: {
    agent: 'claude',
    model: 'claude-opus-4-1',
    nmHome: '/home/tucaen/.local/share/ade/firstmate/home/no-mistakes',
    agentHome: '/home/tucaen/.local/share/ade/firstmate/home/claude',
    agentPath: '/home/tucaen/.local/share/ade/firstmate/home/state/validators/abc/claude'
  }
}

test('serializes a runtime record as pretty JSON with a trailing newline', () => {
  const serialized = serializeFirstMateRuntimeRecord(globalRecord)
  assert.ok(serialized.endsWith('\n'), 'writers append a trailing newline for a 0o600 config file')
  assert.deepEqual(JSON.parse(serialized), globalRecord)
  assert.match(serialized, /\n {2}"host": \{/, 'the record is written with two-space indentation')
})

test('round-trips every writer record through the authoritative serializer and parser', () => {
  for (const record of [globalRecord, taskRecord]) {
    const view = parseFirstMateRuntimeRecord(serializeFirstMateRuntimeRecord(record))
    assert.deepEqual(view, {
      version: 1,
      validator: { agent: record.validator.agent, model: record.validator.model }
    })
  }
})

test('accepts a lean global record that carries only the reader-required validator fields', () => {
  const lean = JSON.stringify({ version: 1, validator: { agent: 'claude', model: 'later-global-model' } })
  assert.deepEqual(parseFirstMateRuntimeRecord(lean), {
    version: 1,
    validator: { agent: 'claude', model: 'later-global-model' }
  })
})

test('deliberately ignores an additive compatible field instead of rejecting it', () => {
  const serialized = serializeFirstMateRuntimeRecord(globalRecord)
  const augmented = JSON.stringify({ ...JSON.parse(serialized), futureField: { pipeline: 'v2' } })
  assert.deepEqual(parseFirstMateRuntimeRecord(augmented), {
    version: 1,
    validator: { agent: 'codex', model: 'gpt-5.6-sol' }
  })
})

test('rejects an unsupported version and malformed required fields', () => {
  assert.equal(parseFirstMateRuntimeRecord(undefined), undefined)
  assert.equal(parseFirstMateRuntimeRecord('not json'), undefined)
  assert.equal(
    parseFirstMateRuntimeRecord(JSON.stringify({ version: 2, validator: { agent: 'codex', model: 'x' } })),
    undefined,
    'an unsupported version is refused rather than read on a best-effort basis'
  )
  assert.equal(
    parseFirstMateRuntimeRecord(JSON.stringify({ version: 1, validator: { agent: 'gpt', model: 'x' } })),
    undefined,
    'an unknown validator agent is a malformed required field'
  )
  assert.equal(
    parseFirstMateRuntimeRecord(JSON.stringify({ version: 1, validator: { agent: 'codex' } })),
    undefined,
    'a missing validator model is a malformed required field'
  )
})
