import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { AgentProvider } from '../../shared/agent-provider'
import { DIFFICULTY_TIERS, TICKET_CONTRACT_SUMMARY, type DifficultyTier } from '../../shared/orchestration'
import {
  DEFAULT_ORCHESTRATION_CONFIG,
  type OrchestrationConfigFile,
  type TierMappingEntry
} from '../../shared/orchestration-routing'
import {
  effortChoices,
  inheritedConfig,
  modelChoices,
  projectFileFromDraft,
  userDraft,
  userFileFromDraft,
  type OrchestrationConfigFileState,
  type OrchestrationConfigScope,
  type OrchestrationSettingsState,
  type SettingsChoice
} from '../../shared/orchestration-settings'
import { ListboxPicker } from './ListboxPicker'
import { ModalDialog } from './ModalDialog'
import { useMenuNavigation } from './menu-keyboard'

/**
 * The orchestration settings panel (#39; plan in `docs/plans/orchestrator-mode.md`). The user tab
 * edits the user file whole; the project tab edits the active project's override, where a tier or
 * the skill left unset inherits from the user file. The files stay the source of truth: every
 * change on disk is re-read, and an unsaved edit is kept but flagged rather than overwritten.
 */

const INHERIT = '__inherit__'
const FOLLOWS_TICKET = '__ticket__'

interface Draft<T> {
  value: T
  /** The file contents this draft started from, to tell a real change on disk from a re-read. */
  base: string
  dirty: boolean
  /** The file changed on disk while this draft had unsaved edits. */
  stale: boolean
}

type Drafts = { user: Draft<OrchestrationConfigFile>; project?: Draft<OrchestrationConfigFile> }

const baseOf = (file: OrchestrationConfigFileState): string => JSON.stringify(file.file ?? file.error ?? null)

const fresh = <T,>(value: T, file: OrchestrationConfigFileState): Draft<T> => ({
  value,
  base: baseOf(file),
  dirty: false,
  stale: false
})

const userFresh = (state: OrchestrationSettingsState): Draft<OrchestrationConfigFile> =>
  fresh(state.user.file ?? {}, state.user)

const projectFresh = (project: OrchestrationConfigFileState): Draft<OrchestrationConfigFile> =>
  fresh(project.file ?? {}, project)

/**
 * Re-drafts from the files. An unsaved edit is kept, and flagged only when its own file now holds
 * something else - a re-read, a save of the other tab or the echo of this panel's save is no change.
 */
function redraft(state: OrchestrationSettingsState, previous: Drafts | null, force: boolean): Drafts {
  const keep = <T,>(draft: Draft<T> | undefined, file: OrchestrationConfigFileState, next: () => Draft<T>): Draft<T> =>
    draft?.dirty && !force ? (draft.base === baseOf(file) ? draft : { ...draft, stale: true }) : next()
  return {
    user: keep(previous?.user, state.user, () => userFresh(state)),
    ...(state.project ? { project: keep(previous?.project, state.project, () => projectFresh(state.project!)) } : {})
  }
}

function missingNote(choices: readonly SettingsChoice<unknown>[], what: string): JSX.Element | null {
  return choices.some((choice) => choice.selected && choice.missing) ? (
    <p className="orchestration-tier-missing">The picker no longer offers this {what}.</p>
  ) : null
}

