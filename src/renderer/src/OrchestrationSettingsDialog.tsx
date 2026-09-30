import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { DIFFICULTY_TIERS, TICKET_CONTRACT_SUMMARY, type DifficultyTier } from '../../shared/orchestration'
import type { OrchestrationConfig, OrchestrationConfigFile, TierMappingEntry } from '../../shared/orchestration-routing'
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

type Drafts = { user: Draft<OrchestrationConfig>; project?: Draft<OrchestrationConfigFile> }

const baseOf = (file: OrchestrationConfigFileState): string => JSON.stringify(file.file ?? file.error ?? null)

const fresh = <T,>(value: T, file: OrchestrationConfigFileState): Draft<T> => ({
  value,
  base: baseOf(file),
  dirty: false,
  stale: false
})

const userFresh = (state: OrchestrationSettingsState): Draft<OrchestrationConfig> =>
  fresh(userDraft(state.user.file), state.user)

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
  state: OrchestrationSettingsState
  disabled: boolean
  onChange(entry: TierMappingEntry | undefined): void
}): JSX.Element {
  const { tier, state, inherited } = props
  const shown = props.entry ?? inherited
  if (!shown) throw new Error(`the ${tier} tier has no model`)
  const models = modelChoices(shown.model, state.models)
  const efforts = effortChoices(shown.effort, state.efforts[shown.model])
  const nameOf = (choices: readonly SettingsChoice<unknown>[]): string => {
    const choice = choices.find((candidate) => candidate.selected)
    return choice ? `${choice.name}${choice.missing ? ' (missing)' : ''}` : ''
  }
  const inheritedLabel = inherited && `Inherited: ${nameOf(modelChoices(inherited.model, state.models))}`
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
          content: props.entry ? nameOf(models) : inheritedLabel,
          className: 'orchestration-picker',
          disabled: props.disabled
        }}
        select={(id) => {
          if (id === INHERIT) props.onChange(undefined)
          else props.onChange({ model: id, ...(shown.effort ? { effort: shown.effort } : {}) })
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
          disabled: props.disabled || !props.entry,
          ...(props.entry ? {} : { title: 'Choose a model for this tier to set its effort' })
        }}
        select={(id) => props.onChange({ model: shown.model, ...(id === FOLLOWS_TICKET ? {} : { effort: id }) })}
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
  const [tab, setTab] = useState<OrchestrationConfigScope>('user')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const tabsRef = useRef<HTMLDivElement>(null)
  const ids = useId()
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
          user: { ...current.user, value: change(current.user.value) as OrchestrationConfig, dirty: true }
        }
      }
      if (!current.project) return current
      return { ...current, project: { ...current.project, value: change(current.project.value), dirty: true } }
    })
  }

  const setTier = (tier: DifficultyTier, entry: TierMappingEntry | undefined): void =>
    edit((value) => {
      const tiers = { ...value.tiers }
      if (entry) tiers[tier] = entry
      else delete tiers[tier]
      return { ...value, tiers }
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

  const inherited = inheritedConfig(state?.user)
  const skillValue =
    tab === 'user' ? (drafts?.user.value.implementationSkill ?? '') : (drafts?.project?.value.implementationSkill ?? '')
  const contractId = `${ids}-contract`
  const panelId = `${ids}-panel`

  return (
    <ModalDialog labelledBy={`${ids}-title`} onClose={saving ? undefined : props.onClose}>
      <div className="dialog orchestration-settings-dialog">
        <strong id={`${ids}-title`}>Orchestration settings</strong>
        <p>
          How an orchestrator routes tickets: the model per difficulty tier and the skill every ticket session starts
          with. The files are the source of truth, so an agent may edit them too.
        </p>
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
          {state && state.models.length === 0 && (
            <p className="orchestration-settings-note">
              No Claude model list is known yet. Start a Claude chat once so the pickers can offer its models.
            </p>
          )}
          {state && drafts && draft && (
            <>
              {DIFFICULTY_TIERS.map((tier) => (
                <TierRow
                  key={tier}
                  tier={tier}
                  entry={draft.value.tiers?.[tier]}
                  {...(tab === 'project' ? { inherited: inherited.tiers[tier] } : {})}
                  state={state}
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
                      edit((current) => ({ ...current, implementationSkill: value }))
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
