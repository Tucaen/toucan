import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppUpdateSnapshot } from '../../src/shared/app-update'
import {
  APP_UPDATE_ACTIVE_POLL_MS,
  APP_UPDATE_IDLE_POLL_MS,
  describeAppUpdate,
  followRestart,
  isAppUpdateMoving,
  NO_RESTART,
  type PhoneRestart
} from './app-update-view'
import type { SavedHost } from './hosts'
import { checkAppUpdate, fetchAppUpdate, restartForUpdate } from './remote-client'

/**
 * The desktop's version chip, on the phone (#5): which Toucan this host runs, a check, and once a
 * package is downloaded, the restart into it.
 *
 * Every state shown is the host's own `AppUpdater` snapshot, polled - the phone keeps none of its
 * own except the restart it asked for. That restart is the one place the phone and the desktop
 * differ: busy sessions are confirmed *here*, in the desktop dialog's own words, because the reader
 * holding the phone may be nowhere near the desktop's modal. And once the host has accepted, its
 * going quiet is the restart working, not an error - the card says so and waits for it to answer
 * again, while the list's own offline banner keeps reconnecting.
 *
 * A host too old to serve the update routes simply never gets a card.
 */
export default function AppUpdatePanel({
  host,
  offline,
  onUnauthorized
}: {
  host: SavedHost
  /** The workspace poll's verdict; no button is offered to a host that is not answering. */
  offline: boolean
  onUnauthorized(): void
}): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<AppUpdateSnapshot | null>(null)
  const [restart, setRestart] = useState<PhoneRestart>(NO_RESTART)
  const [announceError, setAnnounceError] = useState(false)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  // The poll reads the latest restart without restarting itself on every change of it.
  const restartRef = useRef(restart)
  restartRef.current = restart
  const moving = isAppUpdateMoving(snapshot, restart)
  const origin = host.origin
  const token = host.token

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const poll = async (): Promise<void> => {
      const result = await fetchAppUpdate({ origin, token }, controller.signal)
      if (cancelled) return
      if (result.ok) setSnapshot(result.value)
      const current = restartRef.current
      if (current.stage !== 'restarting') return
      // A 401 is the workspace poll's to act on; here every failure is the host not answering yet.
      const next = followRestart(current, result.ok ? { ok: true, snapshot: result.value } : { ok: false }, Date.now())
      restartRef.current = next.restart
      setRestart(next.restart)
      if (next.notice) setNotice(next.notice)
      if (next.problem) setProblem(next.problem)
    }

    void poll()
    const timer = window.setInterval(() => void poll(), moving ? APP_UPDATE_ACTIVE_POLL_MS : APP_UPDATE_IDLE_POLL_MS)
    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(timer)
    }
  }, [origin, token, moving])

  const check = useCallback(async (): Promise<void> => {
    setPending(true)
    setAnnounceError(true)
    setNotice(null)
    setProblem(null)
    const result = await checkAppUpdate(host)
    setPending(false)
    if (result.ok) setSnapshot(result.value)
    else if (result.kind === 'unauthorized') onUnauthorized()
    else setProblem(result.message)
  }, [host, onUnauthorized])

  const requestRestart = useCallback(
    async (confirmed: boolean): Promise<void> => {
      if (snapshot?.status.phase !== 'downloaded') return
      const { currentVersion: from, status } = snapshot
      setPending(true)
      setNotice(null)
      setProblem(null)
      const result = await restartForUpdate(host, confirmed)
      setPending(false)
      const restarting: PhoneRestart = {
        stage: 'restarting',
        from,
        to: status.version,
        since: Date.now(),
        hostGone: false
      }
      if (!result.ok) {
        if (result.kind === 'unauthorized') {
          onUnauthorized()
          return
        }
        // No answer at all: the host may have gone down mid-reply, which is the restart working.
        // The poll tells the two apart - a host that never left is caught by the stall bound.
        setRestart(restarting)
        return
      }
      const reply = result.value
      if (reply.restarting) setRestart(restarting)
      else if ('confirm' in reply) setRestart({ stage: 'confirming', warning: reply.confirm })
      else {
        setRestart(NO_RESTART)
        setProblem(reply.error)
      }
    },
    [host, snapshot, onUnauthorized]
  )

  if (restart.stage === 'restarting') {
    return (
      <section className="app-update" data-stage="restarting" aria-label="Toucan update">
        <p role="status">
          Restarting {host.name} into Toucan {restart.to}… This phone reconnects on its own when it is back.
        </p>
      </section>
    )
  }
  if (!snapshot) return null

  if (restart.stage === 'confirming') {
    const { warning } = restart
    return (
      <section className="app-update" data-stage="confirming" aria-label="Toucan update">
        <h2>{warning.title}</h2>
        <p>{warning.message}</p>
        <p className="app-update-detail">{warning.detail}</p>
        <div className="app-update-actions">
          <button
            type="button"
            className="app-update-proceed"
            disabled={pending || offline}
            onClick={() => void requestRestart(true)}
          >
            {warning.proceedLabel}
          </button>
          <button type="button" disabled={pending} onClick={() => setRestart(NO_RESTART)}>
            Cancel
          </button>
        </div>
      </section>
    )
  }

  const line = describeAppUpdate(snapshot, announceError)
  return (
    <section className="app-update" data-phase={snapshot.status.phase} aria-label="Toucan update">
      <p role="status">{line.text}</p>
      {notice && <p className="app-update-notice">{notice}</p>}
      {line.action && (
        <button
          type="button"
          className="app-update-action"
          data-kind={line.action.kind}
          disabled={pending || offline}
          onClick={() => void (line.action?.kind === 'restart' ? requestRestart(false) : check())}
        >
          {line.action.label}
        </button>
      )}
      {problem && <p role="alert">{problem}</p>}
    </section>
  )
}
