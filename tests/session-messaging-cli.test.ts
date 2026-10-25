import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'vitest'
import { createMessagingEndpoint } from '../src/main/messaging-endpoint'
import { PROJECT_SKILLS_DIRECTORY } from '../src/shared/project-skills'
import {
  MESSAGING_TOKEN_ENV,
  MESSAGING_URL_ENV,
  SESSION_MESSAGING_CLI_PATH,
  type MessagingCommand
} from '../src/shared/session-messaging'

// #2: the session-messaging CLI is a thin client - it finds the endpoint and token in its
// environment, sends one command, prints one JSON line, and refuses clearly without a token.

const cli = join(process.cwd(), PROJECT_SKILLS_DIRECTORY, ...SESSION_MESSAGING_CLI_PATH)

interface Run {
  code: number
  output: { ok: boolean; error?: string; [key: string]: unknown }
}

function run(args: string[], environment: Record<string, string | undefined>): Promise<Run> {
  const env = { ...process.env, ...environment }
  for (const key of [MESSAGING_URL_ENV, MESSAGING_TOKEN_ENV]) if (environment[key] === undefined) delete env[key]
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { env }, (error, stdout) => {
      const lines = stdout.trim().split(/\r?\n/)
      resolve({
        code: error ? Number((error as { code?: number }).code ?? 1) : 0,
        output: JSON.parse(lines[lines.length - 1]!) as Run['output']
      })
    })
  })
}

test('without a token the CLI refuses before sending anything', async () => {
  const result = await run(['list'], {})
  assert.equal(result.code, 2)
  assert.match(result.output.error ?? '', /TOUCAN_MESSAGING_URL is not set/)
})

test('list, ask and reply reach the messenger as the calling session', async () => {
  const calls: Array<{ nodeId: string; command: MessagingCommand; args: unknown }> = []
  const endpoint = createMessagingEndpoint({
    messenger: {
      execute: (nodeId, command, args) => {
        calls.push({ nodeId, command, args })
        return Promise.resolve(
          command === 'reply'
            ? { status: 404, body: { ok: false, error: 'no message m-9 was delivered to this session' } }
            : { status: 200, body: { ok: true, command } }
        )
      }
    }
  })
  try {
    const grant = await endpoint.grant('node-a')
    assert.ok(grant)
    const env = grant.environment
    assert.deepEqual((await run(['list'], env)).output, { ok: true, command: 'list' })
    const asked = await run(['ask', '--to', 'b0000000', '--text', 'what is your plan?'], env)
    assert.equal(asked.code, 0)
    const refused = await run(['reply', '--id', 'm-9', '--text', 'done'], env)
    assert.equal(refused.code, 1)
    assert.match(refused.output.error ?? '', /no message m-9/)
    assert.deepEqual(calls, [
      { nodeId: 'node-a', command: 'list', args: undefined },
      { nodeId: 'node-a', command: 'ask', args: { to: 'b0000000', text: 'what is your plan?' } },
      { nodeId: 'node-a', command: 'reply', args: { id: 'm-9', text: 'done' } }
    ])
    for (const bad of [
      ['ask', '--to', 'b'],
      ['ask', '--to', 'b', '--text'],
      ['reply', 'm-9'],
      ['list', 'x'],
      ['send']
    ]) {
      const result = await run(bad, env)
      assert.equal(result.code, 2, bad.join(' '))
      assert.match(result.output.error ?? '', /Usage: message\.mjs/)
    }
    assert.equal(calls.length, 3)
  } finally {
    await endpoint.close()
  }
})
