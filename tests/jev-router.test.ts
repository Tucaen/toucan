import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { createJevRouter } from '../src/main/jev-router'

// The one Jev request `route` sends (#36): every unrouted ticket at once, a tier and a depth score
// per ticket, never a model list - and a Jev that cannot be reached is said so, never guessed around.

const KEY = 'ts-secret-key-123'
const tickets = [
  { id: '12', title: 'Rename a flag', body: 'Mechanical rename across two files.' },
  { id: '13', title: 'Redesign the store', source: '#13' }
]

interface Call {
  url: string
  init: RequestInit
}

function fakeFetch(respond: (call: Call, index: number) => Response | Promise<Response>): {
  fetch: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  return {
    calls,
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const call = { url: String(url), init: init ?? {} }
      calls.push(call)
      return respond(call, calls.length - 1)
    }) as typeof fetch
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const answers = {
  model: 'jev-1.2',
  answers: {
    tier_0: { choice: 'low', confidence: 0.91, probabilities: { low: 0.9, medium: 0.1, high: 0, frontier: 0 } },
    depth_0: { score: 0.4, confidence: 0.8 },
    tier_1: { choice: 'high', confidence: 0.42, probabilities: { low: 0, medium: 0.3, high: 0.4, frontier: 0.3 } },
    depth_1: { score: 2.9, confidence: 0.5 }
  }
}

test('every ticket goes in one request with a tier and a depth question each, and no model list', async () => {
  const fake = fakeFetch(() => json(answers))
  const router = createJevRouter({ environment: () => ({ TYPESAFE_API_KEY: KEY }), fetch: fake.fetch })
  const result = await router.judge(tickets)
  assert.equal(fake.calls.length, 1)
  const call = fake.calls[0]!
  assert.equal(call.url, 'https://api.typesafe.ai/v1/systemone')
  assert.equal((call.init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`)
  const body = JSON.parse(call.init.body as string) as {
    model: string
    state: { tickets: { id: string }[] }
    questions: Record<string, { type: string; instructions: string; criteria: unknown }>
  }
  assert.equal(body.model, 'jev-latest')
  assert.deepEqual(
    body.state.tickets.map((ticket) => ticket.id),
    ['12', '13']
  )
  assert.deepEqual(Object.keys(body.questions).sort(), ['depth_0', 'depth_1', 'tier_0', 'tier_1'])
  assert.equal(body.questions.tier_1!.type, 'choice')
  assert.match(body.questions.tier_1!.instructions, /`tickets\[1\]`/)
  assert.deepEqual(Object.keys(body.questions.tier_0!.criteria as object), ['low', 'medium', 'high', 'frontier'])
  assert.equal(body.questions.depth_0!.type, 'score')
  // Jev judges the task, never the models.
  const sent = (call.init.body as string).toLowerCase()
  for (const word of ['haiku', 'sonnet', 'opus', 'candidates', '"models"']) assert.ok(!sent.includes(word), word)

  assert.deepEqual(result, {
    ok: true,
    jevModel: 'jev-1.2',
    judgements: [
      { ticketId: '12', tier: 'low', confidence: 0.91, depth: 0.4 },
      { ticketId: '13', tier: 'high', confidence: 0.42, depth: 2.9 }
    ]
  })
})

test('no key means Jev is unavailable, without a request', async () => {
  const fake = fakeFetch(() => json(answers))
  const router = createJevRouter({ environment: () => ({}), fetch: fake.fetch })
  const result = await router.judge(tickets)
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.reason, /TYPESAFE_API_KEY is not set/)
  assert.equal(fake.calls.length, 0)
})

test('an HTTP error, a timeout or an incomplete answer is unavailable, and never shows the key', async () => {
  const echoKey = fakeFetch(() => json({ error: { message: `bad key ${KEY}` } }, 401))
  const refused = await createJevRouter({ environment: () => ({ TYPESAFE_API_KEY: KEY }), fetch: echoKey.fetch }).judge(
    tickets
  )
  assert.equal(refused.ok, false)
  const reason = refused.ok ? '' : refused.reason
  assert.match(reason, /HTTP 401/)
  assert.ok(!reason.includes(KEY))

  const hanging = fakeFetch(
    (call) =>
      new Promise<Response>((_, reject) =>
        call.init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'TimeoutError')))
      )
  )
  const timedOut = await createJevRouter({
    environment: () => ({ TYPESAFE_API_KEY: KEY }),
    fetch: hanging.fetch,
    timeoutMs: 20
  }).judge(tickets)
  assert.match(timedOut.ok ? '' : timedOut.reason, /did not answer within/)

  const partial = fakeFetch(() => json({ answers: { tier_0: answers.answers.tier_0 } }))
  const incomplete = await createJevRouter({
    environment: () => ({ TYPESAFE_API_KEY: KEY }),
    fetch: partial.fetch
  }).judge(tickets)
  assert.match(incomplete.ok ? '' : incomplete.reason, /incomplete answer for ticket 12/)
})

test('an overloaded or rate-limited Jev is asked once more', async () => {
  const fake = fakeFetch((_, index) => (index === 0 ? json({}, 529) : json(answers)))
  const result = await createJevRouter({ environment: () => ({ TYPESAFE_API_KEY: KEY }), fetch: fake.fetch }).judge(
    tickets
  )
  assert.equal(result.ok, true)
  assert.equal(fake.calls.length, 2)
})

test('TYPESAFE_BASE_URL points the request elsewhere', async () => {
  const fake = fakeFetch(() => json(answers))
  await createJevRouter({
    environment: () => ({ TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: 'http://localhost:9000/' }),
    fetch: fake.fetch
  }).judge(tickets)
  assert.equal(fake.calls[0]!.url, 'http://localhost:9000/v1/systemone')
})

test('reachability is told without spending a judgement, and never carries the key', async () => {
  const fake = fakeFetch(() => json({ error: 'method not allowed' }, 405))
  const router = createJevRouter({ environment: () => ({ TYPESAFE_API_KEY: KEY }), fetch: fake.fetch })
  assert.deepEqual(await router.status(), { state: 'reachable' })
  assert.equal(fake.calls[0]!.init.method, 'HEAD')
  assert.equal((fake.calls[0]!.init.headers as Record<string, string> | undefined)?.Authorization, undefined)

  const offline = fakeFetch(() => Promise.reject(new TypeError('fetch failed')))
  const down = await createJevRouter({ environment: () => ({ TYPESAFE_API_KEY: KEY }), fetch: offline.fetch }).status()
  assert.equal(down.state, 'unreachable')

  const noKey = await createJevRouter({ environment: () => ({}), fetch: fake.fetch }).status()
  assert.equal(noKey.state, 'no-key')
})
