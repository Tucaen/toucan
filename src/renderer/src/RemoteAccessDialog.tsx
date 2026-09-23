import { useEffect, useState } from 'react'
import { Copy, RefreshCw } from 'lucide-react'
import { ModalDialog } from './ModalDialog'
import {
  remoteAccessPortProblem,
  remoteBindHostOptions,
  type RemoteAccessSettings,
  type RemoteAccessState
} from '../../shared/remote-access'

/**
 * Where the user turns remote access on and pairs a phone. It renders the host's state and hands
 * back an intent; the decision to bind a socket, and the token itself, stay with the main process.
 *
 * The pairing token is shown in full and deliberately never truncated for looks - it has to be
 * typed on a phone. Regenerating it is presented as what it is: the way to lock out a device.
 *
 * The bind-address control appears only where there is a tailnet address to bind to, which is what
 * makes it honest: on a PC without Tailscale the only choice would be "every interface", and a
 * disabled control offering nothing reads as a feature the user is missing out on rather than one
 * that does not apply.
 */
export function RemoteAccessDialog({
  state,
  busy,
  onApply,
  onRegenerate,
  onCopyToken,
  onClose
}: {
  state: RemoteAccessState | null
  busy: boolean
  onApply(settings: RemoteAccessSettings): void
  onRegenerate(): void
  onCopyToken(token: string): void
  onClose(): void
}): JSX.Element {
  // `bindHost` is a required key holding `undefined` for "every interface", rather than an absent
  // one: this is form state, so a control that can be set back to the default has to be able to
  // say so - and only the settings that cross the seam care about the key being gone.
  const [draft, setDraft] = useState<{ enabled: boolean; port: string; bindHost: string | undefined } | null>(null)

  // The host is the authority, so its state seeds the form and later corrections (a port that
  // could not be bound, a change from another window) are adopted rather than argued with.
  useEffect(() => {
    if (state) {
      setDraft({
        enabled: state.settings.enabled,
        port: String(state.settings.port),
        bindHost: state.settings.bindHost
      })
    }
  }, [state])

  const portProblem = draft ? remoteAccessPortProblem(Number(draft.port)) : null
  const bindOptions = remoteBindHostOptions(state?.addresses ?? [])
  const dirty = Boolean(
    state &&
    draft &&
    (draft.enabled !== state.settings.enabled ||
      Number(draft.port) !== state.settings.port ||
      draft.bindHost !== state.settings.bindHost)
  )

  return (
    <ModalDialog labelledBy="remote-access-title" onClose={busy ? undefined : onClose}>
      <form
        className="dialog remote-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (draft && !portProblem && !busy) {
            onApply({ enabled: draft.enabled, port: Number(draft.port), bindHost: draft.bindHost })
          }
        }}
      >
        <strong id="remote-access-title">Remote access</strong>
        <p>
          Serves Toucan&rsquo;s mobile companion to your phone. Reachability is Tailscale&rsquo;s job: put both devices
          on the same tailnet, then pair once with the token below.
        </p>

        {!draft && <p>Reading the host&rsquo;s settings&hellip;</p>}

        {draft && (
          <>
            <label className="remote-dialog-toggle">
              <input
                type="checkbox"
                checked={draft.enabled}
                disabled={busy}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
              />
              <span>Serve the mobile companion</span>
            </label>
            <label>
              <span className="eyebrow-label">Port</span>
              <input
                inputMode="numeric"
                value={draft.port}
                disabled={busy}
                onChange={(event) => setDraft({ ...draft, port: event.target.value.replace(/[^0-9]/g, '') })}
              />
            </label>
            {bindOptions.length > 0 && (
              <label>
                <span className="eyebrow-label">Reachable on</span>
                <select
                  value={draft.bindHost ?? ''}
                  disabled={busy}
                  onChange={(event) => setDraft({ ...draft, bindHost: event.target.value || undefined })}
                >
                  {bindOptions.map((option) => (
                    <option key={option.host ?? ''} value={option.host ?? ''}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {portProblem && <p className="dialog-error">{portProblem}</p>}
            {state?.error && <p className="dialog-error">{state.error}</p>}

            <div className="remote-dialog-status" role="status">
              {state?.listening ? (
                <>
                  <span className="remote-dialog-dot" data-listening="true" />
                  Listening on port {state.boundPort ?? state.settings.port}
                </>
              ) : (
                <>
                  <span className="remote-dialog-dot" />
                  Not listening
                </>
              )}
            </div>

            {state?.listening && state.addresses.length > 0 && (
              <div className="remote-dialog-addresses">
                <span className="eyebrow-label">Open on your phone</span>
                {state.addresses.map((address) => (
                  <code key={address.host} data-kind={address.kind}>
                    http://{address.host}:{state.boundPort ?? state.settings.port}
                    {address.kind === 'tailscale' && <em>tailnet</em>}
                  </code>
                ))}
              </div>
            )}

            {state && (
              <label>
                <span className="eyebrow-label">Pairing token</span>
                <div className="remote-dialog-token">
                  <code>{state.token}</code>
                  <button
                    type="button"
                    title="Copy the pairing token"
                    disabled={busy}
                    onClick={() => onCopyToken(state.token)}
                  >
                    <Copy aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    title="Generate a new token - every paired device has to pair again"
                    disabled={busy}
                    onClick={onRegenerate}
                  >
                    <RefreshCw aria-hidden="true" />
                  </button>
                </div>
              </label>
            )}
            <p>
              A device on your tailnet is reachable, not trusted: this token is what authorizes it. Generating a new one
              locks out every phone holding the old one.
            </p>
          </>
        )}

        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Close
          </button>
          <button type="submit" className="primary" disabled={busy || !dirty || Boolean(portProblem)}>
            {busy ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </form>
    </ModalDialog>
  )
}
