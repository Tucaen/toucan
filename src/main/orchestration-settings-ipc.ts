import type { AgentModel } from '../shared/agent'
import { ORCHESTRATION_SETTINGS_CHANNELS } from '../shared/ipc-channels'
import type { OrchestrationSettingsState } from '../shared/orchestration-settings'
import type { IpcRegistrar } from './ipc-registrar'
import { isRecord } from './ipc-validation'
import type { OrchestrationConfigStore } from './orchestration-config-store'

/**
 * The orchestration settings panel's side of main (#39): both configuration files as they are on
 * disk, and the chat node's Claude model list with each known model's efforts, so the panel offers
 * exactly what a ticket session could be started with. The store validates what is saved.
 */
export interface OrchestrationSettingsIpcOptions {
  store: Pick<OrchestrationConfigStore, 'inspect' | 'write'>
  /** The Claude models the chat node's picker last listed. */
  models(): readonly AgentModel[]
  /** What a model's effort picker offers; undefined while no session has run it. */
  efforts(modelId: string): readonly string[] | undefined
}

function projectPathOf(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '') throw new Error('The project path must be a non-empty string.')
  return value
}

async function settingsState(
  options: OrchestrationSettingsIpcOptions,
  projectPath: string | undefined
): Promise<OrchestrationSettingsState> {
  const [user, project] = await Promise.all([
    options.store.inspect('user'),
    projectPath === undefined ? undefined : options.store.inspect('project', projectPath)
  ])
  const models = [...options.models()]
  const efforts: Record<string, string[]> = {}
  for (const model of models) {
    const offered = options.efforts(model.id)
    if (offered) efforts[model.id] = [...offered]
  }
  return { user, ...(project ? { project } : {}), models, efforts }
}

export function registerOrchestrationSettingsIpc(ipc: IpcRegistrar, options: OrchestrationSettingsIpcOptions): void {
  ipc.handle(ORCHESTRATION_SETTINGS_CHANNELS.state, (_event, projectPath) =>
    settingsState(options, projectPathOf(projectPath))
  )
  ipc.handle(ORCHESTRATION_SETTINGS_CHANNELS.save, async (_event, request) => {
    if (!isRecord(request)) throw new Error('The save request must be an object.')
    const { scope, file } = request
    if (scope !== 'user' && scope !== 'project') throw new Error('Unknown orchestration configuration scope.')
    if (!isRecord(file)) throw new Error('The orchestration configuration must be an object.')
    const projectPath = projectPathOf(request.projectPath)
    await options.store.write(scope, projectPath, file)
    return settingsState(options, projectPath)
  })
}
