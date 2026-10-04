import type { AgentModel } from './agent'
import { AGENT_PROVIDERS, type AgentProvider } from './agent-provider'
import {
  DEFAULT_ORCHESTRATION_CONFIG,
  EFFORT_LADDER,
  effectiveOrchestrationConfig,
  type OrchestrationConfigFile,
  type ProviderOrchestrationConfigFile,
  type TierMapping
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
  /** Each provider's own advertised picker catalogue; model ids never cross this boundary. */
  catalogues: Record<AgentProvider, { models: AgentModel[]; efforts: Record<string, string[]> }>
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
export function modelChoices(current: string | undefined, models: readonly AgentModel[]): SettingsChoice<string>[] {
  const choices = models.map((model) => ({
    id: model.id,
    name: model.name,
    ...(model.description ? { description: model.description } : {}),
    selected: model.id === current,
    missing: false
  }))
  if (current !== undefined && !models.some((model) => model.id === current)) {
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

export interface OrchestrationProviderDraft {
  tiers: Partial<TierMapping>
  implementationSkill: string
}

/** The user entry shown for one provider. Claude alone is filled from its historical defaults. */
export function userDraft(
  file: OrchestrationConfigFile | undefined,
  provider: AgentProvider = 'claude'
): OrchestrationProviderDraft {
  const effective = effectiveOrchestrationConfig(provider, file, undefined)
  const entry = file?.[provider]
  return {
    tiers: effective?.tiers ?? entry?.tiers ?? {},
    implementationSkill: entry?.implementationSkill ?? DEFAULT_ORCHESTRATION_CONFIG.implementationSkill
  }
}

/** One provider entry from a draft; a blank skill is omitted so the shared skill default applies. */
function providerFileFromDraft(draft: ProviderOrchestrationConfigFile): ProviderOrchestrationConfigFile {
  const skill = draft.implementationSkill?.trim()
  const tiers = draft.tiers && Object.keys(draft.tiers).length > 0 ? draft.tiers : undefined
  return { ...(tiers ? { tiers } : {}), ...(skill ? { implementationSkill: skill } : {}) }
}

/** Normalizes both provider entries while preserving whichever provider the open panel is not editing. */
export function orchestrationFileFromDraft(draft: OrchestrationConfigFile): OrchestrationConfigFile {
  const file: OrchestrationConfigFile = {}
  for (const provider of AGENT_PROVIDERS) {
    const entry = draft[provider]
    if (!entry) continue
    const normalized = providerFileFromDraft(entry)
    if (normalized.tiers || normalized.implementationSkill) file[provider] = normalized
  }
  return file
}

/** Compatibility names for callers that describe which scope they are saving. */
export function userFileFromDraft(draft: OrchestrationConfigFile): OrchestrationConfigFile {
  return orchestrationFileFromDraft(draft)
}

export function projectFileFromDraft(draft: OrchestrationConfigFile): OrchestrationConfigFile {
  return orchestrationFileFromDraft(draft)
}

/** What a project provider entry inherits from the user file. */
export function inheritedConfig(
  user: OrchestrationConfigFileState | undefined,
  provider: AgentProvider = 'claude'
): OrchestrationProviderDraft {
  return userDraft(user?.file, provider)
}
