import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Writable } from 'node:stream'
import type { CreateElicitationResponse } from '@agentclientprotocol/sdk'
import type { AgentAuthMethod, AgentCreateResult, AgentEvent, AgentPromptResult, AgentProvider } from '../shared/agent'
import {
  mobileAuthenticationMethods,
  extractLoginUrl,
  providerAuthorizationUrl,
  type ProviderAuthenticationState
} from '../shared/provider-authentication'
import { normalizeTerminalOutput } from '../shared/terminal-output'
import { hiddenProcessOptions } from './background-process'

interface AuthenticationOptions {
  provider: AgentProvider
  methods(): AgentAuthMethod[]
  required(): boolean
  /** Refuses a second sign-in across sessions sharing the same provider credentials. */
  canStart(): boolean
  launchTerminal(method: AgentAuthMethod): ChildProcessWithoutNullStreams
  authenticateAgent(methodId: string): Promise<unknown>
  reopen(): Promise<AgentCreateResult>
  publish(event: AgentEvent): void
  openLink(url: string): void
  writeCode(input: Writable | undefined, code: string): Promise<AgentPromptResult>
  timeoutMs?: number
}

export interface ProviderAuthentication {
  state(): ProviderAuthenticationState
  active(): boolean
  run(methodId: string, remote?: boolean): Promise<AgentCreateResult>
  start(methodId: string): AgentPromptResult
  submit(code: string, attemptId?: string): Promise<AgentPromptResult>
  cancel(attemptId: string): AgentPromptResult
  elicit(url: string, message: string): Promise<CreateElicitationResponse> | undefined
  dispose(): void
}

/**
 * One live adapter's sign-in cycle, shared by desktop and phone. Phone-initiated URLs and codes
 * stay here; raw helper output and provider exceptions never become events.
 * Cancellation stops sign-in, not the adapter or conversation, and never claims to revoke tokens.
 */
