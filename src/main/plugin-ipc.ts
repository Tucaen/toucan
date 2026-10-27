import { PLUGIN_CHANNELS } from '../shared/ipc-channels'
import type { IpcRegistrar } from './ipc-registrar'
import { isString } from './ipc-validation'
import type { PluginRegistry } from './plugin-registry'

/** The argument as text, or a refusal thrown before anything reaches the registry. */
function textOrThrow(value: unknown, what: string): string {
  if (!isString(value)) throw new Error(`${what} must be text.`)
  return value
}

/**
 * The plugins dialog's side of main (#55): list, add, remove, enable and disable per project, and a
 * plugin's contributions. What a plugin is and who may use it is the registry's; this narrows what
 * crosses the boundary, and turns a worktree into its project before enablement is read or stored,
 * because sessions look plugins up by their main checkout (`projectPathFor`, as the session manager's).
 */
export function registerPluginIpc(
  ipc: IpcRegistrar,
  registry: Pick<PluginRegistry, 'list' | 'add' | 'remove' | 'enable' | 'disable' | 'contributions'>,
  projectPathFor: (path: string) => Promise<string | undefined> = () => Promise.resolve(undefined)
): void {
  const project = async (value: unknown): Promise<string> => {
    const path = textOrThrow(value, 'A project path')
    return (await projectPathFor(path).catch(() => undefined)) ?? path
  }
  ipc.handle(PLUGIN_CHANNELS.list, async (_event, projectPath) =>
    registry.list(projectPath === undefined ? undefined : await project(projectPath))
  )
  ipc.handle(PLUGIN_CHANNELS.add, (_event, path) => registry.add(textOrThrow(path, 'A plugin folder')))
  ipc.handle(PLUGIN_CHANNELS.remove, (_event, id) => registry.remove(textOrThrow(id, 'A plugin id')))
  ipc.handle(PLUGIN_CHANNELS.enable, async (_event, projectPath, id) =>
    registry.enable(await project(projectPath), textOrThrow(id, 'A plugin id'))
  )
  ipc.handle(PLUGIN_CHANNELS.disable, async (_event, projectPath, id) =>
    registry.disable(await project(projectPath), textOrThrow(id, 'A plugin id'))
  )
  ipc.handle(PLUGIN_CHANNELS.contributions, (_event, id) => registry.contributions(textOrThrow(id, 'A plugin id')))
}
