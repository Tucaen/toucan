import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type {
  AgentCreateRequest,
  AgentCreateResult,
  AgentEvent,
  AgentPromptContent,
  AgentPromptResult
} from '../src/shared/agent'
import type { BrainDumpCaptureState } from '../src/shared/brain-dump'
import {
  buildBrainDumpCapturePrompt,
  createBrainDumpCaptureManager,
  type BrainDumpCaptureAgent,
  type BrainDumpCaptureOwner
} from '../src/main/brain-dump-capture'

class FakeAgent implements BrainDumpCaptureAgent {
  creates: AgentCreateRequest[] = []
  prompts: Array<{ id: string; content: AgentPromptContent }> = []
  cancellations: string[] = []
  createResult: AgentCreateResult = { ok: true, status: 'ready', sessionId: 'conversation-1' }
  promptResult: Promise<AgentPromptResult> = Promise.resolve({ ok: true })
  owner?: BrainDumpCaptureOwner

  async create(request: AgentCreateRequest, owner: BrainDumpCaptureOwner): Promise<AgentCreateResult> {
    this.creates.push(request)
    this.owner = owner
    return this.createResult
  }

  prompt(id: string, content: AgentPromptContent): Promise<AgentPromptResult> {
    this.prompts.push({ id, content })
    return this.promptResult
  }

  cancel(id: string): void {
    this.cancellations.push(id)
  }