export function createProviderAuthentication(options: AuthenticationOptions): ProviderAuthentication {
  let attempt: ProviderAuthenticationState['attempt']
  let remote = false
  let phoneCompatible = false
  let disposed = false
  let busy = false
  let child: ChildProcessWithoutNullStreams | undefined
  let elicitation: ((response: CreateElicitationResponse) => void) | undefined
  let cancellation: 'cancelled' | 'failed' | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let inputBusy = false
  let stoppingHelper: Promise<boolean> | undefined

  const clearLinks = (): void => {
    if (!attempt) return
    delete attempt.url
    delete attempt.userCode
  }
  const refuse = (message: string): AgentCreateResult => ({ ok: false, status: 'error', message })
  const problem = (methodId: string, fromPhone: boolean): string | undefined => {
    if (disposed) return 'The agent session is not running.'
    if (busy || child || !options.canStart()) return 'A sign-in attempt is already in progress for this provider.'
    if (fromPhone && !options.required()) return 'This session does not need sign-in.'
    if (!options.methods().some((method) => method.id === methodId)) return 'That authentication method is unavailable.'
    if (
      fromPhone &&
      !mobileAuthenticationMethods(options.provider, options.methods()).some((method) => method.id === methodId)
    )
      return 'This sign-in method requires the desktop.'
    return undefined
  }
  const stopLogin = (): void => {
    elicitation?.({ action: 'cancel' })
    elicitation = undefined
    // Windows does not deliver the wrapper's SIGTERM handler. Terminate its native CLI too,
    // addressing only this owned helper's pid; never kill the long-running adapter or provider by name.
    if (child?.pid !== undefined && process.platform === 'win32') {
      if (stoppingHelper) return
      const pid = child.pid
      stoppingHelper = new Promise((resolve) => {
        try {
          const killer = execFile('taskkill', ['/pid', String(pid), '/T', '/F'], hiddenProcessOptions({}), (error) =>
            resolve(!error)
          )
          killer.on('error', () => resolve(false))
        } catch {
          resolve(false)
        }
      })
      return
    }
    // The permanent error listener below also handles a refused kill (exit need not follow error).
    try {
      child?.kill()
    } catch {
      // Keep the attempt busy until the helper actually exits; never authorize another stdin.
    }
  }

  const flow: ProviderAuthentication = {
    state() {
      const required = options.required()
      // A later expired-auth event starts a new cycle; an old success is no longer current.
      const current = !phoneCompatible || (required && !busy && attempt?.status === 'succeeded') ? undefined : attempt
      return {
        required,
        methods: busy && !phoneCompatible ? [] : mobileAuthenticationMethods(options.provider, options.methods()),
        ...(current ? { attempt: { ...current } } : {})
      }
    },
    active: () => busy || child !== undefined,
    async run(methodId, fromPhone = false) {
      const reason = problem(methodId, fromPhone)
      if (reason) return refuse(reason)
      const method = options.methods().find((candidate) => candidate.id === methodId)!
      busy = true
      remote = fromPhone
      phoneCompatible = mobileAuthenticationMethods(options.provider, options.methods()).some(
        (candidate) => candidate.id === methodId
      )
      cancellation = undefined
      stoppingHelper = undefined
      attempt = { id: crypto.randomUUID(), methodId, status: 'starting' }
      const currentAttempt = attempt
      let helperExited = false
      options.publish({ type: 'auth', methods: options.methods() })
      options.publish({ type: 'status', status: 'starting', message: 'Signing in…' })
      timeout = setTimeout(
        () => {
          cancellation = 'failed'
          if (attempt) {
            attempt.status = 'cancelling'
            attempt.message = 'Sign-in timed out. Waiting for the provider to stop...'
          }
          clearLinks()
          stopLogin()
        },
        options.timeoutMs ?? 10 * 60_000
      )
      timeout.unref()
      try {
        if (method.type === 'terminal') {
          await new Promise<void>((resolve, reject) => {
            const helper = options.launchTerminal(method)
            child = helper
            helper.stdout.setEncoding('utf8')
            helper.stderr.setEncoding('utf8')
            // Buffer lines independently: stdout and stderr chunks may split a URL anywhere.
            const consume = (): ((data: string) => void) => {
              let tail = ''
              return (data) => {
                tail = (tail + data).slice(-32_768)
                const lines = tail.split('\n')
                tail = lines.pop() ?? ''
                // Desktop's interactive-only CLI can redraw a prompt without a newline.
                if (!remote && tail) lines.push(tail)
                for (const line of lines) {
                  const text = normalizeTerminalOutput(line).trim()
                  if (
                    cancellation ||
                    disposed ||
                    !busy ||
                    attempt !== currentAttempt ||
                    !['starting', 'waiting'].includes(attempt.status)
                  )
                    continue
                  // The pinned CLI retries malformed paste-back codes without exiting. Forward only
                  // this known-safe meaning, never raw diagnostics that could echo a credential.
                  if (
                    text === 'Invalid code. Please make sure the full code was copied.' ||
                    text === 'That code is not from this sign-in. Paste the code shown after opening the address above.'
                  ) {
                    attempt.codeSubmitted = false
                    attempt.message = 'Copy the full code from this sign-in and try again.'
                    options.publish({ type: 'status', status: 'starting', message: attempt.message })
                  }
                  const raw = extractLoginUrl(text)
                  if (!raw) continue
                  const phoneUrl = providerAuthorizationUrl(options.provider, raw)
                  if (remote && !phoneUrl) continue
                  // Desktop keeps its existing HTTP(S) opener, including custom helpers. The
                  // phone's sign-in state never advertises custom URLs or unsupported attempts.
                  if (phoneUrl) attempt.url = phoneUrl
                  else phoneCompatible = false
                  attempt.status = 'waiting'
                  if (!remote) {
                    options.openLink(raw)
                    options.publish({ type: 'auth_link', url: raw })
                  }
                }
              }
            }
            helper.stdout.on('data', consume())
            helper.stderr.on('data', consume())
            helper.stdin.on('error', () => reject(new Error('Sign-in input closed.')))
            helper.on('error', () => reject(new Error('Sign-in helper failed.')))
            helper.once('exit', (code) => {
              helperExited = true
              if (child === helper) child = undefined
              if (code === 0) resolve()
              else reject(new Error('Sign-in helper exited.'))
            })
          })
        } else {
          await options.authenticateAgent(methodId)
        }
        if (cancellation || disposed) throw new Error('Sign-in stopped.')
        clearTimeout(timeout)
        clearLinks()
        attempt.status = 'verifying'
        // The provider exiting successfully is not enough: the same conversation must reopen.
        const result = await options.reopen()
        if (disposed) return refuse('The agent session is not running.')
        attempt.status = result.ok && result.status === 'ready' ? 'succeeded' : 'failed'
        attempt.message =
          attempt.status === 'succeeded'
            ? 'Signed in. You can send your message again.'
            : 'Sign-in did not restore this session. Try again on the desktop.'
        if (attempt.status === 'failed') {
          options.publish({ type: 'auth', methods: options.methods() })
          options.publish({ type: 'status', status: 'auth_required', message: attempt.message })
        }
        return attempt.status === 'succeeded'
          ? result
          : { ok: false, status: 'auth_required', message: attempt.message }
      } catch {
        const stopped = await Promise.resolve(stoppingHelper ?? true)
        clearLinks()
        attempt.status = (cancellation === 'cancelled' || disposed) && stopped ? 'cancelled' : 'failed'
        attempt.message =
          attempt.status === 'cancelled' ? 'Sign-in cancelled.' : 'Sign-in failed or timed out. Try again.'
        if (!disposed) {
          options.publish({ type: 'auth', methods: options.methods() })
          options.publish({ type: 'status', status: 'auth_required', message: attempt.message })
        }
        return { ok: false, status: 'auth_required', message: attempt.message }
      } finally {
        clearTimeout(timeout)
        elicitation?.({ action: 'accept' })
        elicitation = undefined
        // A kill error can leave a real helper alive. Keep its ownership until exit instead of
        // starting a second credential writer; a failed spawn has no pid and no exit follows it.
        if (helperExited || !child?.pid) child = undefined
        busy = false
      }
    },
    start(methodId) {
      const reason = problem(methodId, true)
      if (reason) return { ok: false, message: reason }
      // run reserves the attempt synchronously, before its first await. Disconnecting a phone
      // never loses the verdict: GET reads it again rather than starting a second helper.
      void flow.run(methodId, true)
      return { ok: true }
    },
    async submit(code, attemptId) {
      if (disposed || !busy || !child || !attempt || attempt.status !== 'waiting' || cancellation)
        return { ok: false, message: 'No sign-in process is waiting for a code.' }
      if (attemptId !== undefined && attemptId !== attempt.id)
        return { ok: false, message: 'That sign-in attempt is no longer current.' }
      if (attemptId !== undefined && !phoneCompatible)
        return { ok: false, message: 'This sign-in method requires the desktop.' }
      if (inputBusy || attempt.codeSubmitted)
        return { ok: false, message: 'A code was already submitted. Wait for sign-in to finish.' }
      inputBusy = true
      attempt.codeSubmitted = true
      delete attempt.message
      const submittedAttempt = attempt
      try {
        const result = await options.writeCode(child.stdin, code)
        if (!result.ok && attempt === submittedAttempt) attempt.codeSubmitted = false
        return result
      } finally {
        inputBusy = false
      }
    },
    cancel(attemptId) {
      if (!busy || !attempt || attempt.id !== attemptId || disposed)
        return { ok: false, message: 'That sign-in attempt is no longer current.' }
      if (attempt.status === 'verifying') return { ok: false, message: 'Sign-in is already being verified.' }
      cancellation = 'cancelled'
      attempt.status = 'cancelling'
      clearLinks()
      stopLogin()
      return { ok: true }
    },
    elicit(raw, message) {
      if (!busy || !attempt || attempt.methodId !== 'chat-gpt-device-code') return undefined
      const url = providerAuthorizationUrl(options.provider, raw)
      const userCode = message.match(/^Sign in to ChatGPT and enter this code: ([A-Z0-9-]{4,32})$/)?.[1]
      if (!url || !userCode || cancellation || disposed) return Promise.resolve({ action: 'cancel' })
      attempt.url = url
      attempt.userCode = userCode
      attempt.status = 'waiting'
      if (!remote) {
        options.openLink(url)
        options.publish({ type: 'status', status: 'starting', message })
        options.publish({ type: 'auth_link', url })
      }
      // Leave the provider's URL elicitation open. Its login-completed race ends it on success;
      // cancel answers it with `cancel`, which makes the adapter cancel its device login too.
      return new Promise((resolve) => {
        elicitation = resolve
      })
    },
    dispose() {
      disposed = true
      clearTimeout(timeout)
      clearLinks()
      stopLogin()
    }
  }
  return flow
}
