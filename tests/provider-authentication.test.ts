import { strict as assert } from 'node:assert'
import { PassThrough } from 'node:stream'
import { test, vi } from 'vitest'
import { createProviderAuthentication } from '../src/main/provider-authentication'
import { writeAuthCode } from '../src/main/acp-session-manager'
import type { AgentAuthMethod, AgentEvent, AgentProvider } from '../src/shared/agent'
import {
  mobileAuthenticationMethods,
  parseProviderAuthenticationAction,
  parseProviderAuthenticationState,
  providerAuthorizationUrl
} from '../src/shared/provider-authentication'
import { stubAdapterChild } from './helpers/scripted-adapter'
import { spawnAgentProcess } from '../src/main/agent-process'

const CLAUDE: AgentAuthMethod = {
  id: 'claude-ai-login',
  name: 'Claude Subscription',
  type: 'terminal',
  args: ['--cli', 'auth', 'login', '--claudeai']
}
const CODEX: AgentAuthMethod = { id: 'chat-gpt-device-code', name: 'ChatGPT (device code)', type: 'agent' }
const URL = 'https://claude.ai/oauth/authorize?client_id=test&state=test-state&code_challenge=test-challenge'

function harness(provider: AgentProvider = 'claude', timeoutMs?: number) {
  const child = stubAdapterChild()
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit('exit', null, 'SIGTERM'))
    return true
  })
  const events: AgentEvent[] = []
  const openLink = vi.fn()
  let required = true
  const reopen = vi.fn(async () => {
    required = false
    return { ok: true, status: 'ready' as const, sessionId: 'same-conversation' }
  })
  let agentResolve: (() => void) | undefined
  let agentReject: ((error: Error) => void) | undefined
  const agent = new Promise<void>((resolve, reject) => {
    agentResolve = resolve
    agentReject = reject
  })
  const flow = createProviderAuthentication({
    provider,
    methods: () => (provider === 'claude' ? [CLAUDE] : [CODEX]),
    required: () => required,
    canStart: () => true,
    launchTerminal: () => child,
    authenticateAgent: () => agent,
    reopen,
    openLink,
    publish: (event) => events.push(event),
    writeCode: writeAuthCode,
    timeoutMs
  })
  return {
    flow,
    child,
    events,
    openLink,
    reopen,
    agentResolve: () => agentResolve!(),
    agentReject: () => agentReject!(new Error('sensitive-provider-error'))
  }
}

test('mobile offers only verified, advertised provider flows and validates URLs and bounded bodies', () => {
  assert.deepEqual(mobileAuthenticationMethods('claude', [CLAUDE, { ...CLAUDE, id: 'claude-login' }]), [
    { id: CLAUDE.id, name: CLAUDE.name, mode: 'code' }
  ])
  assert.deepEqual(
    mobileAuthenticationMethods('codex', [
      CODEX,
      { id: 'chat-gpt', name: 'ChatGPT', type: 'agent' },
      { id: 'api-key', name: 'API key', type: 'env_var' }
    ]),
    [{ id: CODEX.id, name: CODEX.name, mode: 'device' }]
  )
  for (const raw of [
    'http://claude.ai/oauth/authorize',
    'https://claude.ai.evil.test/oauth/authorize',
    'https://user:password@claude.ai/oauth/authorize',
    'https://claude.ai:4433/oauth/authorize',
    'file:///secrets',
    'https://claude.ai/settings',
    'http://localhost:1455/auth/callback?code=test'
  ])
    assert.equal(providerAuthorizationUrl('claude', raw), undefined)
  assert.equal(
    providerAuthorizationUrl('codex', 'https://auth.openai.com/codex/device'),
    'https://auth.openai.com/codex/device'
  )
  for (const value of [
    null,
    {},
    { action: 'code', attemptId: 'a', code: 'code\ncommand' },
    { action: 'code', attemptId: 'a', code: 'x'.repeat(8193) },
    { action: 'start', methodId: 'claude-ai-login', args: ['evil'] },
    { action: 'callback', url: 'http://localhost' }
  ])
    assert.equal(parseProviderAuthenticationAction(JSON.stringify(value)), null)
  assert.deepEqual(parseProviderAuthenticationAction('{"action":"code","attemptId":"a","code":" test-code "}'), {
    action: 'code',
    attemptId: 'a',
    code: 'test-code'
  })
  assert.equal(
    parseProviderAuthenticationState({
      required: true,
      methods: [],
      attempt: { id: 'a', methodId: CLAUDE.id, status: 'waiting', url: 'javascript:alert(1)' }
    }),
    null
  )
})

