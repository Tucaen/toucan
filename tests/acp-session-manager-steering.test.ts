import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { deliverSteeredPrompt } from '../src/main/acp-session-manager'

test('queued captain input is injected once into a working turn through ACP steering', async () => {
  const requests: Array<{ method: string; sessionId: string; text: string }> = []
  const result = await deliverSteeredPrompt(
    async (method, params) => {
      requests.push({
        method,
        sessionId: params.sessionId,
        text: params.prompt[0]?.type === 'text' ? params.prompt[0].text : ''
      })
      return { outcome: 'injected' }
    },
    'session-1',
    'second independent idea'
  )

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(
    requests,
    [
      {
        method: '_session/steering',
        sessionId: 'session-1',
        text: 'second independent idea'
      }
    ],
    'one accepted submission must produce exactly one steering request'
  )
})

test('multiple steered messages retain host submission order without duplicate injection', async () => {
  const delivered: string[] = []
  const request = async (_method: string, params: { prompt: Array<{ type: string; text?: string }> }) => {
    delivered.push(params.prompt[0]?.text ?? '')
    return { outcome: 'injected' as const }
  }

  for (const text of ['idea A', 'idea B', 'idea C']) {
    assert.deepEqual(await deliverSteeredPrompt(request, 'session-2', text), { ok: true })
  }
  assert.deepEqual(delivered, ['idea A', 'idea B', 'idea C'])
})

test('a terminal steering rejection remains a genuine delivery failure', async () => {
  const result = await deliverSteeredPrompt(async () => ({ outcome: 'failed' }), 'session-3', 'cannot deliver')
  assert.equal(result.ok, false)
  assert.match(result.message ?? '', /could not accept/i)
})
