import { useEffect, useId, useState } from 'react'
import {
  COMMAND_GUARD_REQUESTED_NOTE,
  COMMAND_GUARD_SCOPE_NOTE,
  effectivePatternText,
  normalizePatternText,
  type CommandGuardPatternError,
  type CommandGuardPreferences,
  type CommandGuardSettingsState
} from '../../shared/command-guard-settings'
import { ModalDialog } from './ModalDialog'

/**
 * The command guard settings (ticket 03): a switch and the pattern list, one regex per line. Both
 * are the user's, across every canvas. A save that contains an invalid regex is refused and the
 * lines named, so nothing is ever silently skipped at runtime. What is saved reaches sessions
 * started afterwards, and the dialog says so.
 */
export function CommandGuardSettingsDialog({
  onClose,
  onSaved
}: {
  onClose(): void
  /** Told what was just stored, so the composer menus can follow the global switch. */
  onSaved?(preferences: CommandGuardPreferences): void
}): JSX.Element {
  const ids = useId()
  const [state, setState] = useState<CommandGuardSettingsState | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [patterns, setPatterns] = useState('')
  const [errors, setErrors] = useState<CommandGuardPatternError[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedNotice, setSavedNotice] = useState(false)

  const adopt = (next: CommandGuardSettingsState): void => {
    setState(next)
    setEnabled(next.preferences.enabled)
    setPatterns(effectivePatternText(next.preferences, next.defaults))
  }

  useEffect(() => {
    let active = true
    window.commandGuardSettingsApi
      .state()
      .then((next) => {
        if (active) adopt(next)
      })
      .catch((reason: unknown) => {
        if (active) setFailure(String(reason))
      })
    return () => {
      active = false
    }
  }, [])

  const dirty =
    state !== null &&
    (enabled !== state.preferences.enabled ||
      normalizePatternText(patterns) !== normalizePatternText(effectivePatternText(state.preferences, state.defaults)))
  const atDefaults = state !== null && normalizePatternText(patterns) === normalizePatternText(state.defaults)

  const save = async (): Promise<void> => {
    setSaving(true)
    setFailure(null)
    setSavedNotice(false)
    try {
      const result = await window.commandGuardSettingsApi.save({ enabled, patterns })
      if (result.ok) {
        setErrors([])
        adopt(result.state)
        onSaved?.(result.state.preferences)
        setSavedNotice(true)
      } else {
        setErrors(result.errors)
      }
    } catch (reason) {
      setFailure(String(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalDialog labelledBy={`${ids}-title`} onClose={saving ? undefined : onClose}>
      <div className="dialog command-guard-dialog">
        <strong id={`${ids}-title`}>Command guard</strong>
        <p>
          Asks each new Claude session to refuse shell commands that match a dangerous pattern, such as a recursive
          delete of your home folder or a force push.
        </p>
        <p className="command-guard-note">
          {COMMAND_GUARD_SCOPE_NOTE} {COMMAND_GUARD_REQUESTED_NOTE}
        </p>
        {!state && !failure && <p role="status">Reading command guard settings…</p>}
        {state && (
          <>
            <label className="command-guard-switch">
              <input
                type="checkbox"
                checked={enabled}
                disabled={saving}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              <span>Request the command guard for new sessions</span>
            </label>
            {!enabled && (
              <p className="command-guard-note">
                Off: sessions started from now on get no guard hook at all, whatever the list below says.
              </p>
            )}
            <label htmlFor={`${ids}-patterns`}>
              <span className="eyebrow-label">Patterns</span>
            </label>
            <p id={`${ids}-hint`} className="command-guard-note">
              One regular expression per line, matched case-insensitively against each command. Lines starting with #
              are comments. POSIX classes such as [[:space:]] work.
            </p>
            <textarea
              id={`${ids}-patterns`}
              className="command-guard-patterns"
              spellCheck={false}
              rows={14}
              value={patterns}
              disabled={saving}
              aria-describedby={`${ids}-hint`}
              aria-invalid={errors.length > 0 || undefined}
              onChange={(event) => {
                setPatterns(event.target.value)
                setErrors([])
                setSavedNotice(false)
              }}
            />
            {errors.length > 0 && (
              <div role="alert" className="dialog-error">
                <p>
                  Not saved. {errors.length === 1 ? 'One line is' : `${errors.length} lines are`} not a valid regex:
                </p>
                <ul className="command-guard-errors">
                  {errors.map((error) => (
                    <li key={error.line}>
                      Line {error.line}: {error.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {errors.length === 0 && savedNotice && (
              <p role="status">Saved. It applies to sessions started from now on.</p>
            )}
          </>
        )}
        {failure && (
          <p role="alert" className="dialog-error">
            {failure}
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            disabled={!state || saving || atDefaults}
            onClick={() => {
              if (!state) return
              setPatterns(state.defaults)
              setErrors([])
              setSavedNotice(false)
            }}
          >
            Reset to defaults
          </button>
          <button type="button" onClick={onClose} disabled={saving}>
            Close
          </button>
          <button type="button" className="primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </ModalDialog>
  )
}
