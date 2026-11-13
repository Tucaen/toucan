import { useEffect, useId, useRef, useState } from 'react'
import type {
  ProviderAuthenticationAction,
  ProviderAuthenticationState
} from '../../src/shared/provider-authentication'
import type { SavedHost } from './hosts'
import { providerAuthentication } from './remote-client'

/** A sign-in belongs to the host's live session; navigating or reconnecting only reads it again. */
export default function ProviderSignIn({
  host,
  chatId,
  needed,
  online,
  onUnauthorized
}: {
  host: SavedHost
  chatId: string
  needed: boolean
  online: boolean
  onUnauthorized(): void
}): JSX.Element | null {
  const [state, setState] = useState<ProviderAuthenticationState | null>(null)
  const [problem, setProblem] = useState<string>()
  const [pending, setPending] = useState(false)
  const [code, setCode] = useState('')
  const version = useRef(0)
  const mutation = useRef<AbortController>()
  const inputId = useId()
  const titleId = useId()
  const unauthorized = useRef(onUnauthorized)
  unauthorized.current = onUnauthorized
  const active = state?.attempt && ['starting', 'waiting', 'verifying', 'cancelling'].includes(state.attempt.status)

  useEffect(() => () => mutation.current?.abort(), [host, chatId])

  useEffect(() => {
    if (!online || (!needed && !active)) return
    const controller = new AbortController()
    let reading = false
    const refresh = async (): Promise<void> => {
      if (reading || mutation.current) return
      reading = true
      const current = version.current
      const result = await providerAuthentication(host, chatId, undefined, controller.signal)
      reading = false
      if (controller.signal.aborted || version.current !== current) return
      if (result.ok) {
        setState(result.value)
        setProblem(undefined)
      } else if (result.kind === 'unauthorized') unauthorized.current()
      else setProblem(result.message)
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 1500)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [host, chatId, needed, online, active])

  useEffect(() => {
    setCode('')
  }, [state?.attempt?.id, state?.attempt?.status])

  const act = async (action: ProviderAuthenticationAction): Promise<void> => {
    if (mutation.current || !online) return
    const controller = new AbortController()
    mutation.current = controller
    version.current += 1
    setPending(true)
    setProblem(undefined)
    if (action.action === 'code') setCode('')
    const result = await providerAuthentication(host, chatId, action, controller.signal)
    if (controller.signal.aborted) return
    version.current += 1
    mutation.current = undefined
    if (result.ok) setState(result.value)
    else if (result.kind === 'unauthorized') unauthorized.current()
    else setProblem(result.message)
    setPending(false)
  }

  if (!needed && !state?.attempt) return null
  const attempt = state?.attempt
  const waiting = attempt?.status === 'waiting'
  const device = attempt?.methodId === 'chat-gpt-device-code'
  const succeeded = attempt?.status === 'succeeded' && !needed && !state?.required
  return (
    <section className="provider-sign-in" aria-labelledby={titleId}>
      <h2 id={titleId}>{succeeded ? 'Signed in' : 'Provider sign-in'}</h2>
      <p role="status">
        {active
          ? attempt?.status === 'cancelling'
            ? (attempt.message ?? 'Cancelling sign-in…')
            : attempt?.status === 'verifying'
              ? 'Verifying sign-in…'
              : 'Finish signing in to this PC with your browser.'
          : ((attempt?.status === 'succeeded' && !succeeded ? undefined : attempt?.message) ??
            'This session needs sign-in before you can send messages.')}
      </p>
      {problem && <p role="alert">{problem}</p>}
      {!online && <p role="status">Reconnect to the PC to check or continue sign-in.</p>}
      {state &&
        !active &&
        state.required &&
        (state.methods.length > 0 ? (
          state.methods.map((method) => (
            <button
              key={method.id}
              type="button"
              disabled={pending || !online}
              onClick={() => void act({ action: 'start', methodId: method.id })}
            >
              {pending ? 'Starting…' : `Sign in: ${method.name}`}
            </button>
          ))
        ) : (
          <p>
            No supported phone sign-in method is available. Complete sign-in or provider configuration on the desktop.
          </p>
        ))}
      {active && attempt?.url && online && (
        <a href={attempt.url} target="_blank" rel="noreferrer noopener" referrerPolicy="no-referrer">
          Open sign-in on this phone
        </a>
      )}
      {waiting && device && (
        <p>
          Enter this one-time code on the provider page: <code>{attempt?.userCode}</code>. Device sign-in must be
          enabled for your account.
        </p>
      )}
      {waiting && !device && attempt && !attempt.codeSubmitted && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (code.trim()) void act({ action: 'code', attemptId: attempt.id, code: code.trim() })
          }}
        >
          <label htmlFor={inputId}>Code shown by the provider</label>
          <p>Only if the browser asks you to paste a code back. Your password stays on the provider page.</p>
          <input
            id={inputId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={8192}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            disabled={pending || !online}
          />
          <button type="submit" disabled={pending || !online || !code.trim()}>
            {pending ? 'Submitting…' : 'Submit code'}
          </button>
        </form>
      )}
      {waiting && attempt?.codeSubmitted && (
        <p role="status">Code sent. Waiting for the provider to confirm sign-in…</p>
      )}
      {active && attempt && (
        <button
          type="button"
          disabled={pending || !online || ['verifying', 'cancelling'].includes(attempt.status)}
          onClick={() => void act({ action: 'cancel', attemptId: attempt.id })}
        >
          Cancel sign-in
        </button>
      )}
    </section>
  )
}
