import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  parseRemoteChatSpawnRequest,
  remoteChatSpawnProblem,
  spawnSettlement,
  type RemoteChatSpawnRequest
} from '../src/shared/remote-spawn'
import { REMOTE_CHAT_PROMPT_LIMIT } from '../src/shared/remote-chat'

/**
 * The spawn contract both ends run. Two things are being pinned here: that a body which starts a
 * process is validated rather than trusted, and that "the session came up" is one rule with one
 * home - because the alternative is a phone told to open a chat that is not there.
 */

function request(overrides: Partial<RemoteChatSpawnRequest> = {}): RemoteChatSpawnRequest {
  return { projectId: 'toucan', kind: 'claude', ...overrides }
}

describe('what a spawn request may be', () => {
  test('a project and a kind are enough; the first message is optional', () => {
    assert.equal(remoteChatSpawnProblem(request()), null)
    assert.equal(remoteChatSpawnProblem(request({ kind: 'codex', input: 'fix the parser' })), null)
  })

  test('an empty first message is refused rather than read as no message', () => {
    // The phone omits the field when the box is empty; a present-but-blank one is a client that
    // got that wrong, and silently opening an idle chat would hide the bug.
    assert.equal(remoteChatSpawnProblem(request({ input: '   ' })), 'Type a message first.')
  })

  test('a first message is bounded by the same limit a prompt frame is', () => {
    const problem = remoteChatSpawnProblem(request({ input: 'x'.repeat(REMOTE_CHAT_PROMPT_LIMIT + 1) }))
    assert.equal(problem, `A message may be at most ${REMOTE_CHAT_PROMPT_LIMIT} characters.`)
  })

  test('a missing project is named as the thing to fix', () => {
    assert.equal(remoteChatSpawnProblem(request({ projectId: '' })), 'Pick a project first.')
  })
})

describe('reading a spawn body off the wire', () => {
  test('accepts the shapes the client sends', () => {
    assert.deepEqual(parseRemoteChatSpawnRequest('{"projectId":"toucan","kind":"codex"}'), {
      projectId: 'toucan',
      kind: 'codex'
    })
    assert.deepEqual(parseRemoteChatSpawnRequest('{"projectId":"toucan","kind":"claude","input":"go"}'), {
      projectId: 'toucan',
      kind: 'claude',
      input: 'go'
    })
  })

  test('refuses anything it would have to guess at', () => {
    for (const body of [
      'not json',
      '[]',
      '"toucan"',
      '{"kind":"claude"}',
      '{"projectId":"toucan"}',
      '{"projectId":"toucan","kind":"terminal"}',
      '{"projectId":7,"kind":"claude"}',
      // A non-string input is a malformed body, not an absent prompt: reading it as one would
      // quietly open a chat that was meant to start working.
      '{"projectId":"toucan","kind":"claude","input":{"text":"go"}}'
    ]) {
      assert.equal(parseRemoteChatSpawnRequest(body), null, body)
    }
  })
})

describe('when a spawn has settled', () => {
  test('only a starting session is still pending', () => {
    assert.equal(spawnSettlement('starting'), 'pending')
  })

  test('every live status means the session exists', () => {
    for (const status of ['idle', 'working', 'result', 'attention', 'stalled'] as const) {
      assert.equal(spawnSettlement(status), 'started', status)
    }
  })

  test('a session that died and a node that never launched one both fail', () => {
    // These are the two phantom-chat cases: reporting either as started hands the phone an id it
    // can open but never drive.
    assert.equal(spawnSettlement('exited'), 'failed')
    assert.equal(spawnSettlement('dormant'), 'failed')
  })
})