function TierRow(props: {
  tier: DifficultyTier
  entry: TierMappingEntry | undefined
  inherited?: TierMappingEntry
  catalogue: OrchestrationSettingsState['catalogues'][AgentProvider]
  disabled: boolean
  onChange(entry: TierMappingEntry | undefined): void
}): JSX.Element {
  const { tier, catalogue, inherited } = props
  const shown = props.entry ?? inherited
  const models = modelChoices(shown?.model, catalogue.models)
  const efforts = effortChoices(shown?.effort, shown ? catalogue.efforts[shown.model] : undefined)
  const nameOf = (choices: readonly SettingsChoice<unknown>[]): string => {
    const choice = choices.find((candidate) => candidate.selected)
    return choice ? `${choice.name}${choice.missing ? ' (missing)' : ''}` : ''
  }
  const inheritedLabel = inherited && `Inherited: ${nameOf(modelChoices(inherited.model, catalogue.models))}`
  const modelOptions = [
    ...(inherited
      ? [{ id: INHERIT, content: 'Inherited from the user file', description: inheritedLabel, selected: !props.entry }]
      : []),
    ...models.map((choice) => ({
      id: choice.id,
      content: choice.missing ? `${choice.name} (missing)` : choice.name,
      description: choice.missing ? 'No longer offered by the chat node model picker' : choice.description,
      selected: props.entry !== undefined && choice.selected
    }))
  ]
  return (
    <fieldset className="orchestration-tier" disabled={props.disabled}>
      <legend>{tier} tier</legend>
      <ListboxPicker
        heading={`Model for the ${tier} tier`}
        menuWidth={260}
        options={modelOptions}
        trigger={{
          content: props.entry ? nameOf(models) : (inheritedLabel ?? 'Choose a model'),
          className: 'orchestration-picker',
          disabled: props.disabled
        }}
        select={(id) => {
          if (id === INHERIT) props.onChange(undefined)
          else props.onChange({ model: id, ...(shown?.effort ? { effort: shown.effort } : {}) })
        }}
      />
      <ListboxPicker
        heading={`Effort for the ${tier} tier`}
        menuWidth={220}
        options={efforts.map((choice) => ({
          id: choice.id ?? FOLLOWS_TICKET,
          content: choice.missing ? `${choice.name} (missing)` : choice.name,
          description:
            choice.id === undefined
              ? "Set from the ticket's reasoning depth"
              : choice.missing
                ? 'Not offered by this model'
                : undefined,
          selected: choice.selected
        }))}
        trigger={{
          content: nameOf(efforts),
          className: 'orchestration-picker',
          disabled: props.disabled || !props.entry || !shown,
          ...(props.entry && shown ? {} : { title: 'Choose a model for this tier to set its effort' })
        }}
        select={(id) =>
          shown && props.onChange({ model: shown.model, ...(id === FOLLOWS_TICKET ? {} : { effort: id }) })
        }
      />
      {props.entry && missingNote(models, 'model')}
      {props.entry && missingNote(efforts, 'effort for this model')}
    </fieldset>
  )
}

