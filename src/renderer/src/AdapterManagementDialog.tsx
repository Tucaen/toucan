import { useEffect, useRef, useState } from 'react'
import type { AgentProvider } from '../../shared/agent'
import type { AdapterSnapshot, AdapterState } from '../../shared/adapter-management'

function AdapterChoice({
  provider,
  state,
  onCheck,
  onSelect
}: {
  provider: AgentProvider
  state: AdapterState
  onCheck(): void
  onSelect(version: string | null): void
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const busy = state.phase !== 'idle'
  const chosen = draft ?? state.selectedVersion ?? state.catalog?.latest ?? ''
  const versions = [...new Set([...state.installedVersions, ...(state.catalog?.versions ?? [])])]
  return (
    <fieldset className="adapter-choice" disabled={busy}>
      <legend>{provider === 'claude' ? 'Claude' : 'Codex'}</legend>
      <p>Bundled with Toucan: {state.bundledVersion}</p>
      <p>
        Selected for new sessions: <strong>{state.selectedVersion ?? 'Bundled with Toucan'}</strong>
      </p>
      <label>
        <span>Adapter version</span>
        <select value={chosen} onChange={(event) => setDraft(event.target.value)}>
          <option value="">Choose a version</option>
          {versions.map((version) => (
            <option key={version} value={version}>
              {version}
              {version.includes('-') ? ' (prerelease)' : ''}
              {version === state.catalog?.latest ? ' (latest)' : ''}
              {state.installedVersions.includes(version) ? ' (installed)' : ''}
            </option>
          ))}
        </select>
      </label>
      <div className="worktree-dialog-actions">
        <button type="button" onClick={onCheck}>
          Check for updates
        </button>
        <button
          type="button"
          className="primary"
          disabled={!chosen || chosen === state.selectedVersion}
          onClick={() => onSelect(chosen)}
        >
          {state.installedVersions.includes(chosen) ? 'Use version' : 'Install and use'}
        </button>
        <button
          type="button"
          disabled={state.selectedVersion === null && !state.error}
          onClick={() => {
            setDraft(null)
            onSelect(null)
          }}
        >
          Use bundled
        </button>
      </div>
      {busy && (
        <p role="status">
          {state.phase === 'checking'
            ? 'Checking published versions…'
            : state.phase === 'validating'
              ? 'Checking adapter compatibility…'
              : 'Installing adapter…'}
        </p>
      )}
      {state.error && (
        <p role="alert" className="worktree-dialog-error">
          {state.error}
        </p>
      )}
    </fieldset>
  )
}

export function AdapterManagementDialog({ onClose }: { onClose(): void }): JSX.Element {
  const [snapshot, setSnapshot] = useState<AdapterSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previousFocus = document.activeElement
    dialog.current?.focus()
    let active = true
    let receivedEvent = false
    const unsubscribe = window.adapterManagementApi.onChange((state) => {
      receivedEvent = true
      if (active) setSnapshot(state)
    })
    void window.adapterManagementApi
      .state()
      .then((state) => {
        if (active && !receivedEvent) setSnapshot(state)
      })
      .catch((reason: unknown) => {
        if (active) setError(String(reason))
      })
    return () => {
      active = false
      unsubscribe()
      if (previousFocus instanceof HTMLElement) previousFocus.focus()
    }
  }, [])
  const act = async (operation: Promise<AdapterSnapshot>): Promise<void> => {
    setError(null)
    try {
      setSnapshot(await operation)
    } catch (reason) {
      setError(String(reason))
    }
  }
  return (
    <div
      className="worktree-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="adapter-management-title"
      ref={dialog}
      tabIndex={-1}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') onClose()
        if (event.key === 'Tab') {
          const controls = [
            ...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled)') ?? [])
          ]
          const first = controls[0]
          const last = controls.at(-1)
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }
      }}
    >
      <div className="worktree-dialog adapter-management-dialog">
        <strong id="adapter-management-title">Agent adapters</strong>
        <p>
          Update Claude and Codex adapters independently of Toucan. Updates are installed only when you choose a
          version.
        </p>
        {!snapshot && !error && <p role="status">Reading adapter settings…</p>}
        {snapshot &&
          (['claude', 'codex'] as const).map((provider) => (
            <AdapterChoice
              key={provider}
              provider={provider}
              state={snapshot[provider]}
              onCheck={() => void act(window.adapterManagementApi.check(provider))}
              onSelect={(version) => void act(window.adapterManagementApi.select(provider, version))}
            />
          ))}
        {error && (
          <p role="alert" className="worktree-dialog-error">
            {error}
          </p>
        )}
        <p>Running conversations keep their current adapter. Restart a session to use the selected version.</p>
        <p>
          Other versions may change model availability and conversation compatibility. You can return to the bundled
          version at any time.
        </p>
        <div className="worktree-dialog-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