test('Claude phone sign-in buffers a split URL, sends one code only to stdin, and verifies success', async () => {
  const h = harness()
  assert.deepEqual(h.flow.start(CLAUDE.id), { ok: true })
  const attempt = h.flow.state().attempt!
  assert.equal(h.flow.start(CLAUDE.id).ok, false)
  h.child.stdout.write(`To authorize: ${URL.slice(0, 42)}`)
  assert.equal(h.flow.state().attempt?.url, undefined)
  h.child.stdout.write(`${URL.slice(42)}\n`)
  assert.equal(h.flow.state().attempt?.url, URL)
  assert.equal(h.openLink.mock.calls.length, 0)
  assert.equal((await h.flow.submit('test-code', 'old-attempt')).ok, false)
  const submitted = await Promise.all([
    h.flow.submit('private-test-code', attempt.id),
    h.flow.submit('duplicate', attempt.id)
  ])
  assert.deepEqual(
    submitted.map((result) => result.ok),
    [true, false]
  )
  assert.equal((h.child.stdin as PassThrough).read()?.toString(), 'private-test-code\n')
  h.child.stderr.write('echoed-private-test-code and sensitive diagnostics\n')
  h.child.emit('exit', 0)
  await vi.waitFor(() => assert.equal(h.flow.state().attempt?.status, 'succeeded'))
  assert.equal(h.reopen.mock.calls.length, 1)
  assert.equal(h.flow.state().attempt?.url, undefined)
  h.child.stdout.write(`Late helper output: ${URL}\n`)
  assert.equal(h.flow.state().attempt?.status, 'succeeded')
  assert.equal(h.flow.state().attempt?.url, undefined)
  assert.doesNotMatch(JSON.stringify(h.events), /private-test-code|oauth\/authorize|test-state|sensitive diagnostics/)
  assert.doesNotMatch(JSON.stringify(h.flow.state()), /private-test-code/)
  h.flow.dispose()
})

test('cancellation stops the helper, stale codes cannot reach a new attempt, and spawn errors need no exit', async () => {
  const h = harness()
  h.flow.start(CLAUDE.id)
  const first = h.flow.state().attempt!.id
  assert.equal(h.flow.cancel('stale').ok, false)
  assert.equal(h.flow.cancel(first).ok, true)
  await vi.waitFor(() => assert.equal(h.flow.state().attempt?.status, 'cancelled'))
  assert.equal(h.reopen.mock.calls.length, 0)
  h.flow.start(CLAUDE.id)
  h.child.stdout.write(`Open: ${URL}\n`)
  assert.equal((await h.flow.submit('stale-code', first)).ok, false)
  h.child.emit('error', new Error('EMFILE sensitive error'))
  await vi.waitFor(() => assert.equal(h.flow.state().attempt?.status, 'failed'))
  assert.doesNotMatch(JSON.stringify(h.events), /EMFILE|sensitive error/)
  // Error listeners survive a later refused kill rather than becoming unhandled exceptions.
  assert.doesNotThrow(() => h.child.emit('error', new Error('EACCES')))
  h.flow.dispose()
})

test('Codex device code stays in ephemeral state, and cancellation answers the provider elicitation', async () => {
  const h = harness('codex')
  h.flow.start(CODEX.id)
  const response = h.flow.elicit(
    'https://auth.openai.com/codex/device',
    'Sign in to ChatGPT and enter this code: TEST-1234'
  )!
  assert.equal(h.flow.state().attempt?.userCode, 'TEST-1234')
  assert.equal((await h.flow.submit('not-a-callback', h.flow.state().attempt!.id)).ok, false)
  assert.equal(h.flow.cancel(h.flow.state().attempt!.id).ok, true)
  assert.deepEqual(await response, { action: 'cancel' })
  h.agentReject()
  await vi.waitFor(() => assert.equal(h.flow.state().attempt?.status, 'cancelled'))
  assert.doesNotMatch(JSON.stringify(h.events), /TEST-1234|sensitive-provider-error/)
  assert.equal(h.flow.state().attempt?.userCode, undefined)
  h.flow.dispose()
})

