import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { createMessagingEndpoint, MESSAGING_ENDPOINT_PATH } from '../src/main/messaging-endpoint'
import type { MessagingReply } from '../src/main/session-messenger'
import { MESSAGING_TOKEN_ENV, MESSAGING_URL_ENV, type MessagingCommand } from '../src/shared/session-messaging'

// #2: the endpoint authenticates the calling session by its per-node token and hands its command
// to the messenger under that node's identity - never one the caller names.

function harness() {
  const calls: Array<{ nodeId: string; command: MessagingCommand; args: unknown }> = []
  const endpoint = createMessagingEndpoint({
    messenger: {
      execute: (nodeId, command, args): Promise<MessagingReply> => {
        calls.push({ nodeId, command, args })
        return Promise.resolve({ status: 200, body: { ok: true, nodeId } })
      }
    }
  })
  return { endpoint, calls }
}

async function post(url: string, token: string | undefined, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

test('a grant names its node: the command runs as that session, whatever the body says', async () => {
  const { endpoint, calls } = harness()
  try {
    const grant = await endpoint.grant('node-a')
    assert.ok(grant)
    const url = grant.environment[MESSAGING_URL_ENV]
    assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:\\d+${MESSAGING_ENDPOINT_PATH}$`))
    const reply = await post(url, grant.environment[MESSAGING_TOKEN_ENV], {
      command: 'ask',
      args: { to: 'b', text: 'q' },
      nodeId: 'node-b'
    })
    assert.equal(reply.status, 200)
    assert.deepEqual(calls, [{ nodeId: 'node-a', command: 'ask', args: { to: 'b', text: 'q' } }])
  } finally {
    await endpoint.close()
  }
})

test('a missing, wrong or revoked token is refused, and the last revoke closes the port', async () => {
  const { endpoint, calls } = harness()
  try {
    const first = await endpoint.grant('node-a')
    const second = await endpoint.grant('node-b')
    assert.ok(first && second)
    const url = first.environment[MESSAGING_URL_ENV]
    assert.equal((await post(url, undefined, { command: 'list' })).status, 401)
    assert.equal((await post(url, 'not-a-token', { command: 'list' })).status, 401)
    first.revoke()
    assert.equal((await post(url, first.environment[MESSAGING_TOKEN_ENV], { command: 'list' })).status, 401)
    assert.equal(endpoint.listening(), true)
    assert.equal((await post(url, second.environment[MESSAGING_TOKEN_ENV], { command: 'nope' })).status, 400)
    assert.equal((await post(url, second.environment[MESSAGING_TOKEN_ENV], 'not json')).status, 400)
    second.revoke()
    assert.equal(endpoint.listening(), false)
    assert.equal(calls.length, 0)
  } finally {
    await endpoint.close()
  }
})

test('a relaunch replaces the node grant it had', async () => {
  const { endpoint } = harness()
  try {
    const old = await endpoint.grant('node-a')
    const fresh = await endpoint.grant('node-a')
    assert.ok(old && fresh)
    const url = fresh.environment[MESSAGING_URL_ENV]
    assert.equal((await post(url, old.environment[MESSAGING_TOKEN_ENV], { command: 'list' })).status, 401)
    assert.equal((await post(url, fresh.environment[MESSAGING_TOKEN_ENV], { command: 'list' })).status, 200)
    // The old handle revokes only its own token.
    old.revoke()
    assert.equal((await post(url, fresh.environment[MESSAGING_TOKEN_ENV], { command: 'list' })).status, 200)
  } finally {
    await endpoint.close()
  }
})
