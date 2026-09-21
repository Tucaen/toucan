import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Settings2 } from 'lucide-react'
import { SelectorPicker } from './SelectorPicker'
import type { AgentProvider } from '../../shared/agent-provider'
import { usePortalMenuPosition } from './use-portal-menu-position'
import { useComposerSendKey } from './composer-send-key-context'
import { composerSendKeyLabels, type ComposerSendKey } from './composer-keys'
import { useRoutineDelegation } from './routine-delegation-context'
import { DELEGATION_OFF_OPTION, describeRoutineDelegation } from './routine-delegation-display'
import { withWorkerSelection, type AgentRoutineDelegation } from '../../shared/routine-delegation'
import { useDecisionDelegation } from './decision-delegation-context'
import { DECISION_DELEGATION_ON_OPTION, describeDecisionDelegation } from './decision-delegation-display'
import { type AgentDecisionDelegation } from '../../shared/decision-delegation'
import { useDictationCleanupPreference } from './dictation-cleanup-context'
import { DICTATION_CLEANUP_MODELS } from '../../shared/dictation-cleanup'

export interface ComposerSettingsMenuProps {
  provider: AgentProvider
  routineDelegation?: AgentRoutineDelegation | null
  decisionDelegation?: AgentDecisionDelegation | null
}

/**
 * The settings a conversation is set up with once and then forgotten: routine-work delegation,
 * decision delegation, dictation cleanup and the send key. All four are workspace-wide rather than
 * session-bound, so they earn a click rather than a permanent chip next to the model, effort and
 * permission pickers - the three that actually change from turn to turn.
 *
 * The panel stays open while its pickers are used: each `SelectorPicker` portals its own menu to
 * `<body>`, so a focus-out rule would read every dropdown as "the user left" and close underneath
 * them. It closes on Escape, or on a pointer press landing outside both the panel and any open
 * picker menu.
 */
export default function ComposerSettingsMenu(props: ComposerSettingsMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const { sendKey, setSendKey } = useComposerSendKey()
  const routineDelegation = useRoutineDelegation()
  const decisionDelegation = useDecisionDelegation()
  const cleanup = useDictationCleanupPreference()
  const delegation = describeRoutineDelegation(
    props.provider,
    routineDelegation.preference,
    props.routineDelegation ?? undefined
  )
  const decisions = describeDecisionDelegation(
    decisionDelegation.preference,
    props.decisionDelegation ?? undefined,
    decisionDelegation.skillInstalled
  )
  // A string, not an array: `remeasureOn` is an effect dependency, and a fresh array literal
  // every render would re-measure forever.
  const position = usePortalMenuPosition(
    buttonRef,
    panelRef,
    open,
    { width: 260, height: 0 },
    undefined,
    `${delegation.note ?? ''}|${decisions.note ?? ''}`
  )

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('.node-picker-menu')) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const panel = open && (
    <div
      ref={panelRef}
      className="composer-settings-panel"
      role="group"
      aria-label="More settings"
      style={{
        position: 'fixed',
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? 'visible' : 'hidden'
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <small>More settings</small>
      <SelectorPicker
        kind="delegation"
        options={delegation.options}
        selectedId={delegation.selectedId}
        // Never disabled, unlike the session-bound pickers: the preference is workspace-wide
        // and only applies at the next safe session creation/resume anyway.
        disabled={false}
        select={(id) =>
          routineDelegation.setPreference(
            withWorkerSelection(
              routineDelegation.preference,
              props.provider,
              id === DELEGATION_OFF_OPTION.id ? undefined : id
            )
          )
        }
      />
      {delegation.note && <span className="composer-toolbar-note">{delegation.note}</span>}
      <SelectorPicker
        kind="decisions"
        options={decisions.options}
        selectedId={decisions.selectedId}
        // Never closed, for the routine picker's reason plus one of its own: opening is what
        // re-probes for the skill, so a picker that refused to open could never learn it arrived.
        disabled={false}
        onOpen={decisionDelegation.refreshAvailability}
        select={(id) => decisionDelegation.setPreference({ enabled: id === DECISION_DELEGATION_ON_OPTION.id })}
      />
      {decisions.note && <span className="composer-toolbar-note">{decisions.note}</span>}
      <SelectorPicker
        kind="cleanup"
        options={[
          { id: 'off', name: 'Dictation cleanup off', description: 'Keep the local transcript; no subscription usage' },
          ...DICTATION_CLEANUP_MODELS.map((model) => ({ ...model, name: `Cleanup: ${model.name}` }))
        ]}
        selectedId={cleanup.preference.enabled ? (cleanup.preference.claudeModelId ?? 'haiku') : 'off'}
        disabled={false}
        select={(id) => {
          const model = DICTATION_CLEANUP_MODELS.find((option) => option.id === id)
          cleanup.setPreference(
            model ? { enabled: true, claudeModelId: model.id } : { ...cleanup.preference, enabled: false }
          )
        }}
      />
      <SelectorPicker
        kind="sendKey"
        options={(Object.keys(composerSendKeyLabels) as ComposerSendKey[]).map((id) => ({
          id,
          ...composerSendKeyLabels[id]
        }))}
        selectedId={sendKey}
        disabled={false}
        select={(id) => setSendKey(id as ComposerSendKey)}
      />
    </div>
  )

  return (
    <div className="composer-settings nodrag" onClick={(event) => event.stopPropagation()}>
      <button
        ref={buttonRef}
        type="button"
        className="composer-settings-button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="More settings"
        title="Delegation, dictation cleanup and the send key"
        onClick={() => setOpen((current) => !current)}
      >
        <Settings2 aria-hidden="true" />
      </button>
      {panel && createPortal(panel, document.body)}
    </div>
  )
}