test('Codex provider completion, failure and timeout are distinct from accepted start', async () => {
  const success = harness('codex')
  success.flow.start(CODEX.id)
  const response = success.flow.elicit(
    'https://auth.openai.com/codex/device',
    'Sign in to ChatGPT and enter this code: TEST-1234'
  )!
  success.agentResolve()
  await vi.waitFor(() => assert.equal(success.flow.state().attempt?.status, 'succeeded'))
  assert.deepEqual(await response, { action: 'accept' })
  success.flow.dispose()
  const failed = harness('codex')
  failed.flow.start(CODEX.id)
  failed.agentReject()
  await vi.waitFor(() => assert.equal(failed.flow.state().attempt?.status, 'failed'))
  failed.flow.dispose()
  const expired = harness('claude', 5)
  expired.flow.start(CLAUDE.id)
  await vi.waitFor(() => assert.equal(expired.flow.state().attempt?.status, 'failed'))
  assert.equal(vi.isMockFunction(expired.child.kill), true)
  expired.flow.dispose()
})

test('desktop continues opening Claude authorization links and uses the same code boundary', async () => {
  const h = harness()
  const result = h.flow.run(CLAUDE.id)
  h.child.stdout.write(`Open: ${URL}`)
  assert.deepEqual(h.openLink.mock.calls, [[URL]])
  assert.ok(h.events.some((event) => event.type === 'auth_link' && event.url === URL))
  h.child.emit('exit', 0)
  assert.equal((await result).status, 'ready')
  h.flow.dispose()
})

test('a broken stdin is handled and a helper success cannot hide a failed session verification', async () => {
  const broken = harness()
  broken.flow.start(CLAUDE.id)
  assert.doesNotThrow(() => broken.child.stdin.emit('error', new Error('EPIPE private-test-code')))
  await vi.waitFor(() => assert.equal(broken.flow.state().attempt?.status, 'failed'))
  assert.doesNotMatch(JSON.stringify(broken.events), /EPIPE|private-test-code/)
  broken.flow.dispose()
  const unverified = harness()
  unverified.reopen.mockRejectedValue(new Error('private-provider-verification-error'))
  unverified.flow.start(CLAUDE.id)
  unverified.child.emit('exit', 0)
  await vi.waitFor(() => assert.equal(unverified.flow.state().attempt?.status, 'failed'))
  assert.doesNotMatch(JSON.stringify(unverified.events), /private-provider-verification-error/)
  unverified.flow.dispose()
})

test.runIf(process.platform === 'win32')(
  'Windows cancellation stops the owned login wrapper and its native descendant',
  async () => {
    let descendant: number | undefined
    let helper: ReturnType<typeof spawnAgentProcess> | undefined
    const flow = createProviderAuthentication({
      provider: 'claude',
      methods: () => [CLAUDE],
      required: () => true,
      canStart: () => true,
      launchTerminal: () => {
        helper = spawnAgentProcess({
          executable: process.execPath,
          args: [
            '-e',
            `
        const { spawn } = require('node:child_process')
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
        child.on('error', () => process.exit(2))
        console.log('descendant:' + child.pid)
        process.stdin.resume()
        setInterval(() => {}, 1000)
      `
          ],
          options: {}
        })
        helper.stdout.on('data', (data: string | Buffer) => {
          const pid = data.toString().match(/descendant:(\d+)/)?.[1]
          if (pid) descendant = Number(pid)
        })
        return helper
      },
      authenticateAgent: async () => {},
      reopen: async () => ({ ok: true, status: 'ready' }),
      publish: () => {},
      openLink: () => {},
      writeCode: writeAuthCode
    })
    try {
      flow.start(CLAUDE.id)
      await vi.waitFor(() => assert.ok(descendant), { timeout: 5000 })
      assert.equal(flow.cancel(flow.state().attempt!.id).ok, true)
      await vi.waitFor(() => assert.equal(flow.state().attempt?.status, 'cancelled'), { timeout: 5000 })
      assert.throws(() => process.kill(descendant!, 0), /ESRCH/)
      assert.equal(flow.active(), false)
    } finally {
      flow.dispose()
      // Only these fixture processes, in case an assertion failed before the cancellation.
      if (helper && helper.exitCode === null && helper.signalCode === null) helper.kill()
      if (descendant) {
        try {
          process.kill(descendant)
        } catch {
          /* Already gone. */
        }
      }
    }
  }
)