function ContractAside({ id }: { id: string }): JSX.Element {
  return (
    <aside id={id} className="orchestration-contract">
      <strong>Ticket contract</strong>
      <p>The skill must:</p>
      <ul>
        {TICKET_CONTRACT_SUMMARY.must.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p>It must never:</p>
      <ul>
        {TICKET_CONTRACT_SUMMARY.mustNot.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p>The contract is appended to every ticket prompt and wins over the skill.</p>
    </aside>
  )
}

export function OrchestrationSettingsDialog(props: {
  /** The active project, whose override the project tab edits; absent, that tab is unavailable. */
  project?: { name: string; path: string }
  onClose(): void
}): JSX.Element {
  const projectPath = props.project?.path
  const [state, setState] = useState<OrchestrationSettingsState | null>(null)
  const [drafts, setDrafts] = useState<Drafts | null>(null)
  const [provider, setProvider] = useState<AgentProvider>('claude')
  const [tab, setTab] = useState<OrchestrationConfigScope>('user')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const providersRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const ids = useId()
  const providerNavigation = useMenuNavigation(providersRef, true, {
    orientation: 'horizontal',
    onMove: (item) => item.click()
  })
  const tabNavigation = useMenuNavigation(tabsRef, true, { orientation: 'horizontal', onMove: (item) => item.click() })

  const apply = useCallback((next: OrchestrationSettingsState, force: boolean) => {
    setState(next)
    setDrafts((previous) => redraft(next, previous, force))
  }, [])

  // Change events can overlap; only the latest read may land, so an older state never wins.
  const latestRead = useRef(0)
  const reload = useCallback(
    async (force: boolean): Promise<void> => {
      const read = ++latestRead.current
      try {
        const next = await window.orchestrationSettingsApi.state(projectPath)
        if (read !== latestRead.current) return
        setError(null)
        apply(next, force)
      } catch (reason) {
        if (read === latestRead.current) setError(String(reason))
      }
    },
    [apply, projectPath]
  )

  useEffect(() => {
    let active = true
    const unsubscribe = window.orchestrationSettingsApi.onChange(() => {
      if (active) void reload(false)
    })
    void reload(true)
    return () => {
      active = false
      unsubscribe()
    }
  }, [reload])

  const file: OrchestrationConfigFileState | undefined = state
    ? tab === 'user'
      ? state.user
      : state.project
    : undefined
  const draft = drafts ? (tab === 'user' ? drafts.user : drafts.project) : undefined
  const unusable = Boolean(file?.error)

  /** One change to the open tab's draft. The user tab never unsets a tier, so it stays whole. */
  const edit = (change: (value: OrchestrationConfigFile) => OrchestrationConfigFile): void => {
    setDrafts((current) => {
      if (!current) return current
      if (tab === 'user') {
        return {
          ...current,
          user: { ...current.user, value: change(current.user.value), dirty: true }
        }
      }
      if (!current.project) return current
      return { ...current, project: { ...current.project, value: change(current.project.value), dirty: true } }
    })
  }

  const setTier = (tier: DifficultyTier, entry: TierMappingEntry | undefined): void =>
    edit((value) => {
      const providerConfig = value[provider] ?? {}
      const tiers = { ...providerConfig.tiers }
      if (entry) tiers[tier] = entry
      else delete tiers[tier]
      return { ...value, [provider]: { ...providerConfig, tiers } }
    })

  const save = async (): Promise<void> => {
    if (!drafts || !draft) return
    setSaving(true)
    setError(null)
    try {
      const next = await window.orchestrationSettingsApi.save(
        tab === 'user'
          ? { scope: 'user', file: userFileFromDraft(drafts.user.value) }
          : { scope: 'project', projectPath, file: projectFileFromDraft(drafts.project?.value ?? {}) }
      )
      setState(next)
      setDrafts((previous) => {
        const redrafted = redraft(next, previous, false)
        // The saved tab now matches its file; the other keeps whatever it had.
        return tab === 'user'
          ? { ...redrafted, user: userFresh(next) }
          : { ...redrafted, ...(next.project ? { project: projectFresh(next.project) } : {}) }
      })
    } catch (reason) {
      setError(String(reason))
    } finally {
      setSaving(false)
    }
  }

  const revert = (): void => {
    if (!state) return
    setDrafts((current) => {
      if (!current) return current
      return tab === 'user'
        ? { ...current, user: userFresh(state) }
        : { ...current, ...(state.project ? { project: projectFresh(state.project) } : {}) }
    })
    void reload(false)
  }

  const inherited = inheritedConfig(state?.user, provider)
  const userShown = userDraft(drafts?.user.value, provider)
  const providerDraft = draft?.value[provider]
  const skillValue =
    tab === 'user'
      ? (providerDraft?.implementationSkill ?? DEFAULT_ORCHESTRATION_CONFIG.implementationSkill)
      : (providerDraft?.implementationSkill ?? '')
  const catalogue = state?.catalogues[provider]
  const visibleTiers = {
    ...(tab === 'project' ? inherited.tiers : {}),
    ...(tab === 'user' ? userShown.tiers : providerDraft?.tiers)
  }
  const missingTiers = provider === 'codex' ? DIFFICULTY_TIERS.filter((tier) => !visibleTiers[tier]) : []
  const contractId = `${ids}-contract`
  const panelId = `${ids}-panel`

  return (
    <ModalDialog labelledBy={`${ids}-title`} onClose={saving ? undefined : props.onClose}>
      <div className="dialog orchestration-settings-dialog">
        <strong id={`${ids}-title`}>Orchestration settings</strong>
        <p>
          How each orchestration provider routes tickets: its model per difficulty tier and the skill its ticket
          sessions start with. The files are the source of truth, so an agent may edit them too.
        </p>
        <div
          ref={providersRef}
          className="orchestration-settings-tabs"
          role="tablist"
          aria-label="Orchestration provider"
          onKeyDown={providerNavigation.onKeyDown}
        >
          {(['claude', 'codex'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={provider === candidate}
              aria-controls={panelId}
              tabIndex={provider === candidate ? 0 : -1}
              onClick={() => setProvider(candidate)}
            >
              {candidate === 'claude' ? 'Claude' : 'Codex'}
            </button>
          ))}
        </div>
        <div
          ref={tabsRef}
          className="orchestration-settings-tabs"
          role="tablist"
          aria-label="Configuration file"
          onKeyDown={tabNavigation.onKeyDown}
        >
          {(['user', 'project'] as const).map((scope) => (
            <button
              key={scope}
              type="button"
              role="tab"
              aria-selected={tab === scope}
              aria-controls={panelId}
              tabIndex={tab === scope ? 0 : -1}
              disabled={scope === 'project' && !props.project}
              title={scope === 'project' && !props.project ? 'Open a project to override its settings' : undefined}
              onClick={() => setTab(scope)}
            >
              {scope === 'user' ? 'User' : props.project ? `Project: ${props.project.name}` : 'Project'}
            </button>
          ))}
        </div>
        <div id={panelId} role="tabpanel" className="orchestration-settings-panel">
          {!state && !error && <p role="status">Reading the orchestration configuration…</p>}
          {file && (
            <p className="orchestration-settings-path">
              {tab === 'user' ? 'User file' : 'Project override'}
              {file.exists ? '' : ' (not created yet)'}: <code>{file.path}</code>
            </p>
          )}
          {file?.error && (
            <p role="alert" className="dialog-error">
              {file.error}. Fix the file; this panel updates when it parses again.
            </p>
          )}
          {draft?.stale && (
            <p role="status" className="orchestration-settings-stale">
              The file changed on disk since you started editing. Revert to load it, or Save to replace it.
            </p>
          )}
          {catalogue && catalogue.models.length === 0 && (
            <p className="orchestration-settings-note">
              No {provider === 'claude' ? 'Claude' : 'Codex'} model list is known yet. Start a{' '}
              {provider === 'claude' ? 'Claude' : 'Codex'} chat once so the pickers can offer its models.
            </p>
          )}
          {missingTiers.length > 0 && (
            <p role="status" className="orchestration-settings-note">
              Codex routing is not usable yet. Choose a Codex model for {missingTiers.join(', ')}.
            </p>
          )}
          {state && drafts && draft && catalogue && (
            <>
              {DIFFICULTY_TIERS.map((tier) => (
                <TierRow
                  key={tier}
                  tier={tier}
                  entry={tab === 'user' ? userShown.tiers[tier] : providerDraft?.tiers?.[tier]}
                  {...(tab === 'project' ? { inherited: inherited.tiers[tier] } : {})}
                  catalogue={catalogue}
                  disabled={unusable || saving}
                  onChange={(entry) => setTier(tier, entry)}
                />
              ))}
              <div className="orchestration-skill">
                <label>
                  <span className="eyebrow-label">Implementation skill</span>
                  <input
                    type="text"
                    aria-label="Implementation skill"
                    aria-describedby={contractId}
                    value={skillValue}
                    placeholder={tab === 'project' ? `Inherited: ${inherited.implementationSkill}` : '/implement'}
                    disabled={unusable || saving}
                    onChange={(event) => {
                      const value = event.target.value
                      edit((current) => ({
                        ...current,
                        [provider]: { ...current[provider], implementationSkill: value }
                      }))
                    }}
                  />
                </label>
                <ContractAside id={contractId} />
              </div>
            </>
          )}
        </div>
        {error && (
          <p role="alert" className="dialog-error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" disabled={!draft?.dirty || saving} onClick={revert}>
            Revert
          </button>
          <button
            type="button"
            className="primary"
            disabled={!draft?.dirty || unusable || saving}
            onClick={() => void save()}
          >
            Save
          </button>
          <button type="button" disabled={saving} onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </ModalDialog>
  )
}
