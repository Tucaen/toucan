import type { AgentModel } from './agent'
import {
  DEFAULT_ORCHESTRATION_CONFIG,
  EFFORT_LADDER,
  effectiveOrchestrationConfig,
  type OrchestrationConfig,
  type OrchestrationConfigFile
} from './orchestration-routing'

/**
 * The orchestration settings panel (#39; plan in `docs/plans/orchestrator-mode.md`): a user tab
 * and a project-override tab over the two files #36 routes with. The files stay the source of
 * truth - an agent may edit them while the panel is open - so the panel reads them through main,
 * writes whole files back, and hears about every change on disk.
 */

export type OrchestrationConfigScope = 'user' | 'project'

/** One configuration file as the panel sees it. */
export interface OrchestrationConfigFileState {
  path: string
  exists: boolean
  /** The parsed contents; undefined when the file is absent or unusable. */
  file?: OrchestrationConfigFile
  /** Why the file cannot be used; the panel will not overwrite it until it parses again. */
  error?: string
}

export interface OrchestrationSettingsState {
  user: OrchestrationConfigFileState
  /** Present when the panel asked about a project. */
  project?: OrchestrationConfigFileState
  /** The chat node's Claude model list as last seen; empty until a Claude session advertised one. */
  models: AgentModel[]
  /** The efforts each listed model's picker offers, for the models a session has run. */
  efforts: Record<string, string[]>
}

export interface OrchestrationSettingsSaveRequest {
  scope: OrchestrationConfigScope
  /** Required for the project scope. */
  projectPath?: string
  file: OrchestrationConfigFile
}

export interface OrchestrationSettingsApi {
  state(projectPath?: string): Promise<OrchestrationSettingsState>
  save(request: OrchestrationSettingsSaveRequest): Promise<OrchestrationSettingsState>
  /** Fired whenever either file changes on disk, whoever changed it. */
  onChange(callback: () => void): () => void
}

export interface SettingsChoice<Id> {
  id: Id
  name: string
  description?: string
  selected: boolean
  /** The file names it, but the picker no longer offers it. */
  missing: boolean
}

/**
 * A tier's model picker: the chat node's list, plus the mapped model when the list no longer
 * offers it. With no list known yet nothing can be called missing.
 */
export function modelChoices(current: string, models: readonly AgentModel[]): SettingsChoice<string>[] {
  const choices = models.map((model) => ({
    id: model.id,
    name: model.name,
    ...(model.description ? { description: model.description } : {}),
    selected: model.id === current,
    missing: false
  }))
  if (!models.some((model) => model.id === current)) {
    choices.push({ id: current, name: current, selected: true, missing: models.length > 0 })
  }
  return choices
}

/**
 * A tier's effort picker: following the ticket's reasoning-depth score (no fixed effort), then the
 * efforts the model's picker offers - the whole ladder while no session has run the model - plus a
 * mapped effort the model does not offer.
 */
export function effortChoices(
  current: string | undefined,
  offered: readonly string[] | undefined
): SettingsChoice<string | undefined>[] {
  const efforts = offered ?? EFFORT_LADDER
  const choices: SettingsChoice<string | undefined>[] = [
    { id: undefined, name: 'Follows the ticket', selected: current === undefined, missing: false },
    ...efforts.map((effort) => ({ id: effort, name: effort, selected: effort === current, missing: false }))
  ]
  if (current !== undefined && !efforts.includes(current)) {
    choices.push({ id: current, name: current, selected: true, missing: true })
  }
  return choices
}

/** The user tab edits the whole configuration: the file over the defaults. */
export function userDraft(file: OrchestrationConfigFile | undefined): OrchestrationConfig {
  return effectiveOrchestrationConfig(file, undefined)
}

/** The user file for a draft; a blank skill is left out, so the default applies. */
export function userFileFromDraft(draft: OrchestrationConfig): OrchestrationConfigFile {
  const skill = draft.implementationSkill.trim()
  return { tiers: draft.tiers, ...(skill ? { implementationSkill: skill } : {}) }
}

/** The project override for a draft: only the tiers and skill it overrides. */
export function projectFileFromDraft(draft: OrchestrationConfigFile): OrchestrationConfigFile {
  const skill = draft.implementationSkill?.trim()
  const tiers = draft.tiers && Object.keys(draft.tiers).length > 0 ? draft.tiers : undefined
  return { ...(tiers ? { tiers } : {}), ...(skill ? { implementationSkill: skill } : {}) }
}

/** What the project inherits where it overrides nothing: the user file over the defaults. */
export function inheritedConfig(user: OrchestrationConfigFileState | undefined): OrchestrationConfig {
  return user?.file ? userDraft(user.file) : DEFAULT_ORCHESTRATION_CONFIG
}