  event(event: AgentEvent): void {
    this.owner?.send('agent:event', { id: this.creates.at(-1)?.id ?? '', event })
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function manager(agent: FakeAgent, states: BrainDumpCaptureState[] = []) {
  return createBrainDumpCaptureManager({
    agent,
    homeDirectory: 'C:\\Users\\Ada',
    registeredProjectPaths: () => ['D:\\Development\\ADE'],
    createJobId: () => 'job-1',
    publish: (state) => states.push(state)
  })
}

test('capture prompt keeps reviewed content in a separate ACP content block', () => {
  assert.deepEqual(buildBrainDumpCapturePrompt('raw text', 'D:\\Development\\ADE'), [
    {
      type: 'text',
      text: 'Use the brain-dump skill to file the reviewed content. The explicit project association is D:\\Development\\ADE. Preserve an existing topic association unless the content explicitly changes it.'
    },
    { type: 'text', text: 'raw text' }
  ])
})

test('assigned capture validates case-insensitively and starts the requested provider in the registered directory', async () => {
  const agent = new FakeAgent()
  const result = await manager(agent).start({
    content: 'Reviewed idea',
    provider: 'codex',
    projectPath: 'd:\\development\\ade'
  })
  assert.deepEqual(result, { ok: true, state: { status: 'working', jobId: 'job-1' } })
  assert.equal(agent.creates[0].provider, 'codex')
  assert.equal(agent.creates[0].cwd, 'D:\\Development\\ADE')
  assert.equal(agent.creates[0].modelId, undefined)
  assert.equal(agent.creates[0].effortId, undefined)
})

test('unassigned capture uses home and rejects empty content or an unregistered project', async () => {
  const agent = new FakeAgent()
  const capture = manager(agent)
  const empty = await capture.start({ content: '  ', provider: 'codex' })
  assert.equal(!empty.ok && empty.code, 'invalid-content')
  const unregistered = await capture.start({ content: 'Idea', provider: 'claude', projectPath: 'D:\\Other' })
  assert.equal(!unregistered.ok && unregistered.code, 'invalid-project')
  await capture.start({ content: 'Idea', provider: 'claude' })
  assert.equal(agent.creates[0].cwd, 'C:\\Users\\Ada')
  assert.equal(agent.creates[0].provider, 'claude')
})

test('one job runs at a time and renderer disconnect does not complete it', async () => {
  const agent = new FakeAgent()
  const turn = deferred<AgentPromptResult>()
  agent.promptResult = turn.promise
  const capture = manager(agent)
  await capture.start({ content: 'First', provider: 'codex' })
  const second = await capture.start({ content: 'Second', provider: 'codex' })
  assert.equal(!second.ok && second.code, 'busy')
  const owner = { isDestroyed: () => false, send: () => {} }
  capture.disconnectOwner(owner)
  assert.equal(capture.current()?.status, 'working')
  turn.resolve({ ok: true })
})

test('a persisted in-flight job restores as unverifiable rather than completed or failed by guesswork', () => {
  const agent = new FakeAgent()
  const capture = createBrainDumpCaptureManager({
    agent,
    homeDirectory: 'C:\\Users\\Ada',
    registeredProjectPaths: () => [],
    initialState: { status: 'working', jobId: 'old-job' }
  })
  assert.deepEqual(capture.current(), {
    status: 'failed',
    jobId: 'old-job',
    code: 'unverifiable',
    message: 'Capture state is unverifiable after restart.'
  })
})

test('completion uses final assistant summary and retains resumable conversation identity', async () => {
  const agent = new FakeAgent()
  const turn = deferred<AgentPromptResult>()
  agent.promptResult = turn.promise
  const states: BrainDumpCaptureState[] = []
  const capture = manager(agent, states)
  await capture.start({ content: 'Idea', provider: 'codex' })
  agent.event({
    type: 'message',
    role: 'assistant',
    messageId: 'm1',
    text: 'Created 1 topic (Idea).',
    presentation: 'final'
  })
  turn.resolve({ ok: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(capture.current(), {
    status: 'completed',
    jobId: 'job-1',
    summary: 'Created 1 topic (Idea).',
    conversation: { provider: 'codex', conversationId: 'conversation-1', cwd: 'C:\\Users\\Ada' }
  })
  assert.equal(states.at(-1)?.status, 'completed')
})

test('startup, authentication, prompt, timeout, and cancellation become structured resumable failures', async (t) => {
  await t.test('startup', async () => {
    const agent = new FakeAgent()
    agent.createResult = { ok: false, status: 'error', message: 'missing adapter' }
    const capture = manager(agent)
    await capture.start({ content: 'Idea', provider: 'codex' })
    const state = capture.current()
    assert.equal(state?.status === 'failed' && state.code, 'startup')
  })
  await t.test('authentication', async () => {
    const agent = new FakeAgent()
    agent.createResult = { ok: false, status: 'auth_required', sessionId: 'auth-session', message: 'sign in' }
    const capture = manager(agent)
    await capture.start({ content: 'Idea', provider: 'claude' })
    const state = capture.current()
    assert.equal(state?.status === 'failed' && state.code, 'auth')
    assert.equal(state?.status === 'failed' && state.conversation?.conversationId, 'auth-session')
  })
  await t.test('prompt and timeout', async () => {
    for (const message of ['skill failed', 'The agent turn stalled after 10ms.']) {
      const agent = new FakeAgent()
      agent.promptResult = Promise.resolve({ ok: false, message })
      const capture = manager(agent)
      await capture.start({ content: 'Idea', provider: 'codex' })
      await new Promise((resolve) => setImmediate(resolve))
      const state = capture.current()
      assert.equal(state?.status === 'failed' && state.code, message.includes('stalled') ? 'timeout' : 'skill')
      assert.equal(state?.status === 'failed' && state.conversation?.conversationId, 'conversation-1')
    }
  })
  await t.test('cancellation', async () => {
    const agent = new FakeAgent()
    agent.promptResult = deferred<AgentPromptResult>().promise
    const capture = manager(agent)
    const started = await capture.start({ content: 'Idea', provider: 'codex' })
    if (started.ok) capture.cancel(started.state.jobId)
    assert.deepEqual(agent.cancellations, ['job-1'])
    assert.equal(capture.current()?.status, 'failed')
    const state = capture.current()
    assert.equal(state?.status === 'failed' && state.code, 'cancelled')
  })
})
